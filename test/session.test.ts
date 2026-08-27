import assert from 'node:assert/strict';
import net from 'node:net';
import test, { describe } from 'node:test';
import type { Dlr } from '../src/dlr.ts';
import type { PduObject, PduObjectInput } from '../src/pdu.ts';
import type { Sms } from '../src/sms.ts';
import type { SmppServer } from '../src/server.ts';
import type { TestContext } from 'node:test';
import type { VoidResult } from '../src/result.ts';
import { DlrMerger } from '../src/dlr-merger.ts';
import { PduFramer } from '../src/pdu-framer.ts';
import { ReconnectLoop } from '../src/reconnect-loop.ts';
import { Session, bindCommands } from '../src/session.ts';
import { client } from '../src/client.ts';
import { consts } from '../src/defs/constants.ts';
import { isCommand, objToPdu, pduReturn, pduToObj } from '../src/pdu.ts';
import { paramText } from '../src/defs/types.ts';
import { server } from '../src/server.ts';
import { silentLog } from '../src/log.ts';
import { splitMessage } from '../src/message.ts';

async function startServer(options: Parameters<typeof server>[0] = {}): Promise<SmppServer> {
	const { err, server: smpp } = await server({ ...options, port: 0 });

	assert.equal(err, undefined);
	assert.ok(smpp);

	return smpp;
}

