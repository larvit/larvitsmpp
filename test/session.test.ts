import assert from 'node:assert/strict';
import net from 'node:net';
import test, { describe } from 'node:test';
import type { Dlr } from '../src/dlr.ts';
import type { PduObject, PduObjectInput } from '../src/pdu.ts';
import type { Sms } from '../src/sms.ts';
import type { ServerOptions, SmppServer } from '../src/server.ts';
import type { SmppLog } from '../src/log.ts';
import type { TestContext } from 'node:test';
import type { VoidResult } from '../src/result.ts';
import { DlrMerger } from '../src/dlr-merger.ts';
import { PduFramer } from '../src/pdu-framer.ts';
import { ReconnectLoop } from '../src/reconnect-loop.ts';
import { Session, bindCommands } from '../src/session.ts';
import { client } from '../src/client.ts';
import { closeAfter, closeListenerAfter } from './teardown.ts';
import { consts } from '../src/defs/constants.ts';
import { PduRefusedError } from '../src/pdu-refusal.ts';
import { isCommand, objToPdu, pduReturn, pduToObj } from '../src/pdu.ts';
import { paramText } from '../src/defs/types.ts';
import { server } from '../src/server.ts';
import { bareTlvHeader, pduBytes, shortened, truncatedTlv, withUnknownCmdId } from './raw-pdus.ts';
import { silentLog } from '../src/log.ts';
import { splitMessage } from '../src/message.ts';

async function startServer(
	t: TestContext,
	options: Parameters<typeof server>[0] = {},
): Promise<SmppServer> {
	const { err, server: smpp } = await server({ ...options, port: 0 });

	assert.equal(err, undefined);
	assert.ok(smpp);
	closeAfter(t, smpp);

	return smpp;
}

async function connect(
	t: TestContext,
	smpp: SmppServer,
	options: Parameters<typeof client>[0] = {},
) {
	const connected = await client({ port: smpp.port, ...options });

	if (connected.session) closeAfter(t, connected.session);

	return connected;
}

function once<T>(register: (resolve: (value: T) => void) => void): Promise<T> {
	return new Promise<T>(resolve => { register(resolve); });
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => { setTimeout(resolve, ms); });
}

/** Polls until the condition holds; false means it never did within the budget. */
async function waitFor(condition: () => boolean, budget = 2000): Promise<boolean> {
	const deadline = Date.now() + budget;

	while (!condition()) {
		if (Date.now() > deadline) return false;

		await delay(5);
	}

	return true;
}

function raceWithin<T>(ms: number, promise: Promise<T>): Promise<T | false> {
	return Promise.race([promise, delay(ms).then((): false => false)]);
}

/** A socket read as a queue of parsed PDUs; `handled` takes the ones the peer answers itself. */
function pduQueue(
	sock: net.Socket,
	handled: (pduObj: PduObject) => boolean = () => false,
): () => Promise<PduObject> {
	const framer = new PduFramer();
	const queue: PduObject[] = [];
	const waiting: ((pduObj: PduObject) => void)[] = [];

	sock.on('data', chunk => {
		framer.push(chunk);

		for (const pdu of framer.next().pdus ?? []) {
			const { pduObj } = pduToObj(pdu);

			if (!pduObj || handled(pduObj)) continue;

			const next = waiting.shift();

			if (next) next(pduObj);
			else queue.push(pduObj);
		}
	});

	return () => {
		const queued = queue.shift();

		return queued ? Promise.resolve(queued) : once<PduObject>(resolve => waiting.push(resolve));
	};
}

type Peer = {
	close: () => Promise<void>;
	/** The next PDU the ESME sent that the peer did not answer itself. */
	next: () => Promise<PduObject>;
	port: number;
	/** Raw octets, so a test can say what objToPdu would not build. */
	writeRaw: (bytes: Buffer) => void;
};

/** An SMSC answering binds and nothing else, which is what the tests write the other answers for. */
async function smscPeer(t: TestContext, options: { dropOn?: string } = {}): Promise<Peer> {
	const sockets: net.Socket[] = [];
	let queued: (() => Promise<PduObject>) | undefined;
	const listener = net.createServer(sock => {
		sockets.push(sock);
		queued = pduQueue(sock, pduObj => {
			if (pduObj.cmdName === options.dropOn) {
				sock.destroy();

				return true;
			}

			if (!bindCommands.includes(pduObj.cmdName)) return false;

			const { buffer } = pduReturn(pduObj, 'ESME_ROK', { system_id: 'silent' });

			if (buffer) sock.write(buffer);

			return true;
		});
	});

	await new Promise<void>(resolve => { listener.listen(0, resolve); });

	const address = listener.address();
	const peer = {
		close: async () => {
			for (const sock of sockets) {
				sock.destroy();
			}

			await new Promise<void>(resolve => { listener.close(() => { resolve(); }); });
		},
		next: () => {
			assert.ok(queued, 'nothing has connected to the peer yet');

			return queued();
		},
		port: typeof address === 'object' && address !== null ? address.port : 0,
		writeRaw: (bytes: Buffer) => { sockets[sockets.length - 1]?.write(bytes); },
	};

	t.after(() => peer.close());

	return peer;
}

function enquireLink(seqNr: number): PduObject {
	return {
		cmdId: 0x00000015,
		cmdLength: 16,
		cmdName: 'enquire_link',
		cmdStatus: 'ESME_ROK',
		cmdStatusId: 0,
		params: {},
		seqNr,
		shortMessageOctets: undefined,
		tlvs: {},
	};
}

type RawPeer = {
	close: () => void;
	/** The next PDU the server sends, queued so none is missed between reads. */
	next: () => Promise<PduObject>;
	write: (input: PduObjectInput) => void;
};

/** A peer driven PDU by PDU, which is the only way to say things the client never says. */
function rawPeer(t: TestContext, port: number): RawPeer {
	const sock = net.connect({ port });
	const next = pduQueue(sock);

	t.after(() => { sock.destroy(); });

	return {
		close: () => { sock.destroy(); },
		next,
		write: input => {
			const { buffer } = objToPdu(input);

			assert.ok(buffer);
			sock.write(buffer);
		},
	};
}

function bindOf(interfaceVersion: number, seqNr = 1): PduObjectInput {
	return {
		cmdName: 'bind_transceiver',
		params: { interface_version: interfaceVersion, password: 'pass', system_id: 'user' },
		seqNr,
	};
}

async function bindRaw(t: TestContext, smpp: SmppServer, interfaceVersion: number): Promise<PduObject> {
	const peer = rawPeer(t, smpp.port);

	peer.write(bindOf(interfaceVersion));

	const response = await peer.next();

	peer.close();

	return response;
}

describe('bind', () => {
	test('binds and unbinds against a server with no auth', async t => {
		const smpp = await startServer(t);
		const { err, session } = await connect(t, smpp);

		assert.equal(err, undefined);
		assert.ok(session);
		assert.ok(session.loggedIn);

		assert.deepEqual(await session.unbind(), {});
	});

	// Plenty of SMSCs drop the connection on unbind instead of answering it.
	test('takes a close that follows our unbind as a clean unbind', async t => {
		const peer = await smscPeer(t, { dropOn: 'unbind' });
		const { session } = await client({ port: peer.port, responseTimeout: 2000 });

		assert.ok(session);
		closeAfter(t, session);
		assert.deepEqual(await session.unbind(), {});
	});

	test('still reports a close that lands on another in-flight request', async t => {
		const peer = await smscPeer(t, { dropOn: 'enquire_link' });
		const { session } = await client({ port: peer.port, responseTimeout: 2000 });

		assert.ok(session);
		closeAfter(t, session);

		const sent = await session.send({ cmdName: 'enquire_link' });

		assert.ok(sent.err instanceof Error);
		assert.match(sent.err.message, /may have accepted.*Session closed before a response arrived/);
	});

	test('reports an unbind the peer left unanswered on a link that stays up', async t => {
		const peer = await smscPeer(t);
		const { session } = await client({ port: peer.port, responseTimeout: 150 });

		assert.ok(session);
		closeAfter(t, session);
		assert.ok((await session.unbind()).err instanceof Error);
	});

	test('reports the resolved port when 0 was requested', async t => {
		const smpp = await startServer(t);

		assert.ok(smpp.port > 0);
	});

	test('refuses the wrong credentials', async t => {
		const smpp = await startServer(t, {
			authenticate: ({ password, systemId }) => systemId === 'foo' && password === 'bar',
		});
		const { err, session } = await connect(t, smpp);

		assert.ok(err instanceof Error);
		assert.equal(session, undefined);
	});

	test('accepts the right credentials and attaches userData', async t => {
		const smpp = await startServer(t, {
			authenticate: ({ password, systemId }) => systemId === 'foo' && password === 'bar'
				? { userData: { userId: 123 } }
				: false,
		});
		const serverSession = once<Session>(resolve => smpp.on('session', resolve));
		const { err, session } = await connect(t, smpp, { password: 'bar', username: 'foo' });

		assert.equal(err, undefined);
		assert.ok(session);

		const bound = await serverSession;

		assert.deepEqual(bound.userData, { userId: 123 });
	});

	test('answers a non-bind command from an unbound peer with ESME_RINVBNDSTS', async t => {
		const smpp = await startServer(t);
		const responded = once<string>(resolve => {
			const sock = net.connect({ port: smpp.port }, () => {
				// enquire_link before binding
				sock.write(Buffer.from('00000010000000150000000000000001', 'hex'));
			});

			sock.on('data', data => {
				sock.destroy();
				resolve(data.toString('hex'));
			});
		});

		// 0x00000004 is ESME_RINVBNDSTS
		assert.equal(await responded, '00000010800000150000000400000001');
	});

	test('answers the enquire_link a bound peer sends', async t => {
		const smpp = await startServer(t);
		const peer = rawPeer(t, smpp.port);

		peer.write(bindOf(0x34));
		await peer.next();
		peer.write({ cmdName: 'enquire_link', seqNr: 2 });

		const answered = await peer.next();

		assert.equal(answered.cmdName, 'enquire_link_resp');
		assert.equal(answered.cmdStatus, 'ESME_ROK');
		assert.equal(answered.seqNr, 2);
	});

	test('declares SMPP 3.4 by default and the version the caller asks for', async t => {
		const smpp = await startServer(t);
		const declared: (number | undefined)[] = [];

		smpp.on('session', session => {
			session.on('incomingPduObj', pduObj => {
				if (isCommand(pduObj, 'bind_transceiver')) {
					declared.push(pduObj.params.interface_version);
				}
			});
		});

		const { session: byDefault } = await connect(t, smpp);
		const { session: asFive } = await connect(t, smpp, { interfaceVersion: 0x50 });

		assert.ok(byDefault);
		assert.ok(asFive);
		assert.deepEqual(declared, [0x34, 0x50]);
	});

	test('tells a 3.4 peer the version it supports in the bind response', async t => {
		const smpp = await startServer(t);
		const asThreeFour = await bindRaw(t, smpp, 0x34);
		const asFive = await bindRaw(t, smpp, 0x50);

		assert.equal(asThreeFour.cmdName, 'bind_transceiver_resp');
		assert.equal(asThreeFour.cmdStatus, 'ESME_ROK');
		assert.deepEqual(asThreeFour.tlvs.sc_interface_version, {
			tagId: 0x0210,
			tagName: 'sc_interface_version',
			tagValue: 0x34,
		});
		assert.equal(asFive.tlvs.sc_interface_version?.tagValue, 0x34);
	});

	test('advertises the version the server is configured with', async t => {
		const smpp = await startServer(t, { interfaceVersion: 0x50 });
		const asThreeFour = await bindRaw(t, smpp, 0x34);

		assert.equal(asThreeFour.tlvs.sc_interface_version?.tagValue, 0x50);

		// The threshold for sending optional parameters is 3.4 whatever the server advertises.
		const asThreeThree = await bindRaw(t, smpp, 0x33);

		assert.deepEqual(asThreeThree.tlvs, {});
	});

	test('answers a bind with its own system_id, not the one the ESME sent', async t => {
		const anonymous = await startServer(t);
		const named = await startServer(t, { systemId: 'the-smsc' });

		assert.equal((await bindRaw(t, anonymous, 0x34)).params.system_id, '');
		assert.equal((await bindRaw(t, named, 0x34)).params.system_id, 'the-smsc');
	});

	// The echo leak cannot reach a refusal at all: the spec gives a failure response no body.
	test('answers a refused bind with no body to leak', async t => {
		const smpp = await startServer(t, { authenticate: () => false, systemId: 'the-smsc' });
		const refused = await bindRaw(t, smpp, 0x34);

		assert.equal(refused.cmdStatus, 'ESME_RBINDFAIL');
		assert.equal(refused.cmdLength, 16);
		assert.deepEqual(refused.params, {});
	});

	test('sends no optional parameters to a peer declaring less than 3.4', async t => {
		const smpp = await startServer(t);
		const bound = await bindRaw(t, smpp, 0x00);

		assert.equal(bound.cmdStatus, 'ESME_ROK');
		assert.deepEqual(bound.tlvs, {});
	});

	test('answers a second bind with ESME_RALYBND and no body', async t => {
		const smpp = await startServer(t, { systemId: 'the-smsc' });
		const peer = rawPeer(t, smpp.port);

		peer.write(bindOf(0x34));
		await peer.next();
		peer.write(bindOf(0x34, 2));

		const again = await peer.next();

		assert.equal(again.cmdStatus, 'ESME_RALYBND');
		assert.deepEqual(again.params, {});
	});

	test('records the version the SMSC declared in its bind response', async t => {
		const smpp = await startServer(t, { interfaceVersion: 0x50 });

		const { session } = await connect(t, smpp);

		assert.ok(session);
		assert.equal(session.peerInterfaceVersion, 0x50);
		assert.ok(session.acceptsOptionalParams());
	});

	// The spec: an absent sc_interface_version means the SMSC supports no optional parameters.
	test('takes an SMSC that declares no version as older than 3.4', async t => {
		const peer = await smscPeer(t);
		const { session } = await client({ port: peer.port });

		assert.ok(session);
		closeAfter(t, session);
		assert.equal(session.peerInterfaceVersion, 0x00);
		assert.equal(session.acceptsOptionalParams(), false);
	});
});

