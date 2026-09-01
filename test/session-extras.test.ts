import assert from 'node:assert/strict';
import net from 'node:net';
import test, { describe } from 'node:test';
import type { Dlr } from '../src/dlr.ts';
import type { ErrorName } from '../src/defs/errors.ts';
import type { MessageState } from '../src/defs/constants.ts';
import type { MessageDlr } from '../src/session.ts';
import type { PduObject, PduObjectInput } from '../src/pdu.ts';
import type { Result } from '../src/result.ts';
import type { SendSmsResult } from '../src/send-sms.ts';
import type { SmppLog } from '../src/log.ts';
import type { Sms } from '../src/sms.ts';
import type { SmppServer } from '../src/server.ts';
import type { TestContext } from 'node:test';
import { HeldMessages } from '../src/held-messages.ts';
import { IncomingRequests } from '../src/incoming-requests.ts';
import { UnansweredError } from '../src/unanswered-error.ts';
import { createSms } from '../src/sms.ts';
import { LinkGate } from '../src/link-gate.ts';
import { Reassembler, decodeSegments } from '../src/reassembly.ts';
import { Session } from '../src/session.ts';
import { DlrMerger } from '../src/dlr-merger.ts';
import { checkSessionOptions } from '../src/session-options.ts';
import { client } from '../src/client.ts';
import { closeAfter, closeListenerAfter } from './teardown.ts';
import { consts } from '../src/defs/constants.ts';
import { errors } from '../src/defs/errors.ts';
import { objToPdu } from '../src/pdu.ts';
import { paramText } from '../src/defs/types.ts';
import { server } from '../src/server.ts';
import { silentLog } from '../src/log.ts';
import { submitSms } from '../src/send-sms.ts';

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

/** An event that never fires would otherwise block until the CI job limit, asserting nothing. */
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

function delay(ms: number): Promise<void> {
	return new Promise(resolve => { setTimeout(resolve, ms); });
}

function submitPdu(seqNr: number, cmdStatus: ErrorName = 'ESME_ROK'): PduObject {
	return {
		cmdId: 0x00000004,
		cmdLength: 0,
		cmdName: 'submit_sm',
		cmdStatus,
		cmdStatusId: 0,
		params: { destination_addr: '46709771337', short_message: 'held', source_addr: '46701113311' },
		seqNr,
		tlvs: {},
	};
}

/** A cmd_length below the 16-octet header: a stream no framing can recover from. */
const unreadablePdu = Buffer.from([0, 0, 0, 4, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 1]);

/** The server's side of the one connection under test. */
function peerOf(smpp: SmppServer): Session {
	const [peer] = smpp.sessions;

	assert.equal(smpp.sessions.size, 1);
	assert.ok(peer);

	return peer;
}

async function sendReceipt(peer: Session, smsId: string, tlvSmsId = smsId): Promise<void> {
	const sent = await peer.send({
		cmdName: 'deliver_sm',
		params: {
			destination_addr: '46701113311',
			esm_class: consts.ESM_CLASS.MC_DELIVERY_RECEIPT,
			short_message: `id:${smsId} stat:DELIVRD err:000 text:`,
			source_addr: '46709771337',
		},
		tlvs: {
			message_state: { tagValue: consts.MESSAGE_STATE.DELIVERED },
			receipted_message_id: { tagValue: tlvSmsId },
		},
	});

	assert.equal(sent.err, undefined);
}

type Latch = { open: () => void; passed: Promise<true> };

/** A promise the test opens by hand, guarded by once() against waiting on one it never does. */
function latch(): Latch {
	const opener: { open?: () => void } = {};
	const passed = once<true>(resolve => { opener.open = () => { resolve(true); }; });

	return { open: () => opener.open?.(), passed };
}

describe('merged delivery reports', () => {
	// 0.4.0 allocated a longSmsDlrs store to do exactly this and then never used it.
	test('reports once on a whole multipart message', async t => {
		const smpp = await startServer(t);
		const incoming = once<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});
		const { session } = await connect(t, smpp);

		assert.ok(session);

		const merged = once<MessageDlr>(resolve => { session.on('messageDlr', resolve); });
		const perSegment: string[] = [];

		session.on('dlr', dlr => perSegment.push(dlr.smsId ?? ''));

		const [sms] = await Promise.all([
			incoming.then(async received => {
				await received.sendResp({ smsId: 'merge-me' });

				return received;
			}),
			session.sendSms({
				dlr: true,
				from: '46701113311',
				message: 'x'.repeat(400),
				to: '46709771337',
			}),
		]);

		await sms.sendDlr();

		const report = await merged;

		assert.equal(report.smsId, 'merge-me');
		assert.equal(report.segments.length, 3);
		assert.equal(report.statusMsg, 'DELIVERED');
		assert.deepEqual(perSegment, ['merge-me-1', 'merge-me-2', 'merge-me-3']);
	});

	test('reports the worst status across the segments', async t => {
		const smpp = await startServer(t);
		const incoming = once<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});
		const { session } = await connect(t, smpp);

		assert.ok(session);

		const merged = once<MessageDlr>(resolve => { session.on('messageDlr', resolve); });

		const [sms] = await Promise.all([
			incoming.then(async received => {
				await received.sendResp({ smsId: 'partly-failed' });

				return received;
			}),
			session.sendSms({
				dlr: true,
				from: '46701113311',
				message: 'x'.repeat(400),
				to: '46709771337',
			}),
		]);

		await sms.sendDlr('UNDELIVERABLE');

		const report = await merged;

		assert.equal(report.statusMsg, 'UNDELIVERABLE');
		assert.equal(report.segments.length, 3);
	});
});

describe('merging segment statuses', () => {
	function receipt(smsId: string, statusMsg: MessageState): Dlr {
		return {
			doneDate: undefined,
			errorCode: undefined,
			receipt: undefined,
			smsId,
			statusId: consts.MESSAGE_STATE[statusMsg],
			statusMsg,
		};
	}

	// MESSAGE_STATE is a flat enum: ACCEPTED is 6 where UNDELIVERABLE is 5, so reducing on the
	// wire value called a part-failed message delivered.
	test('reports the worse of two states the wire numbers the other way round', () => {
		const merger = new DlrMerger({ log: silentLog, max: 10, now: () => 0, timeout: 60_000 });

		merger.expect(['msg-1', 'msg-2']);

		assert.equal(merger.collect(receipt('msg-1', 'UNDELIVERABLE')), undefined);

		const merged = merger.collect(receipt('msg-2', 'ACCEPTED'));

		assert.ok(merged);
		assert.equal(merged.statusMsg, 'UNDELIVERABLE');
	});
});