async function connect(smpp: SmppServer, options: Parameters<typeof client>[0] = {}) {
	return client({ port: smpp.port, ...options });
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

type Peer = { close: () => Promise<void>; port: number };

/** Answers binds and nothing else, which is what a link the peer has stopped serving looks like. */
async function bindOnlyPeer(options: { dropOn?: string } = {}): Promise<Peer> {
	const sockets: net.Socket[] = [];
	const listener = net.createServer(sock => {
		const framer = new PduFramer();

		sockets.push(sock);
		sock.on('data', chunk => {
			framer.push(chunk);

			for (const pdu of framer.next().pdus ?? []) {
				const { pduObj } = pduToObj(pdu);

				if (pduObj && pduObj.cmdName === options.dropOn) {
					sock.destroy();

					return;
				}

				if (!pduObj || !bindCommands.includes(pduObj.cmdName)) continue;

				const { buffer } = pduReturn(pduObj, 'ESME_ROK', { system_id: 'silent' });

				if (buffer) sock.write(buffer);
			}
		});
	});

	await new Promise<void>(resolve => { listener.listen(0, resolve); });

	const address = listener.address();

	return {
		close: async () => {
			for (const sock of sockets) {
				sock.destroy();
			}

			await new Promise<void>(resolve => { listener.close(() => { resolve(); }); });
		},
		port: typeof address === 'object' && address !== null ? address.port : 0,
	};
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
function rawPeer(port: number): RawPeer {
	const framer = new PduFramer();
	const queue: PduObject[] = [];
	const waiting: ((pduObj: PduObject) => void)[] = [];
	const sock = net.connect({ port });

	sock.on('data', chunk => {
		framer.push(chunk);

		const { pdus } = framer.next();

		for (const pdu of pdus ?? []) {
			const { pduObj } = pduToObj(pdu);

			if (!pduObj) continue;

			const next = waiting.shift();

			if (next) next(pduObj);
			else queue.push(pduObj);
		}
	});

	return {
		close: () => { sock.destroy(); },
		next: () => {
			const queued = queue.shift();

			return queued
				? Promise.resolve(queued)
				: once<PduObject>(resolve => waiting.push(resolve));
		},
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

async function bindRaw(smpp: SmppServer, interfaceVersion: number): Promise<PduObject> {
	const peer = rawPeer(smpp.port);

	peer.write(bindOf(interfaceVersion));

	const response = await peer.next();

	peer.close();

	return response;
}

describe('bind', () => {
	test('binds and unbinds against a server with no auth', async () => {
		const smpp = await startServer();
		const { err, session } = await connect(smpp);

		assert.equal(err, undefined);
		assert.ok(session);
		assert.ok(session.loggedIn);

		assert.deepEqual(await session.unbind(), {});
		await smpp.close();
	});

	// Plenty of SMSCs drop the connection on unbind instead of answering it.
	test('takes a close that follows our unbind as a clean unbind', async () => {
		const peer = await bindOnlyPeer({ dropOn: 'unbind' });
		const { session } = await client({ port: peer.port, responseTimeout: 2000 });

		assert.ok(session);
		assert.deepEqual(await session.unbind(), {});

		await peer.close();
	});

	test('still reports a close that lands on another in-flight request', async () => {
		const peer = await bindOnlyPeer({ dropOn: 'enquire_link' });
		const { session } = await client({ port: peer.port, responseTimeout: 2000 });

		assert.ok(session);

		const sent = await session.send({ cmdName: 'enquire_link' });

		assert.ok(sent.err instanceof Error);
		assert.equal(sent.err.message, 'Session closed before a response arrived');

		session.close();
		await peer.close();
	});

	test('reports an unbind the peer left unanswered on a link that stays up', async () => {
		const peer = await bindOnlyPeer();
		const { session } = await client({ port: peer.port, responseTimeout: 150 });

		assert.ok(session);
		assert.ok((await session.unbind()).err instanceof Error);

		await peer.close();
	});

	test('reports the resolved port when 0 was requested', async () => {
		const smpp = await startServer();

		assert.ok(smpp.port > 0);
		await smpp.close();
	});

	test('refuses the wrong credentials', async () => {
		const smpp = await startServer({
			authenticate: ({ password, systemId }) => systemId === 'foo' && password === 'bar',
		});
		const { err, session } = await connect(smpp);

		assert.ok(err instanceof Error);
		assert.equal(session, undefined);
		await smpp.close();
	});

	test('accepts the right credentials and attaches userData', async () => {
		const smpp = await startServer({
			authenticate: ({ password, systemId }) => systemId === 'foo' && password === 'bar'
				? { userData: { userId: 123 } }
				: false,
		});
		const serverSession = once<Session>(resolve => smpp.on('session', resolve));
		const { err, session } = await connect(smpp, { password: 'bar', username: 'foo' });

		assert.equal(err, undefined);
		assert.ok(session);

		const bound = await serverSession;

		assert.deepEqual(bound.userData, { userId: 123 });

		session.close();
		await smpp.close();
	});

	test('answers a non-bind command from an unbound peer with ESME_RINVBNDSTS', async () => {
		const smpp = await startServer();
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
		await smpp.close();
	});

	test('declares SMPP 3.4 by default and the version the caller asks for', async () => {
		const smpp = await startServer();
		const declared: (number | undefined)[] = [];

		smpp.on('session', session => {
			session.on('incomingPduObj', pduObj => {
				if (isCommand(pduObj, 'bind_transceiver')) {
					declared.push(pduObj.params.interface_version);
				}
			});
		});

		const { session: byDefault } = await connect(smpp);
		const { session: asFive } = await connect(smpp, { interfaceVersion: 0x50 });

		assert.ok(byDefault);
		assert.ok(asFive);
		assert.deepEqual(declared, [0x34, 0x50]);

		await byDefault.unbind();
		await asFive.unbind();
		await smpp.close();
	});

	test('tells a 3.4 peer the version it supports in the bind response', async () => {
		const smpp = await startServer();
		const asThreeFour = await bindRaw(smpp, 0x34);
		const asFive = await bindRaw(smpp, 0x50);

		assert.equal(asThreeFour.cmdName, 'bind_transceiver_resp');
		assert.equal(asThreeFour.cmdStatus, 'ESME_ROK');
		assert.deepEqual(asThreeFour.tlvs.sc_interface_version, {
			tagId: 0x0210,
			tagName: 'sc_interface_version',
			tagValue: 0x34,
		});
		assert.equal(asFive.tlvs.sc_interface_version?.tagValue, 0x34);

		await smpp.close();
	});

	test('advertises the version the server is configured with', async () => {
		const smpp = await startServer({ interfaceVersion: 0x50 });
		const asThreeFour = await bindRaw(smpp, 0x34);

		assert.equal(asThreeFour.tlvs.sc_interface_version?.tagValue, 0x50);

		// The threshold for sending optional parameters is 3.4 whatever the server advertises.
		const asThreeThree = await bindRaw(smpp, 0x33);

		assert.deepEqual(asThreeThree.tlvs, {});

		await smpp.close();
	});

	test('answers a bind with its own system_id, not the one the ESME sent', async () => {
		const anonymous = await startServer();
		const named = await startServer({ systemId: 'the-smsc' });

		assert.equal((await bindRaw(anonymous, 0x34)).params.system_id, '');
		assert.equal((await bindRaw(named, 0x34)).params.system_id, 'the-smsc');

		await anonymous.close();
		await named.close();
	});

	// The echo leak cannot reach a refusal at all: the spec gives a failure response no body.
	test('answers a refused bind with no body to leak', async () => {
		const smpp = await startServer({ authenticate: () => false, systemId: 'the-smsc' });
		const refused = await bindRaw(smpp, 0x34);

		assert.equal(refused.cmdStatus, 'ESME_RBINDFAIL');
		assert.equal(refused.cmdLength, 16);
		assert.deepEqual(refused.params, {});

		await smpp.close();
	});

	test('sends no optional parameters to a peer declaring less than 3.4', async () => {
		const smpp = await startServer();
		const bound = await bindRaw(smpp, 0x00);

		assert.equal(bound.cmdStatus, 'ESME_ROK');
		assert.deepEqual(bound.tlvs, {});

		await smpp.close();
	});

	test('answers a second bind with ESME_RALYBND and no body', async () => {
		const smpp = await startServer({ systemId: 'the-smsc' });
		const peer = rawPeer(smpp.port);

		peer.write(bindOf(0x34));
		await peer.next();
		peer.write(bindOf(0x34, 2));

		const again = await peer.next();

		assert.equal(again.cmdStatus, 'ESME_RALYBND');
		assert.deepEqual(again.params, {});

		peer.close();
		await smpp.close();
	});

	test('records the version the SMSC declared in its bind response', async t => {
		const smpp = await startServer({ interfaceVersion: 0x50 });

		t.after(() => smpp.close());

		const { session } = await connect(smpp);

		assert.ok(session);
		t.after(() => { session.close(); });
		assert.equal(session.peerInterfaceVersion, 0x50);
		assert.ok(session.acceptsOptionalParams());
	});

	// The spec: an absent sc_interface_version means the SMSC supports no optional parameters.
	test('takes an SMSC that declares no version as older than 3.4', async t => {
		const peer = await bindOnlyPeer();

		t.after(() => peer.close());

		const { session } = await client({ port: peer.port });

		assert.ok(session);
		t.after(() => { session.close(); });
		assert.equal(session.peerInterfaceVersion, 0x00);
		assert.equal(session.acceptsOptionalParams(), false);
	});
});

describe('sending', () => {
	test('delivers a simple SMS with the sender TON derived from the address', async () => {
		const smpp = await startServer();
		const incoming = once<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});
		const { session } = await connect(smpp);

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

		session.close();
		await smpp.close();
	});

	test('reassembles a long SMS and answers every segment', async () => {
		const smpp = await startServer();
		const message = 'Lorem ipsum dolor sit amet, '.repeat(20);
		const incoming = once<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});
		const { session } = await connect(smpp);

		assert.ok(session);

		const [sms, sent] = await Promise.all([
			incoming.then(async received => {
				await received.sendResp({ smsId: 'long-id' });

				return received;
			}),
			session.sendSms({ from: '46701113311', message, to: '46709771337' }),
		]);

		assert.equal(sms.message, message);
		assert.ok(sms.pduObjs.length > 1);
		assert.equal(sent.err, undefined);
		assert.equal(sent.pduObjs.length, 4);
		assert.deepEqual(sent.smsIds, ['long-id-1', 'long-id-2', 'long-id-3', 'long-id-4']);

		session.close();
		await smpp.close();
	});

	test('carries a UCS2 message through unchanged', async () => {
		const smpp = await startServer();
		const message = 'räksmörgås تست 一';
		const incoming = once<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});
		const { session } = await connect(smpp);

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

		session.close();
		await smpp.close();
	});

	test('marks a flash message without losing the UCS2 alphabet', async () => {
		const smpp = await startServer();
		const incoming = once<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});
		const { session } = await connect(smpp);

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

		session.close();
		await smpp.close();
	});
});