describe('bind direction', () => {
	// A receiver-bound ESME sends no submit_sm and a transmitter-bound one is sent no deliver_sm.
	test('refuses a submit_sm from a peer that bound as a receiver', async t => {
		const smpp = await startServer(t);
		const { session } = await connect(t, smpp, { bindType: 'receiver' });

		assert.ok(session);

		const sent = await session.send({
			cmdName: 'submit_sm',
			params: { destination_addr: '46709771337', short_message: 'nope', source_addr: '46701113311' },
		});

		assert.ok(sent.pduObj);
		assert.equal(sent.pduObj.cmdStatus, 'ESME_RINVBNDSTS');
	});

	test('refuses sendSms() on a receiver-bound session before it reaches the wire', async t => {
		const smpp = await startServer(t);
		const arrived: Sms[] = [];

		smpp.on('session', peer => peer.on('sms', sms => arrived.push(sms)));

		const { session } = await connect(t, smpp, { bindType: 'receiver' });

		assert.ok(session);

		const sent = await session.sendSms({ from: '46701113311', message: 'nope', to: '46709771337' });

		assert.ok(sent.err instanceof Error);
		assert.match(sent.err.message, /receiver-bound/);
		assert.deepEqual(sent.smsIds, []);
		assert.equal(arrived.length, 0);
	});

	test('refuses a deliver_sm sent to a peer that bound as a transmitter', async t => {
		const smpp = await startServer(t);
		const bound = once<Session>(resolve => { smpp.on('session', resolve); });
		const { session } = await connect(t, smpp, { bindType: 'transmitter' });

		assert.ok(session);

		const peer = await bound;
		const sent = await peer.send({
			cmdName: 'deliver_sm',
			params: { destination_addr: '46709771337', short_message: 'nope', source_addr: '46701113311' },
		});

		assert.ok(sent.pduObj);
		assert.equal(sent.pduObj.cmdStatus, 'ESME_RINVBNDSTS');
	});

	test('refuses sendDlr() to a transmitter-bound peer before it reaches the wire', async t => {
		const smpp = await startServer(t);
		const incoming = once<Sms>(resolve => {
			smpp.on('session', peer => peer.on('sms', resolve));
		});
		const { session } = await connect(t, smpp, { bindType: 'transmitter' });

		assert.ok(session);

		const [sms] = await Promise.all([
			incoming.then(async received => {
				await received.sendResp();

				return received;
			}),
			session.sendSms({ dlr: true, from: '46701113311', message: 'one way', to: '46709771337' }),
		]);
		const report = await sms.sendDlr();

		assert.ok(report.err instanceof Error);
		assert.match(report.err.message, /transmitter-bound/);
	});

	// data_sm carries a message either way, so which end this is decides which way it may travel.
	test('refuses a data_sm sent to a peer that bound as a transmitter', async t => {
		const smpp = await startServer(t);
		const bound = once<Session>(resolve => { smpp.on('session', resolve); });
		const { session } = await connect(t, smpp, { bindType: 'transmitter' });

		assert.ok(session);

		const peer = await bound;
		const sent = await peer.send({
			cmdName: 'data_sm',
			params: { destination_addr: '46709771337', source_addr: '46701113311' },
			tlvs: { message_payload: { tagValue: Buffer.from('nope') } },
		});

		assert.ok(sent.pduObj);
		assert.equal(sent.pduObj.cmdName, 'data_sm_resp');
		assert.equal(sent.pduObj.cmdStatus, 'ESME_RINVBNDSTS');
	});

	test('refuses a data_sm from a receiver-bound peer, and carries one from a transmitter', async t => {
		const smpp = await startServer(t);

		smpp.on('session', peer => peer.on('sms', sms => void sms.sendResp()));

		const receiving = await connect(t, smpp, { bindType: 'receiver' });

		assert.ok(receiving.session);

		const refused = await receiving.session.send({
			cmdName: 'data_sm',
			params: { destination_addr: '46709771337', source_addr: '46701113311' },
			tlvs: { message_payload: { tagValue: Buffer.from('nope') } },
		});

		assert.ok(refused.pduObj);
		assert.equal(refused.pduObj.cmdStatus, 'ESME_RINVBNDSTS');

		const sending = await connect(t, smpp, { bindType: 'transmitter' });

		assert.ok(sending.session);

		const carried = await sending.session.send({
			cmdName: 'data_sm',
			params: { destination_addr: '46709771337', source_addr: '46701113311' },
			tlvs: { message_payload: { tagValue: Buffer.from('a submission the bind carries') } },
		});

		assert.ok(carried.pduObj);
		assert.equal(carried.pduObj.cmdStatus, 'ESME_ROK');
	});
});

describe('sending', () => {
	test('delivers a simple SMS with the sender TON derived from the address', async t => {
		const smpp = await startServer(t);
		const incoming = once<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});
		const { session } = await connect(t, smpp);

		assert.ok(session);

		const [sms, sent] = await Promise.all([
			incoming.then(async received => {
				const refused = await received.sendResp({ smsId: '' });

				assert.ok(refused.err instanceof Error);
				await received.sendResp({ smsId: 'fixed-id' });

				return received;
			}),
			session.sendSms({ from: 'MyBrand', message: 'hello world', to: '46709771337' }),
		]);

		assert.equal(sms.from, 'MyBrand');
		assert.equal(sms.to, '46709771337');
		assert.equal(sms.message, 'hello world');
		assert.equal(sms.dlr, false);
		assert.equal(sms.smsId, 'fixed-id');
		assert.equal(sent.err, undefined);
		assert.deepEqual(sent.smsIds, ['fixed-id']);

		// 0.4.0 sent TON 1 for every sender, including alphanumeric ones, which require TON 5.
		const submitted = sms.pduObjs[0];

		assert.ok(submitted);
		assert.equal(submitted.params.source_addr_ton, 5);
		assert.equal(submitted.params.dest_addr_ton, 1);
	});

	test('reassembles a long SMS and answers every segment', async t => {
		const smpp = await startServer(t);
		const message = 'Lorem ipsum dolor sit amet, '.repeat(20);
		const incoming = once<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});
		const { session } = await connect(t, smpp);

		assert.ok(session);

		const [sms, sent] = await Promise.all([
			incoming.then(async received => {
				await received.sendResp();

				return received;
			}),
			session.sendSms({ from: '46701113311', message, to: '46709771337' }),
		]);

		assert.equal(sms.message, message);
		assert.ok(sms.pduObjs.length > 1);
		assert.equal(sent.err, undefined);
		assert.equal(sent.pduObjs.length, 4);
		assert.deepEqual(sent.smsIds, [1, 2, 3, 4].map(part => `${sms.smsId}-${String(part)}`));
	});

	test('carries a UCS2 message through unchanged', async t => {
		const smpp = await startServer(t);
		const message = 'räksmörgås تست 一';
		const incoming = once<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});
		const { session } = await connect(t, smpp);

		assert.ok(session);

		const [sms] = await Promise.all([
			incoming.then(async received => {
				await received.sendResp();

				return received;
			}),
			session.sendSms({ from: '46701113311', message, to: '46709771337' }),
		]);

		assert.equal(sms.message, message);
		assert.match(sms.smsId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	});

	test('marks a flash message without losing the UCS2 alphabet', async t => {
		const smpp = await startServer(t);
		const incoming = once<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});
		const { session } = await connect(t, smpp);

		assert.ok(session);

		const [sms] = await Promise.all([
			incoming.then(async received => {
				await received.sendResp();

				return received;
			}),
			session.sendSms({ flash: true, from: '46701113311', message: 'تست', to: '46709771337' }),
		]);

		// 0.4.0 forced data_coding to 0x10, which discards UCS2 and mangles the message.
		assert.equal(sms.pduObjs[0]?.params.data_coding, 0x18);
		assert.equal(sms.message, 'تست');
		assert.ok(sms.flash);
	});

	test('puts the address TON and NPI the caller chose on the wire', async t => {
		const smpp = await startServer(t);
		const incoming = once<Sms>(resolve => {
			smpp.on('session', peer => peer.on('sms', resolve));
		});
		const { session } = await connect(t, smpp);

		assert.ok(session);

		const [sms] = await Promise.all([
			incoming.then(async received => {
				await received.sendResp();

				return received;
			}),
			session.sendSms({
				destinationAddrNpi: consts.NPI.ISDN,
				destinationAddrTon: consts.TON.NATIONAL,
				from: '46701113311',
				message: 'addressed by hand',
				sourceAddrNpi: consts.NPI.PRIVATE,
				sourceAddrTon: consts.TON.ABBREVIATED,
				to: '46709771337',
			}),
		]);

		const params = sms.pduObjs[0]?.params;

		assert.ok(params);
		assert.equal(params.dest_addr_npi, consts.NPI.ISDN);
		assert.equal(params.dest_addr_ton, consts.TON.NATIONAL);
		assert.equal(params.source_addr_npi, consts.NPI.PRIVATE);
		assert.equal(params.source_addr_ton, consts.TON.ABBREVIATED);
	});
});