describe('sendSms()', () => {
	function submitResp(seqNr: number, messageId: string, status: ErrorName = 'ESME_ROK'): PduObject {
		return {
			cmdId: 0x80000004,
			cmdLength: 0,
			cmdName: 'submit_sm_resp',
			cmdStatus: status,
			cmdStatusId: errors[status],
			params: { message_id: messageId },
			seqNr,
			tlvs: {},
		};
	}

	/** Three segments, each answered by whatever the caller decides for that part. */
	function sendSegments(
		answer: (part: number) => Result<{ pduObj: PduObject }>,
	): Promise<SendSmsResult> {
		let part = 0;

		return submitSms(
			{
				log: silentLog,
				reference: 7,
				send: () => {
					part++;

					return Promise.resolve(answer(part));
				},
			},
			{ from: '46701113311', message: 'x'.repeat(400), to: '46709771337' },
		);
	}

	test('reports a submit_sm the peer refused instead of an empty message id', async t => {
		const smpp = await startServer(t);
		const incoming = once<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});
		const { session } = await connect(t, smpp);

		assert.ok(session);

		const [, sent] = await Promise.all([
			incoming.then(received => received.sendResp({ status: 'ESME_RMSGQFUL' })),
			session.sendSms({ from: '46701113311', message: 'the queue is full', to: '46709771337' }),
		]);

		assert.ok(sent.err instanceof Error);
		assert.match(sent.err.message, /ESME_RMSGQFUL/);
	});

	// A retry that repeats the segments the SMSC already took bills the recipient twice.
	test('hands back the ids that landed when a segment fails', async () => {
		const refused = await sendSegments(part => part === 2
			? { pduObj: submitResp(part, '', 'ESME_RMSGQFUL') }
			: { pduObj: submitResp(part, `landed-${String(part)}`) });

		assert.ok(refused.err instanceof Error);
		assert.match(refused.err.message, /ESME_RMSGQFUL/);
		assert.equal(refused.pduObjs.length, 2);
		assert.deepEqual(refused.smsIds, ['landed-1', 'landed-3']);

		const unanswered = await sendSegments(part => part === 2
			? { err: new Error('No response to seqNr 2') }
			: { pduObj: submitResp(part, `landed-${String(part)}`) });

		assert.ok(unanswered.err instanceof Error);
		assert.deepEqual(unanswered.smsIds, ['landed-1', 'landed-3']);
	});

	test('refuses a message needing more segments than a UDH can number', async () => {
		const attempts: PduObjectInput[] = [];
		const sent = await submitSms(
			{
				log: silentLog,
				reference: 1,
				send: input => {
					attempts.push(input);

					return Promise.resolve({ err: new Error('nothing should reach the wire') });
				},
			},
			{ from: '46701113311', message: 'a'.repeat(153 * 256), to: '46709771337' },
		);

		assert.ok(sent.err instanceof Error);
		assert.equal(attempts.length, 0);
	});

	// Most handsets and SMSCs stop well short of the 255 a UDH can number.
	test('refuses a message needing more segments than the caller allows', async () => {
		const attempts: PduObjectInput[] = [];
		const deps = {
			log: silentLog,
			reference: 3,
			send: (input: PduObjectInput) => {
				attempts.push(input);

				return Promise.resolve({ pduObj: submitResp(attempts.length, `landed-${String(attempts.length)}`) });
			},
		};
		const message = 'a'.repeat(153 * 4);

		const refused = await submitSms(deps, { from: '46701113311', maxSegments: 3, message, to: '46709771337' });

		assert.ok(refused.err instanceof Error);
		assert.equal(attempts.length, 0);

		const sent = await submitSms(deps, { from: '46701113311', maxSegments: 4, message, to: '46709771337' });

		assert.equal(sent.err, undefined);
		assert.equal(attempts.length, 4);
	});
});