describe('receiving', () => {
	async function inbound(t: TestContext): Promise<{ peer: Session; session: Session }> {
		const smpp = await startServer();

		t.after(() => smpp.close());

		const bound = once<Session>(resolve => { smpp.on('session', resolve); });
		const { session } = await connect(smpp);

		assert.ok(session);
		t.after(() => { session.close(); });

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
		assert.equal(answered.pduObj.params.message_id, 'inbound-id');
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

		await sms.sendResp({ smsId: 'inbound-long' });

		const ids: string[] = [];

		for (const answered of await delivered) {
			assert.ok(answered.pduObj);
			ids.push(paramText(answered.pduObj.params.message_id));
		}

		assert.deepEqual(ids, ['inbound-long-1', 'inbound-long-2']);
	});
});

describe('delivery reports', () => {
	test('reaches the sender as a dlr event', async () => {
		const smpp = await startServer();
		const incoming = once<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});
		const { session } = await connect(smpp);

		assert.ok(session);

		const dlr = once<[{ smsId: string; statusMsg: string }, PduObject]>(resolve => {
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

		session.close();
		await smpp.close();
	});

	test('reports a failure with the spec status code', async () => {
		const smpp = await startServer();
		const incoming = once<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});
		const { session } = await connect(smpp);

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

		session.close();
		await smpp.close();
	});

	test('sends a text-only receipt to a peer that declared less than 3.4', async () => {
		const smpp = await startServer();
		const incoming = once<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});
		const peer = rawPeer(smpp.port);

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

		peer.close();
		await smpp.close();
	});

	test('merges nothing for a message that asked for no receipt', async () => {
		const smpp = await startServer();
		const incoming = once<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});
		const { session } = await connect(smpp);

		assert.ok(session);

		const perSegment: string[] = [];
		let merged = 0;

		session.on('dlr', dlr => perSegment.push(dlr.smsId));
		session.on('messageDlr', () => { merged++; });

		const [sms] = await Promise.all([
			incoming.then(async received => {
				await received.sendResp({ smsId: 'unrequested' });

				return received;
			}),
			session.sendSms({ from: '46701113311', message: 'x'.repeat(400), to: '46709771337' }),
		]);

		await sms.sendDlr();

		assert.deepEqual(perSegment, ['unrequested-1', 'unrequested-2', 'unrequested-3']);
		assert.equal(merged, 0);

		session.close();
		await smpp.close();
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

	async function replay(order: number[]): Promise<Sms> {
		const smpp = await startServer();
		const incoming = once<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});

		const sock = net.connect({ port: smpp.port }, () => {
			sock.write(Buffer.from('0000002100000009000000000000002f666f6f0062617200736d70700034000000', 'hex'));
		});

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
		sock.destroy();
		await smpp.close();

		return sms;
	}

	test('reassembles four segments arriving in order', async () => {
		assert.equal((await replay([0, 1, 2, 3])).message, expected);
	});

	test('reassembles the same four segments arriving out of order', async () => {
		assert.equal((await replay([1, 0, 3, 2])).message, expected);
	});
});