describe('receiving', () => {
	async function inbound(
		t: TestContext,
		options: ServerOptions = {},
	): Promise<{ peer: Session; session: Session }> {
		const smpp = await startServer(t, options);

		const bound = once<Session>(resolve => { smpp.on('session', resolve); });
		const { session } = await connect(t, smpp);

		assert.ok(session);

		return { peer: await bound, session };
	}

	test('hands a client a deliver_sm that is not a delivery receipt', async t => {
		const { peer, session } = await inbound(t);
		const incoming = once<Sms>(resolve => { session.on('sms', resolve); });
		const delivered = peer.send({
			cmdName: 'deliver_sm',
			params: {
				destination_addr: '46709771337',
				short_message: 'inbound hello',
				source_addr: '46701113311',
			},
		});
		const sms = await raceWithin(2000, incoming);

		assert.ok(sms, 'a deliver_sm that carries no receipt is an inbound SMS');
		assert.equal(sms.from, '46701113311');
		assert.equal(sms.to, '46709771337');
		assert.equal(sms.message, 'inbound hello');

		await sms.sendResp({ smsId: 'inbound-id' });

		const answered = await delivered;

		assert.ok(answered.pduObj);
		assert.equal(answered.pduObj.cmdName, 'deliver_sm_resp');
		assert.equal(
			paramText(answered.pduObj.params.message_id),
			'',
			'SMPP 3.4 4.6.2 leaves deliver_sm_resp\'s message_id unused',
		);
		assert.equal(sms.smsId, 'inbound-id', 'the id the application chose is still its own handle');
	});

	// SMPP 3.4 5.3.2.32: up to 64 KB of body in a TLV, with sm_length 0 and short_message empty.
	test('reads an inbound message the peer carried in message_payload', async t => {
		const { peer, session } = await inbound(t);
		const incoming = once<Sms>(resolve => { session.on('sms', resolve); });
		const text = 'the whole body, carried in the TLV';
		const delivered = peer.send({
			cmdName: 'deliver_sm',
			params: {
				destination_addr: '46709771337',
				short_message: Buffer.alloc(0),
				source_addr: '46701113311',
			},
			tlvs: { message_payload: { tagValue: Buffer.from(text, 'latin1') } },
		});
		const sms = await raceWithin(2000, incoming);

		assert.ok(sms, 'a body the peer put in message_payload is still a message');
		assert.equal(sms.message, text);
		assert.equal(sms.from, '46701113311');
		assert.equal(sms.to, '46709771337');

		await sms.sendResp();

		const answered = await delivered;

		assert.ok(answered.pduObj);
		assert.equal(answered.pduObj.cmdStatus, 'ESME_ROK');
	});

	test('hands a client a data_sm carrying a message as an sms, answered data_sm_resp', async t => {
		const { peer, session } = await inbound(t);
		const incoming = once<Sms>(resolve => { session.on('sms', resolve); });
		const smsId = '0199e0f1-6c31-7a44-9d02-4b7e51c3a806';
		const delivered = peer.send({
			cmdName: 'data_sm',
			params: { destination_addr: '46709771337', source_addr: '46701113311' },
			tlvs: { message_payload: { tagValue: Buffer.from('a message carried on the data command', 'latin1') } },
		});
		const sms = await raceWithin(2000, incoming);

		assert.ok(sms, 'data_sm is a peer of deliver_sm, not a command to refuse');
		assert.equal(sms.message, 'a message carried on the data command');
		assert.equal(sms.from, '46701113311');

		await sms.sendResp({ smsId });

		const answered = await delivered;

		assert.ok(answered.pduObj);
		assert.equal(answered.pduObj.cmdName, 'data_sm_resp');
		assert.equal(answered.pduObj.cmdStatus, 'ESME_ROK');
		// SMPP 3.4 4.7.2 gives data_sm_resp a message_id, where 4.6.2 leaves deliver_sm_resp's unused.
		assert.equal(paramText(answered.pduObj.params.message_id), smsId);
	});

	test('hands a client a receipt carried on data_sm as a dlr', async t => {
		const { peer, session } = await inbound(t);
		const reported = once<Dlr>(resolve => { session.on('dlr', resolve); });
		const smsId = '0199e0f1-b8a2-7f19-8c63-2d5041fb9e77';
		let messages = 0;

		session.on('sms', () => { messages++; });

		const delivered = peer.send({
			cmdName: 'data_sm',
			params: {
				destination_addr: '46709771337',
				esm_class: consts.ESM_CLASS.MC_DELIVERY_RECEIPT,
				source_addr: '46701113311',
			},
			tlvs: {
				message_payload: {
					tagValue: Buffer.from(`id:${smsId} sub:001 dlvrd:001 stat:DELIVRD err:000 text:`, 'latin1'),
				},
			},
		});
		const dlr = await raceWithin(2000, reported);

		assert.ok(dlr, 'a receipt thrown as data_sm is still a receipt');
		assert.equal(dlr.smsId, smsId);
		assert.equal(dlr.statusMsg, 'DELIVERED');
		assert.equal(messages, 0);

		const answered = await delivered;

		assert.ok(answered.pduObj);
		assert.equal(answered.pduObj.cmdName, 'data_sm_resp');
		assert.equal(answered.pduObj.cmdStatus, 'ESME_ROK');
	});

	// At the SMSC end an inbound data_sm is a submission, so nothing in one reports on our own sends.
	test('reads a receipt-shaped data_sm submitted to a server as the message it is', async t => {
		const smpp = await startServer(t);
		const body = 'id:0199e0f2-2d15-7b83-a4c1-6e90b7d2f345 stat:DELIVRD err:000 text:';
		const messages: Sms[] = [];
		const reports: Dlr[] = [];

		smpp.on('session', peer => {
			peer.on('dlr', dlr => { reports.push(dlr); });
			peer.on('sms', sms => {
				messages.push(sms);
				void sms.sendResp();
			});
		});

		const { session } = await connect(t, smpp, { bindType: 'transmitter' });

		assert.ok(session);

		const submitted = await session.send({
			cmdName: 'data_sm',
			params: {
				destination_addr: '46709771337',
				esm_class: consts.ESM_CLASS.MC_DELIVERY_RECEIPT,
				source_addr: '46701113311',
			},
			tlvs: { message_payload: { tagValue: Buffer.from(body, 'latin1') } },
		});

		assert.ok(submitted.pduObj);
		assert.equal(submitted.pduObj.cmdStatus, 'ESME_ROK');
		assert.notEqual(paramText(submitted.pduObj.params.message_id), '');
		assert.equal(messages[0]?.message, body);
		assert.deepEqual(reports, [], 'an ESME submitting is never the network reporting');
	});

	// The refusal a submission gets is the one submit_sm_resp defines, whichever command carried it.
	test('refuses a data_sm segment a server has no room for with the submit code', async t => {
		// The two addresses are 22 octets, so the 6-octet UDH and its text are what overrun 30.
		const smpp = await startServer(t, { maxOctets: 30 });
		const { session } = await connect(t, smpp, { bindType: 'transmitter' });

		assert.ok(session);

		const segment = splitMessage('one of two, too big to hold. '.repeat(12), { reference: 0x5C })[0];

		assert.ok(segment);

		const refused = await session.send({
			cmdName: 'data_sm',
			params: {
				destination_addr: '46709771337',
				esm_class: consts.ESM_CLASS.UDH_INDICATOR,
				source_addr: '46701113311',
			},
			tlvs: { message_payload: { tagValue: segment } },
		});

		assert.ok(refused.pduObj);
		assert.equal(refused.pduObj.cmdName, 'data_sm_resp');
		assert.equal(refused.pduObj.cmdStatus, 'ESME_RMSGQFUL');
	});

	test('reassembles a concatenated message whose segments arrived in message_payload', async t => {
		const { peer, session } = await inbound(t);
		const incoming = once<Sms>(resolve => { session.on('sms', resolve); });
		const text = 'A body in the TLV is still numbered by its UDH. '.repeat(6);
		const segments = splitMessage(text, { reference: 0x3B });

		assert.ok(segments.length > 1, 'the fixture must need more than one segment');

		const answers: PduObject[] = [];

		for (const segment of segments) {
			const sent = await peer.send({
				cmdName: 'deliver_sm',
				params: {
					destination_addr: '46709771337',
					esm_class: consts.ESM_CLASS.UDH_INDICATOR,
					short_message: Buffer.alloc(0),
					source_addr: '46701113311',
				},
				tlvs: { message_payload: { tagValue: segment } },
			});

			assert.ok(sent.pduObj);
			answers.push(sent.pduObj);
		}

		const sms = await raceWithin(2000, incoming);

		assert.ok(sms, 'the segments join into one message wherever their bodies were carried');
		assert.equal(sms.message, text);
		assert.equal(sms.answeredOnArrival, true);
		assert.deepEqual(answers.map(answer => answer.cmdStatus), answers.map(() => 'ESME_ROK'));
		assert.deepEqual(
			answers.map(answer => paramText(answer.params.message_id)),
			answers.map(() => ''),
			'SMPP 3.4 4.6.2 leaves deliver_sm_resp\'s message_id unused, segment by segment too',
		);
		assert.deepEqual(await sms.sendResp(), {});
	});

	test('hands a client a report as a dlr rather than as an sms', async t => {
		const { peer, session } = await inbound(t);
		const reported = once<Dlr>(resolve => { session.on('dlr', resolve); });
		let messages = 0;

		session.on('sms', () => { messages++; });

		const delivered = peer.send({
			cmdName: 'deliver_sm',
			params: {
				destination_addr: '46709771337',
				esm_class: consts.ESM_CLASS.MC_DELIVERY_RECEIPT,
				short_message: 'a receipt in a format nobody documented',
				source_addr: '46701113311',
			},
		});
		const dlr = await raceWithin(2000, reported);

		assert.ok(dlr, 'esm_class marks it a receipt, so nothing else may claim it');
		assert.equal(dlr.smsId, undefined);
		assert.equal(messages, 0);

		const answered = await delivered;

		assert.ok(answered.pduObj);
		assert.equal(answered.pduObj.cmdName, 'deliver_sm_resp');

		const notified = once<Dlr>(resolve => { session.on('dlr', resolve); });
		const notification = peer.send({
			cmdName: 'deliver_sm',
			params: {
				destination_addr: '46709771337',
				esm_class: consts.ESM_CLASS.INTERMEDIATE_DELIVERY,
				short_message: 'id:0195f0c7 stat:ENROUTE err:000 text:',
				source_addr: '46701113311',
			},
		});
		const report = await raceWithin(2000, notified);

		assert.ok(report, 'an intermediate notification is the MC reporting on our send, not an inbound SMS');
		assert.equal(report.intermediate, true);
		assert.equal(report.statusMsg, 'ENROUTE');
		assert.equal(messages, 0);

		const answeredNotification = await notification;

		assert.ok(answeredNotification.pduObj);
		assert.equal(answeredNotification.pduObj.cmdName, 'deliver_sm_resp');
	});

	// SMPPSim's receipt for a UCS2 message inherits its data_coding and writes the body as text.
	test('parses a receipt written as text under a data_coding that says UCS2', async t => {
		const { peer, session } = await inbound(t);
		const reported = once<{ dlr: Dlr; pduObj: PduObject }>(resolve => {
			session.on('dlr', (dlr, pduObj) => { resolve({ dlr, pduObj }); });
		});
		const smsId = '01a072f9-30f2-71b0-87cd-f5032df3a8e0';
		const body = `id:${smsId} sub:001 dlvrd:001 submit date:2509051430 done date:2509051431 stat:DELIVRD err:000 text:`;
		const delivered = peer.send({
			cmdName: 'deliver_sm',
			params: {
				data_coding: consts.ENCODING.UCS2,
				destination_addr: '46709771337',
				esm_class: consts.ESM_CLASS.MC_DELIVERY_RECEIPT,
				short_message: Buffer.from(body, 'ascii'),
				source_addr: '46701113311',
			},
		});
		const received = await raceWithin(2000, reported);

		assert.ok(received);
		assert.equal(received.dlr.smsId, smsId);
		assert.equal(received.dlr.statusMsg, 'DELIVERED');
		assert.equal(received.dlr.receipt?.doneDate, '2509051431');
		assert.equal(received.pduObj.params.data_coding, consts.ENCODING.UCS2);
		assert.equal(received.pduObj.shortMessageOctets?.toString('latin1'), body);
		assert.ok((await delivered).pduObj);
	});

	test('reassembles a multipart inbound SMS before the sms event', async t => {
		const message = 'Inbound lorem ipsum dolor sit amet consectetur, '.repeat(6);
		const { peer, session } = await inbound(t);
		const incoming = once<Sms>(resolve => { session.on('sms', resolve); });
		const segments = splitMessage(message, { reference: 42 });

		assert.equal(segments.length, 2);

		const delivered = Promise.all(segments.map(segment => peer.send({
			cmdName: 'deliver_sm',
			params: {
				destination_addr: '46709771337',
				esm_class: consts.ESM_CLASS.UDH_INDICATOR,
				short_message: segment,
				source_addr: '46701113311',
			},
		})));
		const sms = await raceWithin(2000, incoming);

		assert.ok(sms, 'both segments should reassemble into one message');
		assert.equal(sms.message, message);
		assert.equal(sms.pduObjs.length, 2);

		assert.deepEqual(await sms.sendResp(), {});

		for (const answered of await delivered) {
			assert.ok(answered.pduObj);
			assert.equal(paramText(answered.pduObj.params.message_id), '');
		}
	});

	/** SMPP 3.4 5.3.2.31-5.3.2.33: concatenation as optional parameters, with no UDH in the body. */
	function sarTlvs(reference: number, part: number, total: number): PduObjectInput['tlvs'] {
		return {
			sar_msg_ref_num: { tagValue: reference },
			sar_segment_seqnum: { tagValue: part },
			sar_total_segments: { tagValue: total },
		};
	}

	test('answers every sar_* segment on arrival and hands the application one message', async t => {
		const smpp = await startServer(t);
		const incoming = once<Sms>(resolve => { smpp.on('session', peer => peer.on('sms', resolve)); });
		const { session } = await connect(t, smpp, { bindType: 'transmitter', responseTimeout: 1000 });

		assert.ok(session);

		const parts = ['sar one, ', 'sar two, ', 'sar three'];
		const answers: PduObject[] = [];

		// A 16-bit reference no 8-bit UDH could carry, which is the width the TLV exists for.
		for (const [index, part] of parts.entries()) {
			const sent = await session.send({
				cmdName: 'submit_sm',
				params: {
					destination_addr: '46709771337',
					short_message: part,
					source_addr: '46701113311',
				},
				tlvs: sarTlvs(0x02b7, index + 1, parts.length),
			});

			assert.ok(sent.pduObj);
			answers.push(sent.pduObj);
		}

		const sms = await raceWithin(2000, incoming);

		assert.ok(sms, 'the sar_* TLVs tie the three submissions into one message');
		assert.equal(sms.message, parts.join(''));
		assert.equal(sms.answeredOnArrival, true);
		assert.deepEqual(
			answers.map(answer => paramText(answer.params.message_id)),
			[1, 2, 3].map(part => `${sms.smsId}-${String(part)}`),
		);
	});

	test('joins sar_* segments in the order they number themselves', async t => {
		const { peer, session } = await inbound(t, { responseTimeout: 1000 });
		const incoming = once<Sms>(resolve => { session.on('sms', resolve); });
		const parts = ['first ', 'second ', 'third'];

		for (const index of [2, 0, 1]) {
			const sent = await peer.send({
				cmdName: 'deliver_sm',
				params: {
					destination_addr: '46709771337',
					short_message: parts[index],
					source_addr: '46701113311',
				},
				tlvs: sarTlvs(0x11, index + 1, parts.length),
			});

			assert.ok(sent.pduObj);
			assert.equal(sent.pduObj.cmdStatus, 'ESME_ROK');
		}

		const sms = await raceWithin(2000, incoming);

		assert.ok(sms, 'the segments number themselves, so the order they arrive in is not the message');
		assert.equal(sms.message, parts.join(''));
	});

	test('reassembles a sar_* segment whose body is in message_payload', async t => {
		const { peer, session } = await inbound(t, { responseTimeout: 1000 });
		const incoming = once<Sms>(resolve => { session.on('sms', resolve); });
		const parts = ['in the mandatory field, ', 'and in the TLV'];

		for (const [index, part] of parts.entries()) {
			// The combination that needs no UDH at all: the numbering and the body are both optional
			// parameters, so the second segment's short_message is empty.
			const carried = index === 0
				? { params: { short_message: part }, tlvs: {} }
				: {
					params: { short_message: Buffer.alloc(0) },
					tlvs: { message_payload: { tagValue: Buffer.from(part, 'ascii') } },
				};
			const sent = await peer.send({
				cmdName: 'deliver_sm',
				params: {
					destination_addr: '46709771337',
					source_addr: '46701113311',
					...carried.params,
				},
				tlvs: { ...sarTlvs(0x12, index + 1, parts.length), ...carried.tlvs },
			});

			assert.ok(sent.pduObj);
			assert.equal(sent.pduObj.cmdStatus, 'ESME_ROK');
		}

		const sms = await raceWithin(2000, incoming);

		assert.ok(sms, 'a segment carries its body where any other message may carry one');
		assert.equal(sms.message, parts.join(''));
		assert.equal(sms.answeredOnArrival, true);
	});

	// The UDH reference is 8 bits and sar_msg_ref_num is 16, so the same number is two messages.
	test('keeps a UDH group and a sar_* group sharing a reference apart', async t => {
		const { peer, session } = await inbound(t, { responseTimeout: 1000 });
		const messages: Sms[] = [];

		session.on('sms', sms => { messages.push(sms); });

		const udhText = 'the message numbered by its user data header. '.repeat(5);
		const udhSegments = splitMessage(udhText, { reference: 5 });
		const sarParts = ['the message numbered by ', 'its optional parameters'];

		assert.equal(udhSegments.length, 2);

		const sends: PduObjectInput[] = [];

		for (const [index, segment] of udhSegments.entries()) {
			sends.push({
				cmdName: 'deliver_sm',
				params: {
					destination_addr: '46709771337',
					esm_class: consts.ESM_CLASS.UDH_INDICATOR,
					short_message: segment,
					source_addr: '46701113311',
				},
			});
			sends.push({
				cmdName: 'deliver_sm',
				params: {
					destination_addr: '46709771337',
					short_message: sarParts[index],
					source_addr: '46701113311',
				},
				tlvs: sarTlvs(5, index + 1, sarParts.length),
			});
		}

		for (const input of sends) {
			const sent = await peer.send(input);

			assert.ok(sent.pduObj);
			assert.equal(sent.pduObj.cmdStatus, 'ESME_ROK');
		}

		assert.ok(await waitFor(() => messages.length === 2));
		assert.deepEqual(messages.map(sms => sms.message).sort(), [sarParts.join(''), udhText].sort());
		assert.notEqual(messages[0]?.smsId, messages[1]?.smsId);
	});

	// Nothing compares the two references: each spelling counts in a space of its own.
	test('groups a segment carrying both spellings by its UDH', async t => {
		const { peer, session } = await inbound(t, { responseTimeout: 1000 });
		const incoming = once<Sms>(resolve => { session.on('sms', resolve); });
		const message = 'both spellings on every segment of it, and the UDH decides. '.repeat(4);
		const segments = splitMessage(message, { reference: 7 });

		assert.equal(segments.length, 2);

		for (const [index, segment] of segments.entries()) {
			const sent = await peer.send({
				cmdName: 'deliver_sm',
				params: {
					destination_addr: '46709771337',
					esm_class: consts.ESM_CLASS.UDH_INDICATOR,
					short_message: segment,
					source_addr: '46701113311',
				},
				// Numbering the same segments as a three-part message no third segment ever completes.
				tlvs: sarTlvs(0x0207, index + 1, 3),
			});

			assert.ok(sent.pduObj);
		}

		const sms = await raceWithin(2000, incoming);

		assert.ok(sms, 'the UDH says the message is whole at two segments, and the UDH is what is read');
		assert.equal(sms.message, message);
	});

	test('reads a receipt carrying sar_* fields as a dlr, never as a segment', async t => {
		const { peer, session } = await inbound(t, { responseTimeout: 1000 });
		const reports: Dlr[] = [];
		let messages = 0;

		session.on('dlr', dlr => { reports.push(dlr); });
		session.on('sms', () => { messages++; });

		const marked = '0199e1a4-6c3f-7d21-9a80-5b1e2f7c4d63';
		const unmarked = '0199e1a4-b70e-7c55-8f42-9d3a1c86e70b';
		const body = (smsId: string): string =>
			`id:${smsId} sub:001 dlvrd:001 submit date:2509061200 done date:2509061201 stat:DELIVRD err:000 text:`;
		const receipts: PduObjectInput[] = [
			{
				cmdName: 'deliver_sm',
				params: {
					destination_addr: '46709771337',
					esm_class: consts.ESM_CLASS.MC_DELIVERY_RECEIPT,
					short_message: body(marked),
					source_addr: '46701113311',
				},
				tlvs: sarTlvs(0x21, 1, 2),
			},
			// esm_class marks nothing, so the receipted_message_id TLV is what says it is a report.
			{
				cmdName: 'deliver_sm',
				params: {
					destination_addr: '46709771337',
					short_message: body(unmarked),
					source_addr: '46701113311',
				},
				tlvs: { ...sarTlvs(0x21, 2, 2), receipted_message_id: { tagValue: unmarked } },
			},
		];

		for (const receipt of receipts) {
			const sent = await peer.send(receipt);

			assert.ok(sent.pduObj);
			assert.equal(sent.pduObj.cmdStatus, 'ESME_ROK');
		}

		assert.ok(await waitFor(() => reports.length === 2));
		assert.deepEqual(reports.map(report => report.smsId), [marked, unmarked]);
		assert.equal(messages, 0, 'a report is never a segment, however the peer numbered it');
	});
});