describe('reconnect', () => {
	test('re-binds after a drop with nothing asked for, since it is the default', async t => {
		const smpp = await startServer(t);
		const { session } = await connect(t, smpp);

		assert.ok(session);

		const reconnected = once<true>(resolve => { session.on('reconnected', () => { resolve(true); }); });

		const dropped = session.sock;

		await peerOf(smpp).close();
		await reconnected;

		assert.notEqual(session.sock, dropped, 'the session should be live on a fresh socket');
	});

	test('reports a drop it will retry as disconnected, keeping close for the end', async t => {
		const smpp = await startServer(t);
		const { session } = await connect(t, smpp, { reconnect: { maxDelay: 100, minDelay: 20 } });

		assert.ok(session);

		const events: string[] = [];

		session.on('close', () => { events.push('close'); });
		session.on('disconnected', () => { events.push('disconnected'); });

		const reconnected = once<true>(resolve => { session.on('reconnected', () => { resolve(true); }); });

		await peerOf(smpp).close();
		await reconnected;

		assert.deepEqual(events, ['disconnected'], 'a link the loop brings back is not the end');

		await session.close();

		assert.deepEqual(events, ['disconnected', 'close']);
	});

	test('emits close when the session ends while the link is still down', async t => {
		const smpp = await startServer(t);
		const { session } = await connect(t, smpp);

		assert.ok(session);

		const events: string[] = [];

		session.on('close', () => { events.push('close'); });
		session.on('disconnected', () => { events.push('disconnected'); });

		const down = once<true>(resolve => { session.on('disconnected', () => { resolve(true); }); });

		await peerOf(smpp).close();
		await down;
		await session.close();

		assert.deepEqual(events, ['disconnected', 'close']);

		await session.close();

		assert.deepEqual(events, ['disconnected', 'close'], 'closing twice is still one close');
	});

	test('re-binds after a stream it cannot read, rather than ending the session', async t => {
		const smpp = await startServer(t);
		const { session } = await connect(t, smpp, { reconnect: { maxDelay: 100, minDelay: 20 } });

		assert.ok(session);

		const events: string[] = [];

		session.on('close', () => { events.push('close'); });
		session.on('sessionError', () => { events.push('sessionError'); });

		const reconnected = once<true>(resolve => { session.on('reconnected', () => { resolve(true); }); });

		peerOf(smpp).sock.write(unreadablePdu);
		await reconnected;

		assert.deepEqual(events, ['sessionError']);
	});

	test('refuses a backoff that would retry without pausing', () => {
		assert.match(checkSessionOptions({ reconnect: { minDelay: 0 } }).err?.message ?? '', /minDelay/);
		assert.match(checkSessionOptions({ reconnect: { maxDelay: -1 } }).err?.message ?? '', /maxDelay/);
		assert.match(
			checkSessionOptions({ reconnect: null }).err?.message ?? '',
			/false/,
			'off is spelled false, so nothing else may stand in for it',
		);
		assert.match(
			checkSessionOptions({ reconnect: { maxDelay: 1000, minDelay: 30_000 } }).err?.message ?? '',
			/maxDelay/,
			'a transposed pair asks to never retry faster than 30 s and gets one every second',
		);
		assert.match(checkSessionOptions({ reconnect: { minDelayMs: 20 } }).err?.message ?? '', /minDelayMs/);
		assert.equal(checkSessionOptions({ reconnect: false }).err, undefined);
		assert.equal(checkSessionOptions({ reconnect: { maxDelay: 60_000, minDelay: 500 } }).err, undefined);
	});

	test('reports a drop as close, and schedules nothing, when reconnect is false', async t => {
		const smpp = await startServer(t);
		const noop = (): void => undefined;
		const infos: string[] = [];
		const log: SmppLog = {
			debug: noop,
			error: noop,
			info: msg => { infos.push(msg); },
			verbose: noop,
			warn: noop,
		};
		const { session } = await connect(t, smpp, { log, reconnect: false });

		assert.ok(session);

		let disconnects = 0;

		session.on('disconnected', () => { disconnects++; });

		const closed = once<true>(resolve => { session.on('close', () => { resolve(true); }); });

		peerOf(smpp).sock.write(unreadablePdu);
		await closed;

		assert.equal(disconnects, 0);
		assert.ok(!infos.includes('reconnect - retrying after a drop'));
	});

	test('re-binds after the connection drops, keeping the same session object', async t => {
		const smpp = await startServer(t);
		const messages: string[] = [];

		// Registered up front so the session created by the reconnect is covered too.
		smpp.on('session', bound => {
			bound.on('sms', sms => {
				messages.push(sms.message);
				void sms.sendResp();
			});
		});

		const { err, session } = await connect(t, smpp, { reconnect: { maxDelay: 100, minDelay: 20 } });

		assert.equal(err, undefined);
		assert.ok(session);

		const reconnected = once<true>(resolve => { session.on('reconnected', () => { resolve(true); }); });
		const halfPdu = once<true>(resolve => { session.on('data', () => { resolve(true); }); });

		// A PDU header promising 32 octets and sending 8: the next link must not continue it.
		peerOf(smpp).sock.write(Buffer.from([0, 0, 0, 32, 0, 0, 0, 4]));
		await halfPdu;

		// Drop the connection from the server's side, as a peer restart would.
		for (const serverSession of smpp.sessions) {
			await serverSession.close();
		}

		await reconnected;

		assert.ok(session.loggedIn);

		// The session object survives the drop, so listeners stay attached and it is usable again.
		const sent = await session.sendSms({
			from: '46701113311',
			message: 'after reconnect',
			to: '46709771337',
		});

		assert.equal(sent.err, undefined);
		assert.deepEqual(messages, ['after reconnect']);
	});

	test('merges the receipts of a multipart message across a drop', async t => {
		const smpp = await startServer(t);

		smpp.on('session', bound => {
			bound.on('sms', sms => { void sms.sendResp({ smsId: 'across-the-drop' }); });
		});

		const { session } = await connect(t, smpp, { reconnect: { maxDelay: 100, minDelay: 20 } });

		assert.ok(session);

		const sent = await session.sendSms({
			dlr: true,
			from: '46701113311',
			message: 'x'.repeat(400),
			to: '46709771337',
		});

		assert.deepEqual(sent.smsIds, ['across-the-drop-1', 'across-the-drop-2', 'across-the-drop-3']);

		// Answered on the link that then drops, so an SMSC has no reason to ever send it again.
		await sendReceipt(peerOf(smpp), 'across-the-drop-1');

		const reconnected = once<true>(resolve => { session.on('reconnected', () => { resolve(true); }); });

		await peerOf(smpp).close();
		await reconnected;

		const merged = once<MessageDlr>(resolve => { session.on('messageDlr', resolve); });

		await sendReceipt(peerOf(smpp), 'across-the-drop-2');
		await sendReceipt(peerOf(smpp), 'across-the-drop-3');

		const report = await merged;

		assert.equal(report.smsId, 'across-the-drop');
		assert.equal(report.segments.length, 3);
	});

	test('refuses to answer a message whose link went, held or already answered', async t => {
		const smpp = await startServer(t);
		const { session } = await connect(t, smpp, { reconnect: { maxDelay: 100, minDelay: 20 } });

		assert.ok(session);

		const arrived: Sms[] = [];
		const both = once<true>(resolve => {
			session.on('sms', sms => {
				arrived.push(sms);

				if (arrived.length === 2) resolve(true);
			});
		});

		for (const text of ['answered before the drop', 'never answered']) {
			void peerOf(smpp).send({
				cmdName: 'deliver_sm',
				params: {
					destination_addr: '46701113311',
					short_message: text,
					source_addr: '46709771337',
				},
			});
		}

		await both;

		const [answered, held] = arrived;

		assert.ok(answered);
		assert.ok(held);
		assert.equal(answered.message, 'answered before the drop');
		assert.equal((await answered.sendResp()).err, undefined);

		const reconnected = once<true>(resolve => { session.on('reconnected', () => { resolve(true); }); });

		await peerOf(smpp).close({ signal: AbortSignal.abort() });
		await reconnected;

		let taken = 0;

		// A response is dispatched before `incomingPduObj`, so only the raw event sees one arrive.
		peerOf(smpp).on('incomingPdu', () => { taken++; });

		// The answered one is out of the hold and the held one is not, so neither may reach the answer.
		assert.match((await answered.sendResp()).err?.message ?? '', /link this message arrived on is gone/);
		assert.match((await held.sendResp()).err?.message ?? '', /link this message arrived on is gone/);

		assert.equal((await held.sendDlr('DELIVERED')).err, undefined);
		assert.equal(taken, 1, 'a refused response reached the new link');
	});

	test('drops a message whose link went while onRequest was still running', async t => {
		const session = new Session({ sock: new net.Socket() });

		closeAfter(t, session);
		session.boundAs = 'transceiver';

		const incoming = new IncomingRequests({
			dlrMerger: new DlrMerger({ log: silentLog, max: 10, timeout: 10_000 }),
			log: silentLog,
			onRequest: async () => { await delay(10); return false; },
			sendPastDrain: () => Promise.resolve({ err: new Error('never sent') }),
			session,
		});
		let messages = 0;

		session.on('sms', () => { messages++; });

		const handled = incoming.handle(submitPdu(1));

		incoming.clear();

		await handled;

		assert.equal(messages, 0);
	});

	test('does not reconnect after an explicit close', async t => {
		const smpp = await startServer(t);
		const { session } = await connect(t, smpp, { reconnect: { maxDelay: 50, minDelay: 10 } });

		assert.ok(session);

		let reconnects = 0;

		session.on('reconnected', () => { reconnects++; });
		await session.close();

		await delay(150);

		assert.equal(reconnects, 0);
	});
});

