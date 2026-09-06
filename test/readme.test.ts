import assert from 'node:assert/strict';
import net from 'node:net';
import test, { describe } from 'node:test';
import type { Dlr } from '../src/dlr.ts';
import type { PduObject } from '../src/pdu.ts';
import type { Sms } from '../src/sms.ts';
import type { SmppLog } from '../src/log.ts';
import type { SmppServer } from '../src/server.ts';
import type { TestContext } from 'node:test';
import { PduFramer } from '../src/pdu-framer.ts';
import { PduRefusedError } from '../src/pdu-refusal.ts';
import { Session } from '../src/session.ts';
import { client } from '../src/client.ts';
import { closeAfter, closeListenerAfter } from './teardown.ts';
import { isCommand, objToPdu, pduToObj } from '../src/pdu.ts';
import { server } from '../src/server.ts';

function once<T>(register: (resolve: (value: T) => void) => void): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error('waited 5000 ms for an event that never fired'));
		}, 5000);

		register(value => {
			clearTimeout(timer);
			resolve(value);
		});
	});
}

/** The README's examples listen on the documented default port, so one server runs at a time. */
async function answeringServer(t: TestContext): Promise<SmppServer> {
	const { err, server: smpp } = await server();

	assert.equal(err, undefined);
	assert.ok(smpp);
	closeAfter(t, smpp);

	smpp.on('session', session => {
		session.on('sms', async sms => {
			await sms.sendResp();

			if (sms.dlr) await sms.sendDlr();
		});
	});

	return smpp;
}

describe('README: Client', () => {
	test('the simplest possible client', async t => {
		await answeringServer(t);

		const { err, session } = await client();
		if (err) throw err;

		closeAfter(t, session);

		await session.sendSms({
			from: '46701113311',
			message: 'Hello world',
			to: '46709771337',
		});

		await session.unbind();
	});

	test('with connection parameters, a delivery report and logging', async t => {
		await answeringServer(t);

		const log: SmppLog = {
			debug: () => undefined,
			error: () => undefined,
			info: () => undefined,
			verbose: () => undefined,
			warn: () => undefined,
		};

		const { err, session } = await client({
			host: 'localhost',
			log,
			password: 'bar',
			port: 2775,
			username: 'foo',
		});
		if (err) throw err;

		closeAfter(t, session);

		const reported = once<Dlr>(resolve => { session.on('dlr', resolve); });
		const { err: sendErr, smsIds, unanswered } = await session.sendSms({
			dlr: true,
			from: '46701113311',
			message: '«baff»',
			to: '46709771337',
		});

		assert.equal(sendErr, undefined);
		assert.equal(smsIds.length, 1);
		assert.equal(unanswered, 0);
		assert.equal((await reported).smsId, smsIds[0]);
	});

	test('naming the notation the SMSC writes message ids in', async t => {
		await answeringServer(t);

		const { err, session } = await client({ smsIdFormat: { receipt: 'decimal', submitResp: 'hex' } });
		if (err) throw err;

		closeAfter(t, session);

		const reported = once<Dlr>(resolve => { session.on('dlr', resolve); });
		const { err: sendErr, smsIds } = await session.sendSms({
			dlr: true,
			from: '46701113311',
			message: 'Hello world',
			to: '46709771337',
		});

		assert.equal(sendErr, undefined);
		assert.equal(smsIds.length, 1);
		// The generated ids the server answers with read as no notation, so they arrive untouched.
		assert.equal((await reported).smsId, smsIds[0]);
	});

	test('the documented sending options', async t => {
		const smpp = await answeringServer(t);
		const incoming = once<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});
		const { err, session } = await client();
		if (err) throw err;

		closeAfter(t, session);

		const { signal } = new AbortController();
		const [sms, sent] = await Promise.all([
			incoming,
			session.sendSms({
				dlr: true,
				encoding: 'UCS2',
				flash: false,
				from: 'MyBrand',
				message: 'Hello world',
				scheduleDeliveryTime: new Date(Date.now() + 3600_000),
				to: '46709771337',
				validityPeriod: 3600,
			}, { signal }),
		]);

		assert.equal(sent.err, undefined);
		assert.equal(sms.from, 'MyBrand');
		assert.equal(sms.message, 'Hello world');
	});

	test('receiving an inbound message on a client session', async t => {
		const smpp = await answeringServer(t);
		const bound = once<Session>(resolve => { smpp.on('session', resolve); });
		const { err, session } = await client();
		if (err) throw err;

		closeAfter(t, session);

		const incoming = once<Sms>(resolve => { session.on('sms', resolve); });
		const peer = await bound;

		void peer.send({
			cmdName: 'deliver_sm',
			params: {
				destination_addr: '46709771337',
				short_message: 'inbound hello',
				source_addr: '46701113311',
			},
		});

		const sms = await incoming;

		await sms.sendResp();

		assert.equal(sms.message, 'inbound hello');
	});
});