describe('delivery reports', () => {
	test('reaches the sender as a dlr event', async t => {
		const smpp = await startServer(t);
		const incoming = once<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});
		const { session } = await connect(t, smpp);

		assert.ok(session);

		const dlr = once<[Dlr, PduObject]>(resolve => {
			session.on('dlr', (report, pduObj) => { resolve([report, pduObj]); });
		});

		const [sms] = await Promise.all([
			incoming.then(async received => {
				await received.sendResp({ smsId: 'dlr-id' });

				return received;
			}),
			session.sendSms({ dlr: true, from: '46701113311', message: 'hi', to: '46709771337' }),
		]);

		assert.ok(sms.dlr);
		await sms.sendDlr();

		const [report, receipt] = await dlr;

		assert.equal(report.smsId, 'dlr-id');
		assert.equal(report.statusMsg, 'DELIVERED');
		assert.equal(receipt.tlvs.receipted_message_id?.tagValue, 'dlr-id');
		assert.equal(receipt.tlvs.message_state?.tagValue, 2);
	});

	test('reports a failure with the spec status code', async t => {
		const smpp = await startServer(t);
		const incoming = once<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});
		const { session } = await connect(t, smpp);

		assert.ok(session);

		const dlr = once<{ statusMsg: string }>(resolve => { session.on('dlr', resolve); });
		const raw = once<string>(resolve => {
			session.on('incomingPduObj', pduObj => {
				const message = pduObj.params.short_message;

				if (typeof message === 'string') resolve(message);
			});
		});

		const [sms] = await Promise.all([
			incoming.then(async received => {
				await received.sendResp({ smsId: 'fail-id' });

				return received;
			}),
			session.sendSms({ dlr: true, from: '46701113311', message: 'hi', to: '46709771337' }),
		]);

		await sms.sendDlr('UNDELIVERABLE');

		assert.equal((await dlr).statusMsg, 'UNDELIVERABLE');
		// 0.4.0 wrote stat:UNDELIVERABLE, which is not the spec's seven-character field.
		assert.match(await raw, /stat:UNDELIV /);
	});

	test('sends a text-only receipt to a peer that declared less than 3.4', async t => {
		const smpp = await startServer(t);
		const incoming = once<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});
		const peer = rawPeer(t, smpp.port);

		peer.write(bindOf(0x33));
		await peer.next();
		peer.write({
			cmdName: 'submit_sm',
			params: {
				data_coding: 0,
				destination_addr: '46709771337',
				registered_delivery: 1,
				short_message: 'hi',
				sm_length: 2,
				source_addr: '46701113311',
			},
			seqNr: 2,
		});

		const sms = await incoming;

		await sms.sendResp();
		await peer.next();

		// A raw peer answers no deliver_sm, so this only settles once the session closes.
		void sms.sendDlr();

		const receipt = await peer.next();

		assert.equal(receipt.cmdName, 'deliver_sm');
		assert.deepEqual(receipt.tlvs, {});
		assert.match(paramText(receipt.params.short_message), /stat:DELIVRD/);
	});

	test('merges nothing for a message that asked for no receipt', async t => {
		const smpp = await startServer(t);
		const incoming = once<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});
		const { session } = await connect(t, smpp);

		assert.ok(session);

		const perSegment: string[] = [];
		let merged = 0;

		session.on('dlr', dlr => perSegment.push(dlr.smsId ?? ''));
		session.on('messageDlr', () => { merged++; });

		const [sms] = await Promise.all([
			incoming.then(async received => {
				await received.sendResp();

				return received;
			}),
			session.sendSms({ from: '46701113311', message: 'x'.repeat(400), to: '46709771337' }),
		]);

		await sms.sendDlr();

		assert.deepEqual(perSegment, [1, 2, 3].map(part => `${sms.smsId}-${String(part)}`));
		assert.equal(merged, 0);
	});
});