describe('sends across a reconnect', () => {
	/** Answers every message after the first, which is left to hold the send window open. */
	function answerAfterTheFirst(smpp: SmppServer, arrived: string[]): Latch {
		const first = latch();

		smpp.on('session', peer => {
			peer.on('sms', async sms => {
				arrived.push(sms.message);

				if (arrived.length === 1) first.open();
				else await sms.sendResp();
			});
		});

		return first;
	}

	test('holds a send issued while the link is down and puts it on the new link', async t => {
		const smpp = await startServer(t);
		const arrived: string[] = [];

		smpp.on('session', peer => { peer.on('sms', async sms => { arrived.push(sms.message); await sms.sendResp(); }); });

		const { session } = await connect(t, smpp, { reconnect: { maxDelay: 100, minDelay: 20 } });

		assert.ok(session);

		const down = once<true>(resolve => { session.on('disconnected', () => { resolve(true); }); });

		await peerOf(smpp).close();
		await down;

		const sent = await session.sendSms({ from: '46701113311', message: 'held', to: '46709771337' });

		assert.equal(sent.err, undefined);
		assert.equal(sent.smsIds.length, 1);
		assert.equal(sent.unanswered, 0);
		assert.deepEqual(arrived, ['held']);
	});

	test('puts a segment still queued behind a full window on the new link', async t => {
		const smpp = await startServer(t);
		const arrived: string[] = [];
		const first = answerAfterTheFirst(smpp, arrived);
		const { session } = await connect(t, smpp, {
			maxOutstanding: 1,
			reconnect: { maxDelay: 100, minDelay: 20 },
		});

		assert.ok(session);

		const holding = session.sendSms({ from: '46701113311', message: 'first', to: '46709771337' });

		await first.passed;

		const queued = session.sendSms({ from: '46701113311', message: 'second', to: '46709771337' });

		peerOf(smpp).sock.destroy();

		const [dropped, resent] = await Promise.all([holding, queued]);

		assert.equal(dropped.unanswered, 1);
		assert.equal(resent.err, undefined, 'a request that never reached the socket is not lost with it');
		assert.equal(resent.smsIds.length, 1);
		assert.deepEqual(arrived, ['first', 'second']);
	});

	test('holds a send issued while the rebind is still binding', async t => {
		const binding = latch();
		const release = latch();
		let binds = 0;
		const smpp = await startServer(t, {
			authenticate: async () => {
				binds++;

				if (binds > 1) {
					binding.open();
					await release.passed;
				}

				return true;
			},
		});

		smpp.on('session', peer => { peer.on('sms', async sms => { await sms.sendResp(); }); });

		const { session } = await connect(t, smpp, { reconnect: { maxDelay: 100, minDelay: 20 } });

		assert.ok(session);

		peerOf(smpp).sock.destroy();

		// The fresh socket is attached and the bind is in flight, so the link exists but carries nothing.
		await binding.passed;

		const sending = session.sendSms({ from: '46701113311', message: 'mid-bind', to: '46709771337' });
		let settled = false;

		void sending.then(() => { settled = true; });
		await delay(30);

		assert.equal(settled, false, 'an unbound link must not take a submit_sm that would be refused');

		release.open();

		const sent = await sending;

		assert.equal(sent.err, undefined);
		assert.equal(sent.smsIds.length, 1);
	});

	test('counts a segment the peer never answered in time as unanswered', async t => {
		const smpp = await startServer(t);

		smpp.on('session', peer => { peer.on('sms', () => undefined); });

		const { session } = await connect(t, smpp, { responseTimeout: 200 });

		assert.ok(session);

		const sent = await session.sendSms({ from: '46701113311', message: 'no answer', to: '46709771337' });

		assert.match(sent.err?.message ?? '', /may have accepted/);
		assert.equal(sent.unanswered, 1, 'a slow SMSC may still have taken it');
	});

	test('counts a segment aborted after it went out as unanswered', async t => {
		const smpp = await startServer(t);
		const arrived = once<Sms>(resolve => { smpp.on('session', peer => peer.on('sms', resolve)); });
		const { session } = await connect(t, smpp);

		assert.ok(session);

		const controller = new AbortController();
		const sending = session.sendSms(
			{ from: '46701113311', message: 'aborted mid-flight', to: '46709771337' },
			{ signal: controller.signal },
		);

		await arrived;
		controller.abort();

		const sent = await sending;

		assert.match(sent.err?.message ?? '', /may have accepted/);
		assert.equal(sent.unanswered, 1, 'the abort is ours; the peer still holds the request');
	});

	test('reports a segment the link dropped under as unanswered, not as never sent', async t => {
		const smpp = await startServer(t);
		const arrived = once<Sms>(resolve => { smpp.on('session', peer => peer.on('sms', resolve)); });
		const { session } = await connect(t, smpp, { reconnect: false });

		assert.ok(session);

		const sending = session.sendSms({ from: '46701113311', message: 'in flight', to: '46709771337' });

		await arrived;
		peerOf(smpp).sock.destroy();

		const sent = await sending;

		assert.match(sent.err?.message ?? '', /may have accepted/);
		assert.equal(sent.unanswered, 1, 'the peer may have accepted it, so sending it again would duplicate');
		assert.deepEqual(sent.smsIds, []);
	});

	test('gives up a held send after responseTimeout, with nothing put on the wire', async t => {
		const smpp = await startServer(t);
		const { session } = await connect(t, smpp, {
			reconnect: { maxDelay: 10_000, minDelay: 10_000 },
			responseTimeout: 200,
		});

		assert.ok(session);

		const down = once<true>(resolve => { session.on('disconnected', () => { resolve(true); }); });

		await peerOf(smpp).close();
		await down;

		const sent = await session.sendSms({ from: '46701113311', message: 'held', to: '46709771337' });

		assert.match(sent.err?.message ?? '', /did not come back/);
		assert.equal(sent.unanswered, 0, 'nothing reached the peer, so the message can be sent again');
	});

	test('fails a held send when the session closes rather than leaving it waiting', async t => {
		const smpp = await startServer(t);
		const { session } = await connect(t, smpp, {
			reconnect: { maxDelay: 10_000, minDelay: 10_000 },
		});

		assert.ok(session);

		const down = once<true>(resolve => { session.on('disconnected', () => { resolve(true); }); });

		await peerOf(smpp).close();
		await down;

		const sending = session.sendSms({ from: '46701113311', message: 'held', to: '46709771337' });
		let settled = false;

		void sending.then(() => { settled = true; });
		await delay(30);

		assert.equal(settled, false, 'the send waits for a link rather than failing on the spot');

		await session.close();

		const sent = await sending;

		assert.match(sent.err?.message ?? '', /closed/);
		assert.equal(sent.unanswered, 0);
	});

	test('aborts a held send instead of making it wait out the link', async t => {
		const smpp = await startServer(t);
		const { session } = await connect(t, smpp, {
			reconnect: { maxDelay: 10_000, minDelay: 10_000 },
		});

		assert.ok(session);

		const down = once<true>(resolve => { session.on('disconnected', () => { resolve(true); }); });

		await peerOf(smpp).close();
		await down;

		const controller = new AbortController();
		const sending = session.sendSms(
			{ from: '46701113311', message: 'held', to: '46709771337' },
			{ signal: controller.signal },
		);

		controller.abort();

		const sent = await sending;

		assert.match(sent.err?.message ?? '', /Aborted while waiting for a link/);
		assert.equal(sent.unanswered, 0);
	});

	test('refuses a send outright once the session is over', async t => {
		const smpp = await startServer(t);
		const { session } = await connect(t, smpp, { reconnect: false });

		assert.ok(session);
		await session.close();

		const sent = await session.sendSms({ from: '46701113311', message: 'too late', to: '46709771337' });

		assert.match(sent.err?.message ?? '', /closed/);
		assert.equal(sent.unanswered, 0);
	});
});