describe('robustness', () => {
	// 0.4.0 registered a listener per sequence number and waited forever, leaking one per call.
	test('gives up on a peer that never answers', async () => {
		const accepted: net.Socket[] = [];
		// resume() so the socket drains; an unread socket never notices the peer hanging up.
		const silent = net.createServer(sock => { accepted.push(sock); sock.resume(); });

		await new Promise<void>(resolve => silent.listen(0, resolve));

		const address = silent.address();
		const port = typeof address === 'object' && address !== null ? address.port : 0;
		const started = Date.now();
		const { err } = await client({ port, responseTimeout: 150 });

		assert.ok(err instanceof Error);
		assert.ok(Date.now() - started < 5000, 'should have given up quickly');

		for (const sock of accepted) sock.destroy();

		await new Promise<void>(resolve => silent.close(() => { resolve(); }));
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

	test('keeps at most maxOutstanding requests on the wire', async () => {
		const smpp = await startServer();
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

		const { session } = await connect(smpp, { maxOutstanding: 2 });

		assert.ok(session);

		await Promise.all(Array.from({ length: 8 }, (_, index) => session.sendSms({
			from: '46701113311',
			message: `message ${String(index)}`,
			to: '46709771337',
		})));

		assert.ok(peak <= 2, `peak was ${String(peak)}`);

		session.close();
		await smpp.close();
	});

	test('reports a response it could not send', async () => {
		const sock = new net.Socket();

		sock.destroy();

		const session = new Session({ sock });
		const failed = once<Error>(resolve => { session.on('sessionError', resolve); });
		const sent = await session.sendReturn(enquireLink(7));
		const reported = await raceWithin(500, failed);

		assert.ok(sent.err instanceof Error);
		assert.ok(reported instanceof Error, 'a response that never reached the wire should be reported');
		assert.equal(reported.message, sent.err.message);

		session.close();
	});

	test('ignores events from the socket it left behind on a reconnect', async () => {
		const smpp = await startServer();

		smpp.on('session', bound => {
			bound.on('sms', sms => { void sms.sendResp(); });
		});

		const { session } = await connect(smpp, { reconnect: { maxDelay: 50, minDelay: 10 } });

		assert.ok(session);

		const reconnected = once<true>(resolve => { session.on('reconnected', () => { resolve(true); }); });
		const dead = session.sock;

		for (const serverSession of smpp.sessions) {
			serverSession.close();
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

		session.close();
		await smpp.close();
	});

	test('closes the session when the signal aborts after the bind', async () => {
		const smpp = await startServer();
		const controller = new AbortController();
		const { err, session } = await connect(smpp, { signal: controller.signal });

		assert.equal(err, undefined);
		assert.ok(session);

		const closed = once<true>(resolve => { session.on('close', () => { resolve(true); }); });

		controller.abort();

		assert.ok(await closed);
		await smpp.close();
	});

	// An aborted send that still reaches the SMSC bills a message the caller believes never went out.
	test('puts nothing on the wire for a signal that is already aborted', async t => {
		const smpp = await startServer();

		t.after(() => smpp.close());

		const bound = once<Session>(resolve => { smpp.on('session', resolve); });
		const { session } = await connect(smpp);

		assert.ok(session);
		t.after(() => { session.close(); });

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

	// A socket the loop opened and never handed over is one leaked per retry, forever.
	test('leaves no socket open when coming back up fails', async () => {
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

		loop.schedule();

		const destroyed = await waitFor(() => opened.length >= 2
			&& opened[0]?.destroyed === true
			&& opened[1]?.destroyed === true);

		loop.stop();

		for (const sock of opened) {
			sock.destroy();
		}

		assert.ok(destroyed, 'a failed setup should leave no socket open');
	});
});

describe('application hooks that throw', () => {
	test('turns a throwing authenticate into a session error', async () => {
		const smpp = await startServer({
			authenticate: () => { throw new Error('authenticate exploded'); },
		});
		const failed = once<Error>(resolve => {
			smpp.on('session', session => { session.on('sessionError', resolve); });
		});
		const { err } = await connect(smpp, { responseTimeout: 200 });
		const reported = await raceWithin(500, failed);

		assert.ok(err instanceof Error);
		assert.ok(reported instanceof Error, 'a throwing authenticate should reach the session');
		assert.equal(reported.message, 'authenticate exploded');

		await smpp.close();
	});

	test('turns a throwing sms listener into a session error', async () => {
		const smpp = await startServer();
		const failed = once<Error>(resolve => {
			smpp.on('session', session => {
				session.on('sessionError', resolve);
				session.on('sms', () => { throw new Error('listener exploded'); });
			});
		});
		const { session } = await connect(smpp, { responseTimeout: 200 });

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

		session.close();
		await smpp.close();
	});

	// The guard for a throwing sms listener used to emit sessionError from inside its own catch.
	test('survives a sessionError listener that throws as well', async () => {
		const smpp = await startServer();

		smpp.on('session', session => {
			session.on('sessionError', () => { throw new Error('the reporter exploded too'); });
			session.on('sms', () => { throw new Error('listener exploded'); });
		});

		const { session } = await connect(smpp, { responseTimeout: 200 });

		assert.ok(session);

		const sent = await session.sendSms({
			from: '46701113311',
			message: 'blows up both listeners',
			to: '46709771337',
		});

		assert.ok(sent.err instanceof Error);

		session.close();
		await smpp.close();
	});

	test('closes even when an application close listener throws', async () => {
		const smpp = await startServer();

		smpp.on('session', session => {
			session.on('close', () => { throw new Error('close listener exploded'); });
		});

		const { session } = await connect(smpp);

		assert.ok(session);
		await smpp.close();
		assert.equal(smpp.sessions.size, 0);

		session.close();
	});

	test('refuses a send window that can never free a slot', async () => {
		const smpp = await startServer();
		const { err, session } = await connect(smpp, { maxOutstanding: 0 });

		assert.ok(err instanceof Error);
		assert.match(err.message, /maxOutstanding/);
		assert.equal(session, undefined);

		await smpp.close();
	});

	test('keeps the message id off a submit_sm_resp that refuses the message', async () => {
		const smpp = await startServer();

		smpp.on('session', bound => {
			bound.on('sms', sms => { void sms.sendResp({ status: 'ESME_RMSGQFUL' }); });
		});

		const peer = rawPeer(smpp.port);

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

		peer.close();
		await smpp.close();
	});

	test('keeps the reconnect loop alive when connect throws', async () => {
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

		loop.schedule();

		const retried = await waitFor(() => attempts >= 2);

		loop.stop();

		assert.ok(retried, 'a throwing connect should be retried, not left for the process to die on');
	});

	test('starts only one reconnect attempt at a time', async () => {
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

		loop.schedule();

		assert.ok(await waitFor(() => attempts === 1));

		// A second drop landing while the first attempt is still inside connect().
		loop.schedule();
		await delay(30);

		assert.equal(attempts, 1);

		loop.stop();
		finish?.();
	});
});

describe('link timers', () => {
	test('closes a client link the peer has stopped answering', async () => {
		const peer = await bindOnlyPeer();
		const { err, session } = await client({ enquireLinkInterval: 50, port: peer.port });

		assert.equal(err, undefined);
		assert.ok(session);

		const closed = once<true>(resolve => { session.on('close', () => { resolve(true); }); });

		assert.ok(
			await raceWithin(1000, closed),
			'a peer that answers nothing should time the link out',
		);

		session.close();
		await peer.close();
	});

	test('reconnects a link that timed out', async () => {
		const peer = await bindOnlyPeer();
		const { session } = await client({
			enquireLinkInterval: 40,
			port: peer.port,
			reconnect: { maxDelay: 20, minDelay: 10 },
		});

		assert.ok(session);

		const back = once<true>(resolve => { session.on('reconnected', () => { resolve(true); }); });

		assert.ok(await raceWithin(2000, back), 'a link that timed out should be reconnected');

		session.close();
		await peer.close();
	});
});

describe('merged delivery report bounds', () => {
	function receipt(smsId: string): Dlr {
		return {
			doneDate: undefined,
			errorCode: undefined,
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

	// Every multipart send registered a group, and only a complete set of receipts ever removed it.
	test('drops the oldest group once the cap is reached', () => {
		const dlrMerger = merger({ max: 2 });

		for (const base of ['first', 'second', 'third']) {
			dlrMerger.expect([`${base}-1`, `${base}-2`]);
		}

		assert.equal(dlrMerger.size, 2);
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
	});
});

describe('option validation', () => {
	test('refuses an interface version that cannot go on the wire', async () => {
		const { err, server: smpp } = await server({ interfaceVersion: 0x100, port: 0 });

		if (smpp) await smpp.close();

		assert.ok(err instanceof Error);
	});

	test('returns an error rather than rejecting on an impossible port', async () => {
		const listening = await server({ port: 70_000 });

		assert.ok(listening.err instanceof Error);

		const connected = await client({ port: 70_000 });

		assert.ok(connected.err instanceof Error);
	});
});