describe('a session captured from Kannel', () => {
	// Four parts of one message, esm_class 0x43 — the UDH indicator combined with store-and-forward,
	// which 0.4.0 originally compared with === 0x40 and missed.
	const parts = [
		'000000de00000004000000000000003000050074657374000201313233343500430000003136303630373136333031333030302b00000000009f0500030204014c6f72656d20497073756d2069732073696d706c792064756d6d792074657874206f6620746865207072696e74696e6720616e64207479706573657474696e6720696e6475737472792e204c6f72656d20497073756d20686173206265656e2074686520696e6475737472792773207374616e646172642064756d6d79207465787420657665722073696e6365207468652031353030732c200426000101',
		'000000de00000004000000000000003100050074657374000201313233343500430000003136303630373136333031333030302b00000000009f0500030204027768656e20616e20756e6b6e6f776e207072696e74657220746f6f6b20612067616c6c6579206f66207479706520616e6420736372616d626c656420697420746f206d616b65206120747970652073706563696d656e20626f6f6b2e20497420686173207375727669766564206e6f74206f6e6c7920666976652063656e7475726965732c2062757420616c736f20746865206c65617020690426000101',
		'000000de00000004000000000000003200050074657374000201313233343500430000003136303630373136333031333030302b00000000009f0500030204036e746f20656c656374726f6e6963207479706573657474696e672c2072656d61696e696e6720657373656e7469616c6c7920756e6368616e6765642e2049742077617320706f70756c61726973656420696e207468652031393630732077697468207468652072656c65617365206f66204c657472617365742073686565747320636f6e7461696e696e67204c6f72656d20497073756d20700426000101',
		'000000b200000004000000000000003300050074657374000201313233343500430000003136303630373136333031333030302b000000000078050003020404617373616765732c20616e64206d6f726520726563656e746c792077697468206465736b746f70207075626c697368696e6720736f667477617265206c696b6520416c64757320506167654d616b657220696e636c7564696e672076657273696f6e73206f66204c6f72656d20497073756d',
	];

	const expected = 'Lorem Ipsum is simply dummy text of the printing and typesetting industry. Lorem Ipsum has been the industry\'s standard dummy text ever since the 1500s, when an unknown printer took a galley of type and scrambled it to make a type specimen book. It has survived not only five centuries, but also the leap into electronic typesetting, remaining essentially unchanged. It was popularised in the 1960s with the release of Letraset sheets containing Lorem Ipsum passages, and more recently with desktop publishing software like Aldus PageMaker including versions of Lorem Ipsum';

	async function replay(t: TestContext, order: number[]): Promise<Sms> {
		const smpp = await startServer(t);
		const incoming = once<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});

		const sock = net.connect({ port: smpp.port }, () => {
			sock.write(Buffer.from('0000002100000009000000000000002f666f6f0062617200736d70700034000000', 'hex'));
		});

		t.after(() => { sock.destroy(); });

		let bound = false;

		sock.on('data', () => {
			if (bound) return;

			bound = true;

			for (const index of order) {
				const part = parts[index];

				if (part !== undefined) sock.write(Buffer.from(part, 'hex'));
			}
		});

		const sms = await incoming;

		await sms.sendResp();

		return sms;
	}

	test('reassembles four segments arriving in order', async t => {
		assert.equal((await replay(t, [0, 1, 2, 3])).message, expected);
	});

	test('reassembles the same four segments arriving out of order', async t => {
		assert.equal((await replay(t, [1, 0, 3, 2])).message, expected);
	});
});

describe('robustness', () => {
	// 0.4.0 registered a listener per sequence number and waited forever, leaking one per call.
	test('gives up on a peer that never answers', async t => {
		const accepted: net.Socket[] = [];
		// resume() so the socket drains; an unread socket never notices the peer hanging up.
		const silent = net.createServer(sock => { accepted.push(sock); sock.resume(); });

		await new Promise<void>(resolve => silent.listen(0, resolve));
		closeListenerAfter(t, silent, accepted);

		const address = silent.address();
		const port = typeof address === 'object' && address !== null ? address.port : 0;
		const started = Date.now();
		const { err } = await client({ port, responseTimeout: 150 });

		assert.ok(err instanceof Error);
		assert.ok(Date.now() - started < 5000, 'should have given up quickly');
	});

	test('stops a connection attempt on an aborted signal', async () => {
		const controller = new AbortController();

		controller.abort();

		const { err } = await client({ port: 1, signal: controller.signal });

		assert.ok(err instanceof Error);
	});

	test('reports a refused connection rather than throwing', async () => {
		const { err, session } = await client({ port: 1 });

		assert.ok(err instanceof Error);
		assert.equal(session, undefined);
	});

	test('keeps at most maxOutstanding requests on the wire', async t => {
		const smpp = await startServer(t);
		let concurrent = 0;
		let peak = 0;

		smpp.on('session', session => {
			session.on('sms', sms => {
				concurrent++;
				peak = Math.max(peak, concurrent);
				setTimeout(() => {
					concurrent--;
					void sms.sendResp();
				}, 10);
			});
		});

		const { session } = await connect(t, smpp, { maxOutstanding: 2 });

		assert.ok(session);

		await Promise.all(Array.from({ length: 8 }, (_, index) => session.sendSms({
			from: '46701113311',
			message: `message ${String(index)}`,
			to: '46709771337',
		})));

		const long = await session.sendSms({
			from: '46701113311',
			message: 'x'.repeat(500),
			to: '46709771337',
		});

		assert.equal(long.err, undefined, 'more segments than slots still completes, a slot at a time');
		assert.equal(long.smsIds.length, 4);
		assert.ok(peak <= 2, `peak was ${String(peak)}`);
	});

	test('reports a response it could not send', async t => {
		const sock = new net.Socket();

		sock.destroy();

		const session = new Session({ sock });

		closeAfter(t, session);

		const failed = once<Error>(resolve => { session.on('sessionError', resolve); });
		const sent = await session.sendReturn(enquireLink(7));
		const reported = await raceWithin(500, failed);

		assert.ok(sent.err instanceof Error);
		assert.ok(reported instanceof Error, 'a response that never reached the wire should be reported');
		assert.equal(reported.message, sent.err.message);
	});

	test('ignores events from the socket it left behind on a reconnect', async t => {
		const smpp = await startServer(t);

		smpp.on('session', bound => {
			bound.on('sms', sms => { void sms.sendResp(); });
		});

		const { session } = await connect(t, smpp, { reconnect: { maxDelay: 50, minDelay: 10 } });

		assert.ok(session);

		const reconnected = once<true>(resolve => { session.on('reconnected', () => { resolve(true); }); });
		const dead = session.sock;

		for (const serverSession of smpp.sessions) {
			await serverSession.close();
		}

		await reconnected;

		let closes = 0;

		session.on('close', () => { closes++; });
		dead.emit('close');

		const sent = await session.sendSms({
			from: '46701113311',
			message: 'still up',
			to: '46709771337',
		});

		assert.equal(closes, 0);
		assert.equal(sent.err, undefined);
	});

	test('closes the session when the signal aborts after the bind', async t => {
		const smpp = await startServer(t);
		const controller = new AbortController();
		const { err, session } = await connect(t, smpp, { signal: controller.signal });

		assert.equal(err, undefined);
		assert.ok(session);

		const closed = once<true>(resolve => { session.on('close', () => { resolve(true); }); });

		controller.abort();

		assert.ok(await closed);
	});

	// An aborted send that still reaches the SMSC bills a message the caller believes never went out.
	test('puts nothing on the wire for a signal that is already aborted', async t => {
		const smpp = await startServer(t);

		const bound = once<Session>(resolve => { smpp.on('session', resolve); });
		const { session } = await connect(t, smpp);

		assert.ok(session);

		const peer = await bound;
		const controller = new AbortController();
		const seen: string[] = [];

		peer.on('incomingPduObj', pduObj => { seen.push(pduObj.cmdName); });
		controller.abort();

		const sent = await session.sendSms({
			from: '46701113311',
			message: 'must never reach the peer',
			to: '46709771337',
		}, { signal: controller.signal });

		assert.ok(sent.err instanceof Error);
		await delay(50);
		assert.deepEqual(seen, []);
	});

	// The guard sits before the send window, or a full window makes the aborted call queue first.
	test('does not wait for a send window slot it will never use', async t => {
		const smpp = await startServer(t);

		// The peer answers nothing, so the one slot stays held for the whole test.
		smpp.on('session', session => session.on('sms', () => undefined));

		const { session } = await connect(t, smpp, { maxOutstanding: 1, responseTimeout: 5000 });

		assert.ok(session);

		void session.sendSms({ from: '46701113311', message: 'holds the slot', to: '46709771337' });

		const controller = new AbortController();

		controller.abort();

		const aborted = await raceWithin(500, session.sendSms({
			from: '46701113311',
			message: 'must not queue behind the held one',
			to: '46709771337',
		}, { signal: controller.signal }));

		assert.notEqual(aborted, false, 'an aborted send should not wait for the window');
		assert.ok(aborted !== false && aborted.err instanceof Error);
	});

	// A socket the loop opened and never handed over is one leaked per retry, forever.
	test('leaves no socket open when coming back up fails', async t => {
		const opened: net.Socket[] = [];

		function onConnected(): Promise<VoidResult> {
			if (opened.length === 1) return Promise.resolve({ err: new Error('bind refused') });

			throw new Error('bind exploded');
		}

		const loop = new ReconnectLoop({
			connect: () => {
				const sock = new net.Socket();

				opened.push(sock);

				return Promise.resolve({ sock });
			},
			log: silentLog,
			maxDelay: 10,
			minDelay: 1,
			onConnected,
		});

		t.after(() => {
			loop.stop();

			for (const sock of opened) {
				sock.destroy();
			}
		});
		loop.schedule();

		const destroyed = await waitFor(() => opened.length >= 2
			&& opened[0]?.destroyed === true
			&& opened[1]?.destroyed === true);

		assert.ok(destroyed, 'a failed setup should leave no socket open');
	});
});