describe('LinkGate', () => {
	test('refuses a hold whose deadline has already passed', async () => {
		let now = 0;
		const gate = new LinkGate({ log: silentLog, now: () => now, timeout: 100 });
		const waitForLink = gate.hold(undefined);

		gate.shut(true);
		now = 101;

		const held = await waitForLink();

		assert.match(held.err?.message ?? '', /did not come back in time/);
	});

	test('holds on a timer that keeps the process alive', async () => {
		const gate = new LinkGate({ log: silentLog, timeout: 10_000 });
		const timers = (): number => process.getActiveResourcesInfo().filter(name => name === 'Timeout').length;

		gate.shut(true);

		const before = timers();
		const held = gate.hold(undefined)();

		assert.equal(timers(), before + 1, 'an unref\'d timer is not counted here, which is the point');

		gate.open();

		assert.deepEqual(await held, {});
	});

	// addEventListener never fires for a signal that already aborted, so it would wait out the timeout.
	test('gives up at once on a signal that was already aborted', async () => {
		const gate = new LinkGate({ log: silentLog, timeout: 100 });

		gate.shut(true);

		const held = await gate.hold(AbortSignal.abort())();

		assert.match(held.err?.message ?? '', /Aborted while waiting for a link/);
	});
});

// Goal 4: an application that answers nothing must not grow this for the life of the link.
describe('held message bounds', () => {
	function message(seqNr: number): PduObject[] {
		return [submitPdu(seqNr)];
	}

	test('drops the message held longest rather than holding every one', () => {
		const held = new HeldMessages({ log: silentLog, max: 2, timeout: 10_000 });
		const oldest = message(1);

		held.hold(oldest);
		held.hold(message(2));
		held.hold(message(2));

		assert.equal(held.size, 2, 'a re-used sequence number replaces rather than evicting');
		assert.equal(held.has(oldest), true);

		held.hold(message(3));

		assert.equal(held.size, 2);
		assert.equal(held.has(oldest), false);

		held.clear();
	});

	test('gives up on a message the application never answers', () => {
		let now = 0;
		const held = new HeldMessages({ log: silentLog, max: 10, now: () => now, timeout: 60 });

		held.hold(message(1));
		now = 61;

		// The next message sweeps the one that expired, so only the new one is still waited for.
		held.hold(message(2));

		assert.equal(held.size, 1);

		held.clear();
	});

	// Without this the drain sits out its whole budget before returning what a sweep already settled.
	test('wakes a waiting drain when the last message expires', async () => {
		let now = 0;
		const held = new HeldMessages({ log: silentLog, max: 10, now: () => now, timeout: 60 });

		held.hold(message(1));

		const waiting = held.idle(1000, undefined);

		now = 61;
		held.sweep();

		assert.equal(await waiting, 0);
	});
});

describe('sendDlr()', () => {
	// A receipt cannot be resent wholesale without duplicating the segments that landed.
	test('names the segments the peer took, refused, and may have taken', async t => {
		const session = new Session({ sock: new net.Socket() });

		closeAfter(t, session);

		let call = 0;
		const sms = createSms({
			from: '46701113311',
			message: 'three segments',
			pduObjs: [submitPdu(1), submitPdu(2), submitPdu(3)],
			session,
			to: '46709771337',
		}, {
			lostLink: () => false,
			onAnswered: () => undefined,
			send: () => {
				call++;

				if (call === 1) return Promise.resolve({ pduObj: submitPdu(1, 'ESME_RX_T_APPN') });

				if (call === 2) {
					return Promise.resolve({ err: new UnansweredError(new Error('nothing came back')) });
				}

				return Promise.resolve({ pduObj: submitPdu(3) });
			},
		});
		const report = await sms.sendDlr('DELIVERED');

		assert.ok(report.err instanceof Error);
		assert.match(report.err.message, /deliver_sm refused by the peer/);
		assert.equal(report.pduObjs.length, 1);
		assert.equal(report.unanswered, 1);
	});
});