describe('README: Server', () => {
	test('the simplest possible server', async t => {
		const { err, server: smpp } = await server();
		if (err) throw err;

		closeAfter(t, smpp);

		const received: string[] = [];

		smpp.on('session', session => {
			session.on('sms', async sms => {
				received.push(sms.message);
				await sms.sendResp();
			});
		});

		const { err: clientErr, session } = await client();

		assert.equal(clientErr, undefined);
		assert.ok(session);
		closeAfter(t, session);

		await session.sendSms({ from: '46701113311', message: 'Hello world', to: '46709771337' });
		await session.unbind();

		assert.deepEqual(received, ['Hello world']);
	});

	test('with authentication and delivery reports', async t => {
		const { err, server: smpp } = await server({
			authenticate: ({ password, systemId }) => {
				if (systemId !== 'foo' || password !== 'bar') return false;

				return { userData: { userId: 123 } };
			},
		});
		if (err) throw err;

		closeAfter(t, smpp);

		let answeredOnArrival: boolean | undefined;

		smpp.on('session', session => {
			session.on('sms', async sms => {
				answeredOnArrival = sms.answeredOnArrival;

				if (sms.answeredOnArrival) {
					await sms.sendResp(); // multipart: only releases the shutdown drain
				} else {
					await sms.sendResp(); // ESME_ROK with a generated id
				}

				if (sms.dlr) {
					await sms.sendDlr();
				}
			});
		});

		assert.equal(smpp.port, 2775);

		const refused = await client({ password: 'wrong', username: 'foo' });

		assert.ok(refused.err instanceof Error);

		const { err: clientErr, session } = await client({ password: 'bar', username: 'foo' });

		assert.equal(clientErr, undefined);
		assert.ok(session);
		closeAfter(t, session);

		const reported = once<Dlr>(resolve => { session.on('dlr', resolve); });
		const sent = await session.sendSms({
			dlr: true,
			from: '46701113311',
			message: 'with a receipt',
			to: '46709771337',
		});

		assert.equal(sent.err, undefined);
		assert.equal((await reported).statusMsg, 'DELIVERED');
		assert.equal(answeredOnArrival, false);
	});

	test('refusing a submission at onRequest, before this library would answer it', async t => {
		const knownRecipients = new Set(['46709771337']);
		const accepted: net.Socket[] = [];
		const listener = net.createServer(sock => {
			accepted.push(sock);

			const session = new Session({
				onRequest: async (bound, pduObj) => {
					if (!isCommand(pduObj, 'submit_sm') || knownRecipients.has(pduObj.params.destination_addr)) {
						return false;
					}

					await bound.sendReturn(pduObj, 'ESME_RINVDSTADR');

					return true;
				},
				sock,
			});

			session.linkEnd = 'smsc';
			closeAfter(t, session);
		});

		closeListenerAfter(t, listener, accepted);

		await new Promise<void>(resolve => { listener.listen(0, resolve); });

		const address = listener.address();
		const port = typeof address === 'object' && address !== null ? address.port : 0;
		const peer = net.connect({ port });

		t.after(() => { peer.destroy(); });

		const framer = new PduFramer();
		const refused = once<PduObject>(resolve => {
			peer.on('data', chunk => {
				framer.push(chunk);

				for (const pdu of framer.next().pdus ?? []) {
					const { pduObj } = pduToObj(pdu);

					if (pduObj) resolve(pduObj);
				}
			});
		});

		await once<true>(resolve => { peer.once('connect', () => { resolve(true); }); });

		const { buffer } = objToPdu({
			cmdName: 'submit_sm',
			params: {
				destination_addr: '46700000000',
				short_message: 'Hello world',
				source_addr: '46701113311',
			},
			seqNr: 1,
		});

		assert.ok(buffer);
		peer.write(buffer);

		assert.equal((await refused).cmdStatus, 'ESME_RINVDSTADR');
	});
});

describe('README: Errors', () => {
	test('a refused connection reports err instead of throwing', async () => {
		const { err, session } = await client({ port: 1 });

		assert.ok(err instanceof Error);
		assert.equal(session, undefined);
	});

	test('telling a refused PDU from a session that failed', async t => {
		const smpp = await answeringServer(t);
		const bound = once<Session>(resolve => { smpp.on('session', resolve); });
		const { err, session } = await client();
		if (err) throw err;

		closeAfter(t, session);

		const warned: Record<string, boolean | number | string>[] = [];
		const log: SmppLog = {
			debug: () => undefined,
			error: () => undefined,
			info: () => undefined,
			verbose: () => undefined,
			warn: (msg, metadata) => { warned.push({ msg, ...metadata }); },
		};

		session.on('sessionError', err => {
			if (err instanceof PduRefusedError) {
				log.warn('the peer sent a PDU that could not be read', {
					cmdName: err.header.cmdName ?? err.header.cmdId,
					reason: err.reason,
				});

				return;
			}

			log.error('the session failed', { message: err.message });
		});

		const reported = once<Error>(resolve => { session.on('sessionError', resolve); });
		const peer = await bound;
		const { buffer } = objToPdu({ cmdName: 'enquire_link', seqNr: 5 });

		assert.ok(buffer);
		// A command id no command is defined for: refused on its own, with the link untouched.
		buffer.writeUInt32BE(0x00010001, 4);
		peer.sock.write(buffer);

		await reported;

		assert.deepEqual(warned, [{
			cmdName: 0x00010001,
			msg: 'the peer sent a PDU that could not be read',
			reason: 'command',
		}]);
	});
});