describe('a PDU the codec cannot read', () => {
	const receipt = {
		destination_addr: '46709771337',
		esm_class: consts.ESM_CLASS.MC_DELIVERY_RECEIPT,
		short_message: 'id:0199e0e9-4a3e-7c62-9a4b-1f0c5d7e8a21 stat:DELIVRD err:000 text:',
		source_addr: '46701113311',
	};

	/** The peer's next PDU within a budget: a dropped link must fail the test, not hang it. */
	async function answerTo(peer: Peer): Promise<PduObject> {
		const pduObj = await raceWithin(2000, peer.next());

		assert.ok(pduObj, 'the peer was never answered');

		return pduObj;
	}

	async function bound(t: TestContext, options: Parameters<typeof client>[0] = {}) {
		const peer = await smscPeer(t);
		const { session } = await client({ port: peer.port, ...options });

		assert.ok(session);
		closeAfter(t, session);

		return { peer, session };
	}

	// ukarim/smscsim signs every deliver_sm it sends unprompted with a raw uint32, so about half
	// land above SMPP 3.4 4.7.1's ceiling; refusing them cost the link (findings/01-smscsim.md).
	test('answers a deliver_sm whose sequence number is above the spec range, and keeps the link', async t => {
		const { peer, session } = await bound(t);
		const reported = once<Dlr>(resolve => { session.on('dlr', resolve); });

		peer.writeRaw(pduBytes({ cmdName: 'deliver_sm', params: receipt, seqNr: 0x80000001 }));

		const answered = await answerTo(peer);

		assert.equal(answered.cmdName, 'deliver_sm_resp');
		assert.equal(answered.cmdStatus, 'ESME_ROK');
		assert.equal(answered.seqNr, 0x80000001);

		const dlr = await raceWithin(2000, reported);

		assert.ok(dlr, 'the receipt is a report, not a reason to drop the link');
		assert.equal(dlr.statusMsg, 'DELIVERED');

		peer.writeRaw(pduBytes({ cmdName: 'enquire_link', seqNr: 0xFFFFFFFF }));

		const pinged = await answerTo(peer);

		assert.equal(pinged.cmdName, 'enquire_link_resp');
		assert.equal(pinged.seqNr, 0xFFFFFFFF);
	});

	test('answers an unknown command id with generic_nack ESME_RINVCMDID', async t => {
		const { peer, session } = await bound(t);
		const failed = once<Error>(resolve => { session.on('sessionError', resolve); });

		peer.writeRaw(withUnknownCmdId({ cmdName: 'enquire_link', seqNr: 9 }));

		const answered = await answerTo(peer);

		assert.equal(answered.cmdName, 'generic_nack');
		assert.equal(answered.cmdStatus, 'ESME_RINVCMDID');
		assert.equal(answered.seqNr, 9);
		assert.ok((await raceWithin(2000, failed)) instanceof Error, 'one sessionError per refused PDU');
	});

	test('answers a deliver_sm with a truncated TLV stream with ESME_RINVTLVSTREAM', async t => {
		const { peer, session } = await bound(t);
		let reports = 0;

		session.on('dlr', () => { reports++; });
		peer.writeRaw(truncatedTlv({ cmdName: 'deliver_sm', params: receipt, seqNr: 5 }));

		const answered = await answerTo(peer);

		assert.equal(answered.cmdName, 'deliver_sm_resp');
		assert.equal(answered.cmdStatus, 'ESME_RINVTLVSTREAM');
		assert.equal(answered.seqNr, 5);
		assert.equal(reports, 0, 'a refused PDU is not a report');

		// The regression this fixes: the link, and the stream's sync, outlive the refused PDU.
		peer.writeRaw(pduBytes({ cmdName: 'enquire_link', seqNr: 78 }));
		assert.equal((await answerTo(peer)).cmdName, 'enquire_link_resp');
	});

	test('answers a deliver_sm ending in a bare TLV header with ESME_RINVTLVSTREAM', async t => {
		const { peer, session } = await bound(t);
		let reports = 0;

		session.on('dlr', () => { reports++; });
		peer.writeRaw(bareTlvHeader({ cmdName: 'deliver_sm', params: receipt, seqNr: 55 }));

		const answered = await answerTo(peer);

		assert.equal(answered.cmdName, 'deliver_sm_resp');
		assert.equal(answered.cmdStatus, 'ESME_RINVTLVSTREAM');
		assert.equal(answered.seqNr, 55);
		assert.equal(reports, 0, 'a PDU whose optional parameters were never read is no report');

		peer.writeRaw(pduBytes({ cmdName: 'enquire_link', seqNr: 79 }));
		assert.equal((await answerTo(peer)).cmdName, 'enquire_link_resp');
	});

	test('answers a deliver_sm whose body is shorter than it declares with ESME_RINVCMDLEN', async t => {
		const { peer } = await bound(t);

		peer.writeRaw(shortened({ cmdName: 'deliver_sm', params: receipt, seqNr: 6 }, 3));

		const answered = await answerTo(peer);

		assert.equal(answered.cmdName, 'deliver_sm_resp');
		assert.equal(answered.cmdStatus, 'ESME_RINVCMDLEN');
		assert.equal(answered.seqNr, 6);
	});

	test('settles the request a response it could not read was answering, and reports it', async t => {
		const { peer, session } = await bound(t, { responseTimeout: 60000 });
		const failed = once<Error>(resolve => { session.on('sessionError', resolve); });
		const sending = session.sendSms({ from: '46701113311', message: 'hi', to: '46709771337' });
		const submitted = await answerTo(peer);

		assert.equal(submitted.cmdName, 'submit_sm');
		peer.writeRaw(truncatedTlv({
			cmdName: 'submit_sm_resp',
			params: { message_id: '0199e0ea-1c88-7a41-b6d2-4e7f0a9c3b15' },
			seqNr: submitted.seqNr,
		}));

		const sent = await raceWithin(2000, sending);

		assert.ok(sent, 'the request settles on the refusal rather than on the response timeout');
		assert.ok(sent.err instanceof Error);
		assert.equal(sent.unanswered, 1);

		const reported = await raceWithin(2000, failed);

		assert.ok(reported instanceof PduRefusedError);
		assert.equal(reported.header.cmdName, 'submit_sm_resp');

		// Nothing goes back: a response carries a sequence number of ours, not one of the peer's.
		peer.writeRaw(pduBytes({ cmdName: 'enquire_link', seqNr: 77 }));
		assert.equal((await answerTo(peer)).cmdName, 'enquire_link_resp');
	});

	test('tears the link down when the stream itself cannot be framed', async t => {
		const { peer, session } = await bound(t, { reconnect: false });
		const failed = once<Error>(resolve => { session.on('sessionError', resolve); });
		const closed = once<true>(resolve => { session.on('close', () => { resolve(true); }); });

		// A command_length below the 16 octet header leaves nothing that can find the next PDU.
		peer.writeRaw(Buffer.from('00000004000000150000000000000001', 'hex'));

		assert.ok((await raceWithin(2000, failed)) instanceof Error);
		assert.equal(await raceWithin(2000, closed), true);
	});
});