describe('reassembly bounds', () => {
	function segment(reference: number, part: number, total: number): PduObject {
		const udh = Buffer.from([0x05, 0x00, 0x03, reference, total, part]);

		return {
			cmdId: 0x00000004,
			cmdLength: 0,
			cmdName: 'submit_sm',
			cmdStatus: 'ESME_ROK',
			cmdStatusId: 0,
			params: {
				data_coding: 0,
				destination_addr: '46709771337',
				esm_class: 0x40,
				short_message: Buffer.concat([udh, Buffer.from('fragment')]),
				source_addr: '46701113311',
			},
			seqNr: part,
			tlvs: {},
		};
	}

	function collect(
		reassembler: Reassembler,
		reference: number,
		part: number,
		total: number,
	): PduObject[] | undefined {
		return reassembler.collect(segment(reference, part, total), { part, reference, total });
	}

	test('hands back every segment in order once the last one arrives', () => {
		const reassembler = new Reassembler({ log: silentLog, max: 10, now: () => 0, timeout: 60_000 });

		assert.equal(collect(reassembler, 4, 2, 3), undefined);
		assert.equal(collect(reassembler, 4, 3, 3), undefined);

		const whole = collect(reassembler, 4, 1, 3);

		assert.ok(whole);
		assert.deepEqual(whole.map(pduObj => pduObj.seqNr), [1, 2, 3]);
		assert.equal(reassembler.size, 0);
	});

	// The UDH is peer-controlled, and the default authenticate() accepts every peer.
	test('refuses a segment whose concatenation metadata cannot be honoured', () => {
		const warnings: string[] = [];
		const noop = (): void => undefined;
		const log: SmppLog = {
			debug: noop,
			error: noop,
			info: noop,
			verbose: noop,
			warn: msg => { warnings.push(msg); },
		};
		const reassembler = new Reassembler({ log, max: 10, now: () => 0, timeout: 60_000 });

		assert.equal(collect(reassembler, 1, 1, 0), undefined);
		assert.equal(collect(reassembler, 2, 0, 3), undefined);
		assert.equal(collect(reassembler, 3, 4, 3), undefined);
		assert.equal(reassembler.size, 0);
		assert.deepEqual(warnings, Array(3).fill('reassembler - dropping a segment the UDH numbers impossibly'));
	});

	// Parts 1/2 then 2/3 would otherwise complete the stored two-part group, truncating the message.
	test('refuses a segment that renumbers how many parts the message has', () => {
		const reassembler = new Reassembler({ log: silentLog, max: 10, now: () => 0, timeout: 60_000 });

		assert.equal(collect(reassembler, 9, 1, 2), undefined);
		assert.equal(collect(reassembler, 9, 2, 3), undefined);
		assert.equal(reassembler.size, 1);

		reassembler.clear();
	});

	// 0.4.0 held incomplete groups without limit and swept them only when other traffic arrived.
	test('drops the oldest incomplete message once the cap is reached', () => {
		const reassembler = new Reassembler({ log: silentLog, max: 2, now: () => 0, timeout: 60_000 });

		for (const reference of [1, 2, 3]) {
			assert.equal(collect(reassembler, reference, 1, 2), undefined);
		}

		// Completing the first one must not produce a message: it was evicted.
		assert.equal(collect(reassembler, 1, 2, 2), undefined);
		assert.equal(reassembler.size, 2);

		reassembler.clear();
	});

	test('drops the oldest incomplete message once the retained octets exceed the cap', () => {
		const reassembler = new Reassembler({
			log: silentLog,
			max: 10,
			// One segment is 36 octets: 14 of short_message plus the two 11-octet addresses.
			maxOctets: 80,
			now: () => 0,
			timeout: 60_000,
		});

		for (const reference of [1, 2, 3]) {
			assert.equal(collect(reassembler, reference, 1, 2), undefined);
		}

		assert.equal(reassembler.size, 2);
		assert.equal(collect(reassembler, 1, 2, 2), undefined);

		reassembler.clear();
	});

	// A retained subarray keeps its whole framed PDU alive, up to maxPduLength per segment.
	test('copies a segment out of the buffer it arrived in', () => {
		const reassembler = new Reassembler({ log: silentLog, max: 10, now: () => 0, timeout: 60_000 });
		const framed = Buffer.alloc(1024);
		const first = segment(6, 1, 2);

		Buffer.concat([Buffer.from([0x05, 0x00, 0x03, 6, 2, 1]), Buffer.from('fragment')]).copy(framed);
		first.params.short_message = framed.subarray(0, 14);

		assert.equal(reassembler.collect(first, { part: 1, reference: 6, total: 2 }), undefined);

		framed.fill(0x00);

		const whole = collect(reassembler, 6, 2, 2);

		assert.ok(whole);
		assert.equal(decodeSegments(whole), 'fragmentfragment');
	});

	test('expires an incomplete message once its timeout has passed', () => {
		let now = 0;
		const reassembler = new Reassembler({ log: silentLog, max: 10, now: () => now, timeout: 60 });

		assert.equal(collect(reassembler, 9, 1, 2), undefined);

		now = 61;

		// The other half arrives after the group expired, so it starts a new, still-incomplete one.
		assert.equal(collect(reassembler, 9, 2, 2), undefined);
		assert.equal(reassembler.size, 1);

		reassembler.clear();
	});
});

describe('AbortSignal on a send', () => {
	test('gives up on an in-flight request when the signal fires', async t => {
		const accepted: net.Socket[] = [];
		const silent = net.createServer(sock => {
			accepted.push(sock);
			sock.resume();
			// Answer the bind so the client gets a session, then go quiet.
			sock.write(Buffer.from('0000001180000009000000000000000100', 'hex'));
		});

		await new Promise<void>(resolve => silent.listen(0, resolve));
		closeListenerAfter(t, silent, accepted);

		const address = silent.address();
		const port = typeof address === 'object' && address !== null ? address.port : 0;
		const { err, session } = await client({ port, responseTimeout: 10_000 });

		assert.equal(err, undefined);
		assert.ok(session);
		closeAfter(t, session);

		const controller = new AbortController();

		setTimeout(() => { controller.abort(); }, 50);

		const sent = await session.sendSms(
			{ from: '46701113311', message: 'never answered', to: '46709771337' },
			{ signal: controller.signal },
		);

		assert.ok(sent.err instanceof Error);
	});
});