describe('application hooks that throw or reject', () => {
	test('turns a throwing authenticate into a session error', async t => {
		const smpp = await startServer(t, {
			authenticate: () => { throw new Error('authenticate exploded'); },
		});
		const failed = once<Error>(resolve => {
			smpp.on('session', session => { session.on('sessionError', resolve); });
		});
		const { err } = await connect(t, smpp, { responseTimeout: 200 });
		const reported = await raceWithin(500, failed);

		assert.ok(err instanceof Error);
		assert.ok(reported instanceof Error, 'a throwing authenticate should reach the session');
		assert.equal(reported.message, 'authenticate exploded');
	});

	test('turns a throwing sms listener into a session error', async t => {
		const smpp = await startServer(t);
		const failed = once<Error>(resolve => {
			smpp.on('session', session => {
				session.on('sessionError', resolve);
				session.on('sms', () => { throw new Error('listener exploded'); });
			});
		});
		const { session } = await connect(t, smpp, { responseTimeout: 200 });

		assert.ok(session);

		const sent = await session.sendSms({
			from: '46701113311',
			message: 'blows up the listener',
			to: '46709771337',
		});
		const reported = await raceWithin(500, failed);

		assert.ok(sent.err instanceof Error);
		assert.ok(reported instanceof Error, 'a throwing sms listener should reach the session');
		assert.equal(reported.message, 'listener exploded');
	});

	// The guard for a throwing sms listener used to emit sessionError from inside its own catch.
	test('survives a sessionError listener that throws as well', async t => {
		const smpp = await startServer(t);

		smpp.on('session', session => {
			session.on('sessionError', () => { throw new Error('the reporter exploded too'); });
			session.on('sms', () => { throw new Error('listener exploded'); });
		});

		const { session } = await connect(t, smpp, { responseTimeout: 200 });

		assert.ok(session);

		const sent = await session.sendSms({
			from: '46701113311',
			message: 'blows up both listeners',
			to: '46709771337',
		});

		assert.ok(sent.err instanceof Error);
	});

	test('normalises whatever a rejecting async sms listener threw into a session error', async t => {
		const smpp = await startServer(t);
		const reason: unknown = null;
		const failed = once<Error>(resolve => {
			smpp.on('session', session => {
				session.on('sessionError', resolve);
				session.on('sms', async sms => {
					await sms.sendResp();

					throw reason;
				});
			});
		});
		const { session } = await connect(t, smpp, { responseTimeout: 200 });

		assert.ok(session);

		const sent = await session.sendSms({
			from: '46701113311',
			message: 'rejects after answering',
			to: '46709771337',
		});
		const reported = await raceWithin(500, failed);

		assert.equal(sent.err, undefined);
		assert.ok(reported instanceof Error, 'a rejecting sms listener should reach the session');
		assert.equal(reported.message, 'null');
	});

	test('survives a sessionError listener that rejects as well', async t => {
		const smpp = await startServer(t);

		smpp.on('session', session => {
			session.on('sessionError', () => Promise.reject(new Error('the reporter rejected too')));
			session.on('sms', () => Promise.reject(new Error('listener rejected')));
		});

		const { session } = await connect(t, smpp, { responseTimeout: 200 });

		assert.ok(session);

		const sent = await session.sendSms({
			from: '46701113311',
			message: 'rejects in both listeners',
			to: '46709771337',
		});

		assert.ok(sent.err instanceof Error);
	});

	test('turns a rejecting session listener into a server error', async t => {
		const smpp = await startServer(t);
		const failed = once<Error>(resolve => { smpp.on('serverError', resolve); });

		smpp.on('session', () => Promise.reject(new Error('session listener rejected')));

		await connect(t, smpp);

		const reported = await raceWithin(500, failed);

		assert.ok(reported instanceof Error, 'a rejecting session listener should reach the server');
		assert.equal(reported.message, 'session listener rejected');
	});

	test('closes even when an application close listener throws', async t => {
		const smpp = await startServer(t);

		smpp.on('session', session => {
			session.on('close', () => { throw new Error('close listener exploded'); });
		});

		const { session } = await connect(t, smpp);

		assert.ok(session);
		await smpp.close();
		assert.equal(smpp.sessions.size, 0);
	});

	test('sends on through an application logger that throws', async t => {
		const thrower = (): void => { throw new Error('the logger exploded'); };
		const log: SmppLog = { debug: thrower, error: thrower, info: thrower, verbose: thrower, warn: thrower };
		const smpp = await startServer(t, { log });

		smpp.on('session', session => {
			session.on('sms', sms => { void sms.sendResp(); });
		});

		const { session } = await connect(t, smpp, { log });

		assert.ok(session);

		const sent = await session.sendSms({ from: '46701113311', message: 'logged', to: '46709771337' });

		assert.equal(sent.err, undefined);
	});

	test('refuses a send window that can never free a slot', async t => {
		const smpp = await startServer(t);
		const { err, session } = await connect(t, smpp, { maxOutstanding: 0 });

		assert.ok(err instanceof Error);
		assert.match(err.message, /maxOutstanding/);
		assert.equal(session, undefined);

		const negative = await connect(t, smpp, { shutdownTimeout: -1 });

		assert.ok(negative.err instanceof Error);
		assert.match(negative.err.message, /shutdownTimeout/);
		assert.equal(negative.session, undefined);
	});

	test('keeps the message id off a submit_sm_resp that refuses the message', async t => {
		const smpp = await startServer(t);

		smpp.on('session', bound => {
			bound.on('sms', sms => { void sms.sendResp({ status: 'ESME_RMSGQFUL' }); });
		});

		const peer = rawPeer(t, smpp.port);

		peer.write(bindOf(0x34));
		await peer.next();
		peer.write({
			cmdName: 'submit_sm',
			params: {
				destination_addr: '46709771337',
				short_message: 'full queue',
				source_addr: '46701113311',
			},
			seqNr: 2,
		});

		const refused = await peer.next();

		assert.equal(refused.cmdName, 'submit_sm_resp');
		assert.equal(refused.cmdStatus, 'ESME_RMSGQFUL');
		assert.equal(refused.cmdLength, 16);
		assert.deepEqual(refused.params, {});
	});

	test('keeps the reconnect loop alive when connect throws', async t => {
		let attempts = 0;
		const loop = new ReconnectLoop({
			connect: () => {
				attempts++;

				throw new Error('connect exploded');
			},
			log: silentLog,
			maxDelay: 10,
			minDelay: 1,
			onConnected: () => Promise.resolve({}),
		});

		t.after(() => { loop.stop(); });
		loop.schedule();

		const retried = await waitFor(() => attempts >= 2);

		assert.ok(retried, 'a throwing connect should be retried, not left for the process to die on');
	});

	test('keeps backing off when every link dies as soon as it comes up', async t => {
		const clock = { now: 0 };
		const delays: number[] = [];
		const noop = (): void => undefined;
		const log: SmppLog = {
			debug: noop,
			error: noop,
			info: (msg, metadata) => {
				if (msg === 'reconnect - retrying') delays.push(Number(metadata?.delay));
			},
			verbose: noop,
			warn: noop,
		};
		let up = 0;
		const loop = new ReconnectLoop({
			connect: () => Promise.resolve({ sock: new net.Socket() }),
			log,
			maxDelay: 80,
			minDelay: 10,
			now: () => clock.now,
			onConnected: () => {
				up++;

				return Promise.resolve({});
			},
		});

		t.after(() => { loop.stop(); });

		for (let died = 0; died < 4; died++) {
			loop.schedule();
			await waitFor(() => up === died + 1);
			await delay(5);
		}

		assert.deepEqual(delays, [10, 20, 40, 80]);

		// A link that outlasted the longest wait earned a fresh start.
		clock.now += 80;
		loop.schedule();
		await waitFor(() => delays.length === 5);

		assert.deepEqual(delays, [10, 20, 40, 80, 10]);
	});

	test('starts only one reconnect attempt at a time', async t => {
		let attempts = 0;
		let finish: (() => void) | undefined;
		const loop = new ReconnectLoop({
			connect: () => {
				attempts++;

				return new Promise(resolve => {
					finish = () => { resolve({ err: new Error('no socket') }); };
				});
			},
			log: silentLog,
			maxDelay: 5,
			minDelay: 1,
			onConnected: () => Promise.resolve({}),
		});

		t.after(() => {
			loop.stop();
			finish?.();
		});
		loop.schedule();

		assert.ok(await waitFor(() => attempts === 1));

		// A second drop landing while the first attempt is still inside connect().
		loop.schedule();
		await delay(30);

		assert.equal(attempts, 1);
	});
});

describe('the server\'s onRequest hook', () => {
	const answeredId = '01a07501-b609-7d27-ab98-d3b29bd78e7e';

	function submitTo(session: Session, to: string, message = 'screened by the hook') {
		return session.send({
			cmdName: 'submit_sm',
			params: { destination_addr: to, short_message: message, source_addr: '46701113311' },
		});
	}

	test('refuses an inbound submit_sm with the status the hook chose', async t => {
		const smpp = await startServer(t, {
			onRequest: async (bound, pduObj) => {
				if (!isCommand(pduObj, 'submit_sm')) return false;

				await bound.sendReturn(pduObj, 'ESME_RINVDSTADR');

				return true;
			},
		});
		let messages = 0;

		smpp.on('session', bound => bound.on('sms', () => { messages++; }));

		const { session } = await connect(t, smpp);

		assert.ok(session);

		const answered = await submitTo(session, '46700000000');

		assert.equal(answered.err, undefined);
		assert.ok(answered.pduObj);
		assert.equal(answered.pduObj.cmdStatus, 'ESME_RINVDSTADR');
		assert.equal(messages, 0, 'a request the hook answered never reaches the sms event');
	});

	test('answers a bind itself, so a hook that claims every request cannot intercept one', async t => {
		const seen: string[] = [];
		const smpp = await startServer(t, {
			authenticate: ({ password, systemId }) => systemId === 'user' && password === 'pass',
			onRequest: (_bound, pduObj) => { seen.push(pduObj.cmdName); return true; },
		});
		const peer = rawPeer(t, smpp.port);

		peer.write(bindOf(0x34));

		const accepted = await peer.next();

		peer.write(bindOf(0x34, 2));

		const rebound = await peer.next();
		const wrong = rawPeer(t, smpp.port);

		wrong.write({
			cmdName: 'bind_transceiver',
			params: { interface_version: 0x34, password: 'wrong', system_id: 'user' },
			seqNr: 1,
		});

		const refused = await wrong.next();
		const early = rawPeer(t, smpp.port);

		early.write({ cmdName: 'unbind', seqNr: 1 });

		const unbound = await early.next();

		assert.equal(accepted.cmdName, 'bind_transceiver_resp');
		assert.equal(accepted.cmdStatus, 'ESME_ROK');
		assert.equal(rebound.cmdStatus, 'ESME_RALYBND');
		assert.equal(refused.cmdStatus, 'ESME_RBINDFAIL');
		assert.equal(unbound.cmdName, 'unbind_resp');
		assert.deepEqual(seen, [], 'a bind, and everything a peer sends before one, is never the hook\'s');
	});

	test('passes a request the hook declines through to the sms event', async t => {
		const seen: string[] = [];
		const smpp = await startServer(t, {
			onRequest: (_bound, pduObj) => { seen.push(pduObj.cmdName); return false; },
		});
		const incoming = once<Sms>(resolve => {
			smpp.on('session', bound => bound.on('sms', async sms => {
				resolve(sms);
				await sms.sendResp({ smsId: answeredId });
			}));
		});
		const { session } = await connect(t, smpp);

		assert.ok(session);

		const answered = await submitTo(session, '46709771337', 'declined by the hook');
		const sms = await incoming;

		assert.ok(answered.pduObj);
		assert.equal(answered.pduObj.cmdStatus, 'ESME_ROK');
		assert.equal(paramText(answered.pduObj.params.message_id), answeredId);
		assert.equal(sms.message, 'declined by the hook');
		assert.deepEqual(seen, ['submit_sm']);
	});

	test('reports a hook that throws and answers nothing for it', async t => {
		const smpp = await startServer(t, {
			onRequest: () => { throw new Error('the onRequest hook exploded'); },
		});
		const failed = once<Error>(resolve => {
			smpp.on('session', bound => { bound.on('sessionError', resolve); });
		});
		let messages = 0;

		smpp.on('session', bound => bound.on('sms', () => { messages++; }));

		const { session } = await connect(t, smpp, { responseTimeout: 300 });

		assert.ok(session);

		const answered = await submitTo(session, '46709771337');
		const reported = await failed;

		assert.ok(answered.err instanceof Error);
		assert.equal(reported.message, 'the onRequest hook exploded');
		assert.equal(messages, 0, 'a hook that failed decided nothing, so nothing may decide for it');
	});

	test('reports a hook that rejects and answers nothing for it', async t => {
		const smpp = await startServer(t, {
			onRequest: () => Promise.reject(new Error('the onRequest hook rejected')),
		});
		const failed = once<Error>(resolve => {
			smpp.on('session', bound => { bound.on('sessionError', resolve); });
		});
		let messages = 0;

		smpp.on('session', bound => bound.on('sms', () => { messages++; }));

		const { session } = await connect(t, smpp, { responseTimeout: 300 });

		assert.ok(session);

		const answered = await submitTo(session, '46709771337');
		const reported = await failed;

		assert.ok(answered.err instanceof Error);
		assert.equal(reported.message, 'the onRequest hook rejected');
		assert.equal(messages, 0);
	});

	test('writes nothing more for a segment the hook answered before it failed', async t => {
		const smpp = await startServer(t, {
			onRequest: async (bound, pduObj) => {
				await bound.sendReturn(pduObj, 'ESME_RINVDSTADR');

				throw new Error('the onRequest hook exploded after answering');
			},
		});
		const failed = once<Error>(resolve => {
			smpp.on('session', bound => { bound.on('sessionError', resolve); });
		});
		const peer = rawPeer(t, smpp.port);
		const segment = splitMessage('one segment of a longer message. '.repeat(8), { reference: 0x6D })[0];

		assert.ok(segment);
		peer.write(bindOf(0x34));
		await peer.next();
		peer.write({
			cmdName: 'submit_sm',
			params: {
				destination_addr: '46709771337',
				esm_class: consts.ESM_CLASS.UDH_INDICATOR,
				short_message: segment,
				source_addr: '46701113311',
			},
			seqNr: 2,
		});

		const refused = await peer.next();
		const reported = await failed;

		assert.equal(refused.cmdStatus, 'ESME_RINVDSTADR');
		assert.equal(await raceWithin(200, peer.next()), false, 'the peer gets one answer, not two');
		assert.equal(reported.message, 'the onRequest hook exploded after answering');
	});

	test('closes without waiting out the shutdown for a message the hook answered itself', async t => {
		const smpp = await startServer(t, {
			onRequest: async (bound, pduObj) => {
				if (!isCommand(pduObj, 'submit_sm')) return false;

				await bound.sendReturn(pduObj, 'ESME_ROK', { message_id: answeredId });

				return true;
			},
			shutdownTimeout: 2000,
		});
		const bound = once<Session>(resolve => { smpp.on('session', resolve); });
		const { session } = await connect(t, smpp);

		assert.ok(session);

		const answered = await submitTo(session, '46709771337');
		const serverSide = await bound;
		const started = Date.now();
		const closed = await serverSide.close();
		const waited = Date.now() - started;

		assert.ok(answered.pduObj);
		assert.equal(paramText(answered.pduObj.params.message_id), answeredId);
		assert.deepEqual(closed, {});
		assert.ok(waited < 1000, `close() waited ${String(waited)} ms on a message nothing was holding`);
	});
});