describe('graceful shutdown', () => {
	async function submitInFlight(
		t: TestContext,
		options: Parameters<typeof client>[0] = {},
		serverOptions: Parameters<typeof server>[0] = {},
		message = 'answer me',
	) {
		const smpp = await startServer(t, serverOptions);
		const incoming = once<Sms>(resolve => {
			smpp.on('session', bound => bound.on('sms', resolve));
		});
		const { session } = await connect(t, smpp, options);

		assert.ok(session);

		const sent = session.sendSms({ from: '46701113311', message, to: '46709771337' });

		return { sent, session, sms: await incoming, smpp };
	}

	test('close() waits out a submit already on the wire and refuses new ones', async t => {
		const { sent, session, sms } = await submitInFlight(t);
		const closed = session.close();
		const refused = await session.sendSms({
			from: '46701113311',
			message: 'too late',
			to: '46709771337',
		});

		assert.ok(refused.err instanceof Error);
		assert.equal(refused.err.message, 'Session is shutting down');

		await sms.sendResp({ smsId: 'answered-while-draining' });

		assert.deepEqual((await sent).smsIds, ['answered-while-draining']);
		assert.deepEqual(await closed, {});
	});

	// The drain refuses sends; a response was never a send, and saying so is the more useful answer.
	test('names a response put through send() as the misuse it is, even mid-shutdown', async t => {
		const { sent, session, sms } = await submitInFlight(t);
		const closing = session.close();
		const refused = await session.send({ cmdName: 'submit_sm_resp' });

		assert.ok(refused.err instanceof Error);
		assert.match(refused.err.message, /Use sendReturn\(\)/);

		await sms.sendResp({ smsId: 'answered-after-the-misuse' });

		assert.deepEqual((await sent).smsIds, ['answered-after-the-misuse']);
		assert.deepEqual(await closing, {});
	});

	test('unbind() waits out a submit already on the wire before it unbinds', async t => {
		const { sent, session, sms } = await submitInFlight(t);
		const unbound = session.unbind();

		await sms.sendResp({ smsId: 'answered-before-unbind' });

		assert.deepEqual((await sent).smsIds, ['answered-before-unbind']);
		assert.deepEqual(await unbound, {});
	});

	test('close() waits for a message the application has not answered yet', async t => {
		const { sent, smpp, sms } = await submitInFlight(t);
		const closing = peerOf(smpp).close();

		await delay(50);
		await sms.sendResp({ smsId: 'answered-during-the-inbound-drain' });

		assert.deepEqual(await closing, {});
		assert.deepEqual((await sent).smsIds, ['answered-during-the-inbound-drain']);
	});

	test('gives up on a message the application never answers', async t => {
		const { smpp } = await submitInFlight(t, {}, { shutdownTimeout: 50 });
		const closed = await peerOf(smpp).close();

		assert.ok(closed.err instanceof Error);
		assert.match(closed.err.message, /1 message\(s\) unanswered/);
	});

	// Waiting forever is safe for the peer, which every request times out on. The application is not.
	test('falls back to responseTimeout for a held message when the shutdown waits forever', async t => {
		const { smpp } = await submitInFlight(t, {}, { responseTimeout: 200, shutdownTimeout: 0 });
		const started = Date.now();
		const closed = await peerOf(smpp).close();
		const waited = Date.now() - started;

		assert.ok(closed.err instanceof Error);
		assert.match(closed.err.message, /1 message\(s\) unanswered/);
		assert.ok(waited >= 190, `waited ${String(waited)} ms, so the fallback was not what bounded it`);
		assert.ok(waited < 2000);
	});

	// leftOf() floors what is left at 1 ms: at 0 the request half would read "wait forever" instead.
	test('still ends when the message half has spent the whole shutdown budget', async t => {
		const { smpp } = await submitInFlight(t, {}, { shutdownTimeout: 100 });
		const bound = peerOf(smpp);
		// The client listens for no 'sms', so this one is never answered and stays in the window.
		const unanswered = bound.send({
			cmdName: 'submit_sm',
			params: {
				destination_addr: '46701113311',
				short_message: 'nothing answers this',
				source_addr: '46709771337',
			},
		});
		const closed = await Promise.race([
			bound.close(),
			new Promise<{ err?: Error }>(resolve => {
				setTimeout(() => { resolve({ err: new Error('close() never returned') }); }, 2000).unref();
			}),
		]);

		assert.match(closed.err?.message ?? '', /1 message\(s\) unanswered; .*1 request\(s\) unfinished/);
		assert.ok((await unanswered).err instanceof Error);
	});

	// The README's own listener answers and then sends its receipt, one turn later. Multipart, because
	// a receipt sent one-after-a-response outruns that turn on every segment past the first.
	test('a receipt sent right after the response still goes out mid-drain', async t => {
		const { sent, session, smpp, sms } = await submitInFlight(t, {}, {}, 'x'.repeat(400));
		const received: Dlr[] = [];
		const receipts = once<Dlr[]>(resolve => {
			session.on('dlr', dlr => {
				received.push(dlr);

				if (received.length === 3) resolve(received);
			});
		});
		const closing = peerOf(smpp).close();

		await sms.sendResp({ smsId: 'held-through-the-drain' });

		const receiptSent = await sms.sendDlr('DELIVERED');
		const ids = ['held-through-the-drain-1', 'held-through-the-drain-2', 'held-through-the-drain-3'];

		assert.equal(receiptSent.err, undefined);
		assert.deepEqual((await receipts).map(dlr => dlr.smsId), ids);
		assert.deepEqual(await closing, {});
		assert.deepEqual((await sent).smsIds, ids);
	});

	test('a message no listener took does not hold the shutdown up', async t => {
		const smpp = await startServer(t, { shutdownTimeout: 30_000 });
		const { session } = await connect(t, smpp);

		assert.ok(session);

		const bound = peerOf(smpp);
		const arrived = once<PduObject>(resolve => {
			bound.on('incomingPduObj', pduObj => {
				if (pduObj.cmdName === 'submit_sm') resolve(pduObj);
			});
		});
		const sent = session.sendSms({
			from: '46701113311',
			message: 'nobody is listening',
			to: '46709771337',
		});

		await arrived;
		await delay(50);

		const started = Date.now();

		assert.deepEqual(await bound.close(), {});
		assert.ok(Date.now() - started < 1000);
		assert.ok((await sent).err instanceof Error);
	});

	test('gives up on a request that outlasts shutdownTimeout', async t => {
		const { sent, session } = await submitInFlight(t, { shutdownTimeout: 50 });
		const closed = await session.close();

		assert.ok(closed.err instanceof Error);
		assert.match(closed.err.message, /unfinished/);

		const result = await sent;

		assert.ok(result.err instanceof Error);
		assert.match(result.err.message, /may have accepted.*Session closed before a response arrived/);
		assert.equal(result.unanswered, 1);
	});

	// The window empties on a drop as well as on an answer, so it cannot be what the result reads.
	test('reports a link that dropped mid-drain rather than calling it a clean shutdown', async t => {
		const { sent, session, smpp } = await submitInFlight(t);
		const closing = session.close();

		for (const bound of smpp.sessions) {
			bound.sock.destroy();
		}

		const closed = await closing;

		assert.ok(closed.err instanceof Error);
		assert.match(closed.err.message, /closed before the drain finished/);
		assert.ok((await sent).err instanceof Error);
	});

	// The queued segments are the whole reason the drain waits on the window and not on the pending map.
	test('counts the segments still queued behind a full window', async t => {
		const smpp = await startServer(t);
		const onWire = once<PduObject>(resolve => {
			smpp.on('session', bound => bound.on('incomingPduObj', resolve));
		});
		const { session } = await connect(t, smpp, { maxOutstanding: 1, shutdownTimeout: 50 });

		assert.ok(session);

		const sent = session.sendSms({
			from: '46701113311',
			message: 'x'.repeat(400),
			to: '46709771337',
		});

		await onWire;

		const closed = await session.close();

		assert.ok(closed.err instanceof Error);
		assert.match(closed.err.message, /3 request\(s\)/);
		assert.ok((await sent).err instanceof Error);
	});

	test('an aborted close tears down at once instead of waiting out the drain', async t => {
		const { sent, session } = await submitInFlight(t, { shutdownTimeout: 30_000 });
		const controller = new AbortController();
		const started = Date.now();

		controller.abort();

		const closed = await session.close({ signal: controller.signal });

		assert.ok(Date.now() - started < 1000);
		assert.ok(closed.err instanceof Error);
		assert.ok(session.sock.destroyed);
		assert.ok((await sent).err instanceof Error);
	});

	test('stops accepting the moment close() is called, not when the drain ends', async t => {
		const smpp = await startServer(t, { shutdownTimeout: 500 });
		const arrived = once<Session>(resolve => { smpp.on('session', resolve); });
		const silent = net.connect({ port: smpp.port });

		t.after(() => { silent.destroy(); });
		silent.resume();

		const bound = await arrived;
		const unanswered = bound.send({ cmdName: 'enquire_link' });
		const closing = smpp.close();
		const late = await new Promise<boolean>(resolve => {
			const sock = net.connect({ port: smpp.port });

			sock.on('connect', () => { sock.destroy(); resolve(true); });
			sock.on('error', () => { resolve(false); });
		});

		assert.equal(late, false);

		silent.destroy();
		await closing;

		assert.ok((await unanswered).err instanceof Error);
	});

	// Waiting on a peer that has just declared itself finished is dead time, unbounded at 0.
	test('tears down at once when the peer unbinds rather than draining for it', async t => {
		const smpp = await startServer(t, { shutdownTimeout: 0 });
		const arrived = once<Session>(resolve => { smpp.on('session', resolve); });
		const peer = net.connect({ port: smpp.port });

		t.after(() => { peer.destroy(); });
		peer.resume();

		const bound = await arrived;
		const ended = once<true>(resolve => { bound.on('close', () => { resolve(true); }); });
		const unanswered = bound.send({ cmdName: 'enquire_link' });
		const { buffer } = objToPdu({ cmdName: 'unbind', seqNr: 1 });

		assert.ok(buffer);
		peer.write(buffer);

		assert.ok(await ended);
		assert.ok((await unanswered).err instanceof Error);
	});

	test('does not report a reconnect on a session closed while it was coming back up', async t => {
		const accepted: net.Socket[] = [];
		const listener = net.createServer(sock => { accepted.push(sock); sock.resume(); });

		await new Promise<void>(resolve => { listener.listen(0, resolve); });

		const address = listener.address();
		const port = typeof address === 'object' && address !== null ? address.port : 0;
		const opened: net.Socket[] = [];
		const open = (): Promise<Result<{ sock: net.Socket }>> => new Promise(resolve => {
			const sock = net.connect({ port }, () => { resolve({ sock }); });

			opened.push(sock);
		});
		const first = await open();

		assert.ok(first.sock);

		const rebinding = latch();
		const release = latch();
		const session = new Session({
			reconnect: {
				connect: open,
				maxDelay: 20,
				minDelay: 10,
				onConnected: async () => {
					rebinding.open();
					await release.passed;

					return {};
				},
			},
			sock: first.sock,
		});
		const reported: string[] = [];

		closeAfter(t, session);
		t.after(() => { for (const sock of opened) sock.destroy(); });
		closeListenerAfter(t, listener, accepted);
		session.on('reconnected', () => reported.push('reconnected'));
		first.sock.destroy();

		assert.ok(await rebinding.passed);

		const closing = session.close();

		release.open();
		await closing;
		await delay(50);

		assert.deepEqual(reported, []);
	});
});

describe('message id notation', () => {
	async function sendOne(session: Session, message: string): Promise<SendSmsResult> {
		return session.sendSms({ dlr: true, from: '46701113311', message, to: '46709771337' });
	}

	test('correlates a hex submit_sm_resp against a decimal receipt', async t => {
		const smpp = await startServer(t);

		smpp.on('session', bound => {
			bound.on('sms', sms => { void sms.sendResp({ smsId: '1a2b' }); });
		});

		const { session } = await connect(t, smpp, {
			smsIdFormat: { receipt: 'decimal', submitResp: 'hex' },
		});

		assert.ok(session);

		const reported = once<[Dlr, PduObject]>(resolve => {
			session.on('dlr', (dlr, pduObj) => { resolve([dlr, pduObj]); });
		});
		const sent = await sendOne(session, 'one segment');

		assert.deepEqual(sent.smsIds, ['6699']);
		assert.equal(paramText(sent.pduObjs[0]?.params.message_id), '1a2b', 'the PDU keeps the id it carried');

		// The receipt renders the id in decimal and mirrors the answered one in its TLV, as the spec has it.
		await sendReceipt(peerOf(smpp), '6699', '1a2b');

		const [dlr, pduObj] = await reported;

		assert.equal(dlr.smsId, sent.smsIds[0]);
		assert.equal(paramText(pduObj.tlvs.receipted_message_id?.tagValue), '1a2b');
	});

	test('leaves the segment ids of a multipart send to merge as they are', async t => {
		const smpp = await startServer(t);

		smpp.on('session', bound => {
			bound.on('sms', sms => { void sms.sendResp({ smsId: 'beef' }); });
		});

		const { session } = await connect(t, smpp, {
			smsIdFormat: { receipt: 'decimal', submitResp: 'hex' },
		});

		assert.ok(session);

		const merged = once<MessageDlr>(resolve => { session.on('messageDlr', resolve); });
		const sent = await sendOne(session, 'x'.repeat(200));

		assert.deepEqual(sent.smsIds, ['beef-1', 'beef-2']);

		for (const smsId of sent.smsIds) {
			await sendReceipt(peerOf(smpp), smsId);
		}

		assert.equal((await merged).smsId, 'beef');
	});

	test('refuses a notation it cannot apply', () => {
		const checked = checkSessionOptions({ smsIdFormat: { receipt: 'octal' } });

		assert.ok(checked.err instanceof Error);
		assert.match(checked.err.message, /smsIdFormat\.receipt/);
		assert.ok(checkSessionOptions({ smsIdFormat: 'hex' }).err instanceof Error);
		assert.match(
			checkSessionOptions({ smsIdFormat: { receipts: 'decimal' } }).err?.message ?? '',
			/receipts/,
			'a misspelled place is the same silent no-op',
		);
		assert.equal(checkSessionOptions({ smsIdFormat: { submitResp: 'hex' } }).err, undefined);
	});
});