describe('link timers', () => {
	test('closes a client link the peer has stopped answering', async t => {
		const peer = await smscPeer(t);
		const { err, session } = await client({
			enquireLinkInterval: 50,
			port: peer.port,
			reconnect: false,
		});

		assert.equal(err, undefined);
		assert.ok(session);
		closeAfter(t, session);

		const closed = once<true>(resolve => { session.on('close', () => { resolve(true); }); });

		assert.ok(
			await raceWithin(1000, closed),
			'a peer that answers nothing should time the link out',
		);
	});

	test('reconnects a link that timed out', async t => {
		const peer = await smscPeer(t);
		const { session } = await client({
			enquireLinkInterval: 40,
			port: peer.port,
			reconnect: { maxDelay: 20, minDelay: 10 },
		});

		assert.ok(session);
		closeAfter(t, session);

		const back = once<true>(resolve => { session.on('reconnected', () => { resolve(true); }); });

		assert.ok(await raceWithin(2000, back), 'a link that timed out should be reconnected');
	});
});

describe('merged delivery report bounds', () => {
	function receipt(smsId: string): Dlr {
		return {
			doneDate: undefined,
			errorCode: undefined,
			intermediate: false,
			receipt: undefined,
			smsId,
			statusId: 2,
			statusMsg: 'DELIVERED',
		};
	}

	function merger(options: { max?: number; now?: () => number } = {}): DlrMerger {
		return new DlrMerger({
			log: silentLog,
			max: options.max ?? 10,
			now: options.now ?? (() => 0),
			timeout: 60,
		});
	}

	test('merges the receipts of one message and forgets the group', () => {
		const dlrMerger = merger();

		dlrMerger.expect(['whole-1', 'whole-2']);

		assert.equal(dlrMerger.collect(receipt('whole-1')), undefined);

		const merged = dlrMerger.collect(receipt('whole-2'));

		assert.ok(merged);
		assert.equal(merged.smsId, 'whole');
		assert.equal(merged.segments.length, 2);
		assert.equal(dlrMerger.size, 0);
	});

	// Telesign answers only the first segment of a concatenated submit with a message id.
	test('arms nothing for a send whose ids do not number one message', () => {
		const dlrMerger = merger();

		dlrMerger.expect(['5cb0ea53b5d61093529174ca44e23871', '', '']);
		assert.equal(dlrMerger.size, 0, 'an id the peer never named numbers nothing');

		dlrMerger.expect(['bf53ad8b-1', '40ccdce2-2']);
		assert.equal(dlrMerger.size, 0, 'nor do ids numbered off a base each');
	});

	// A receipt for whole-3 would otherwise fill the slot whole-2 was registered for, truncating the report.
	test('ignores a receipt for a part the send never registered', () => {
		const dlrMerger = merger();

		dlrMerger.expect(['whole-1', 'whole-2']);

		assert.equal(dlrMerger.collect(receipt('whole-1')), undefined);
		assert.equal(dlrMerger.collect(receipt('whole-3')), undefined);
		assert.equal(dlrMerger.size, 1);

		const merged = dlrMerger.collect(receipt('whole-2'));

		assert.ok(merged);
		assert.deepEqual(merged.segments.map(one => one.smsId), ['whole-1', 'whole-2']);
	});

	// Every multipart send registered a group, and only a complete set of receipts ever removed it.
	test('drops the oldest group once the cap is reached', () => {
		const dlrMerger = merger({ max: 2 });

		for (const base of ['first', 'second', 'third']) {
			dlrMerger.expect([`${base}-1`, `${base}-2`]);
		}

		assert.equal(dlrMerger.size, 2);
		assert.equal(dlrMerger.collect(receipt('first-1')), undefined);
		assert.equal(dlrMerger.collect(receipt('first-2')), undefined);

		dlrMerger.expect(['first-1', 'first-2']);

		assert.equal(dlrMerger.collect(receipt('first-1')), undefined);
		assert.equal(dlrMerger.collect(receipt('first-2')), undefined);

		dlrMerger.clear();
		assert.equal(dlrMerger.size, 0);
	});

	test('expires a group whose receipts never all arrived', () => {
		let now = 0;
		const dlrMerger = merger({ now: () => now });

		dlrMerger.expect(['late-1', 'late-2']);
		now = 61;

		assert.equal(dlrMerger.collect(receipt('late-1')), undefined);
		assert.equal(dlrMerger.size, 0);

		dlrMerger.expect(['late-1', 'late-2']);

		assert.equal(dlrMerger.collect(receipt('late-1')), undefined);
		assert.equal(dlrMerger.collect(receipt('late-2')), undefined);
	});

	test('leaves a base the peer hands out twice unmerged', () => {
		const dlrMerger = merger();

		dlrMerger.expect(['reused-1', 'reused-2']);

		assert.equal(dlrMerger.collect(receipt('reused-1')), undefined);
		assert.ok(dlrMerger.collect(receipt('reused-2')));

		dlrMerger.expect(['reused-1', 'reused-2']);

		assert.equal(dlrMerger.size, 0);
		assert.equal(dlrMerger.collect(receipt('reused-1')), undefined);
		assert.equal(dlrMerger.collect(receipt('reused-2')), undefined);
	});

	test('forgets the base closed longest ago, not the one handed out again', () => {
		const dlrMerger = merger({ max: 2 });

		for (const base of ['reused', 'other']) {
			dlrMerger.expect([`${base}-1`, `${base}-2`]);
			assert.equal(dlrMerger.collect(receipt(`${base}-1`)), undefined);
			assert.ok(dlrMerger.collect(receipt(`${base}-2`)));
		}

		dlrMerger.expect(['reused-1', 'reused-2']);
		dlrMerger.expect(['third-1', 'third-2']);

		assert.equal(dlrMerger.collect(receipt('third-1')), undefined);
		assert.ok(dlrMerger.collect(receipt('third-2')));

		dlrMerger.expect(['reused-1', 'reused-2']);

		assert.equal(dlrMerger.size, 0);

		dlrMerger.expect(['other-1', 'other-2']);

		assert.equal(dlrMerger.size, 1);
	});

	test('keeps another message when a held base is opened again', () => {
		const dlrMerger = merger({ max: 2 });

		dlrMerger.expect(['first-1', 'first-2']);
		dlrMerger.expect(['second-1', 'second-2']);
		dlrMerger.expect(['second-1', 'second-2']);

		assert.equal(dlrMerger.collect(receipt('first-1')), undefined);

		const merged = dlrMerger.collect(receipt('first-2'));

		assert.ok(merged);
		assert.equal(merged.smsId, 'first');
	});
});

describe('option validation', () => {
	test('refuses an interface version that cannot go on the wire', async () => {
		const { err, server: smpp } = await server({ interfaceVersion: 0x100, port: 0 });

		if (smpp) await smpp.close();

		assert.ok(err instanceof Error);
	});

	test('refuses a hook that is not a function at startup, rather than once per PDU', async () => {
		const badAuth: ServerOptions = { port: 0 };
		const badHook: ServerOptions = { port: 0 };

		Object.assign(badAuth, { authenticate: 'yes please' });
		Object.assign(badHook, { onRequest: 'refuse them all' });

		const authRefused = await server(badAuth);
		const hookRefused = await server(badHook);

		if (authRefused.server) await authRefused.server.close();
		if (hookRefused.server) await hookRefused.server.close();

		assert.match(authRefused.err?.message ?? '', /authenticate must be a function/);
		assert.match(hookRefused.err?.message ?? '', /onRequest must be a function/);
	});

	test('returns an error rather than rejecting on an impossible port', async () => {
		const listening = await server({ port: 70_000 });

		assert.ok(listening.err instanceof Error);

		const connected = await client({ port: 70_000 });

		assert.ok(connected.err instanceof Error);
	});
});
