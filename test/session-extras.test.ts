import assert from 'node:assert/strict';
import net from 'node:net';
import test, { describe } from 'node:test';
import type { Collected, LostGroup } from '../src/reassembly.ts';
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
import { IncomingRequests, refusedSegmentStatus } from '../src/incoming-requests.ts';
import { UnansweredError } from '../src/unanswered-error.ts';
import { createSms } from '../src/sms.ts';
import { LinkGate } from '../src/link-gate.ts';
import { SendWindow } from '../src/send-window.ts';
import { Reassembler, decodeSegments } from '../src/reassembly.ts';
import { Session } from '../src/session.ts';
import { DlrMerger } from '../src/dlr-merger.ts';
import { PduRefusedError } from '../src/pdu-refusal.ts';
import { objToPdu } from '../src/pdu.ts';
import { checkSessionOptions, standsInFor } from '../src/session-options.ts';
import { client } from '../src/client.ts';
import { closeAfter, closeListenerAfter } from './teardown.ts';
import { concatOf } from '../src/concat.ts';
import { consts } from '../src/defs/constants.ts';
import { errors } from '../src/defs/errors.ts';
import { paramNumber, paramText } from '../src/defs/types.ts';
import { server } from '../src/server.ts';
import { silentLog } from '../src/log.ts';
import { splitMessage } from '../src/message.ts';
import { submitSms, submitSmParams } from '../src/send-sms.ts';

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

/** Undefined where the promise never settled, which is an assertion rather than a hung run. */
function within<T>(ms: number, promise: Promise<T>): Promise<T | undefined> {
	return Promise.race([promise, delay(ms).then((): undefined => undefined)]);
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
		shortMessageOctets: undefined,
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
				await received.sendResp();

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

		assert.equal(report.smsId, sms.smsId);
		assert.equal(report.segments.length, 3);
		assert.equal(report.statusMsg, 'DELIVERED');
		assert.deepEqual(perSegment, [1, 2, 3].map(part => `${sms.smsId}-${String(part)}`));
	});

	test('reports once, on the final receipts, when the peer reports en route first', async t => {
		const smpp = await startServer(t);
		const incoming = once<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});
		const { session } = await connect(t, smpp);

		assert.ok(session);

		const merged = once<MessageDlr>(resolve => { session.on('messageDlr', resolve); });
		const reports: Dlr[] = [];
		const markers: (number | undefined)[] = [];

		session.on('dlr', (dlr, pduObj) => {
			reports.push(dlr);
			markers.push(paramNumber(pduObj.params.esm_class, 0));
		});

		const [sms] = await Promise.all([
			incoming.then(async received => {
				await received.sendResp();

				return received;
			}),
			session.sendSms({
				dlr: true,
				from: '46701113311',
				message: 'x'.repeat(400),
				to: '46709771337',
			}),
		]);

		await sms.sendDlr('ENROUTE');
		await sms.sendDlr('DELIVERED');

		const report = await merged;

		assert.equal(report.smsId, sms.smsId);
		assert.equal(report.statusMsg, 'DELIVERED');
		assert.equal(report.segments.length, 3);
		const notification = consts.ESM_CLASS.INTERMEDIATE_DELIVERY;
		const receipt = consts.ESM_CLASS.MC_DELIVERY_RECEIPT;

		assert.deepEqual(reports.map(one => one.intermediate), [true, true, true, false, false, false]);
		assert.deepEqual(
			markers,
			[notification, notification, notification, receipt, receipt, receipt],
			'a transient state goes out under the marker the spec gives it',
		);
		assert.deepEqual(
			reports.map(one => one.errorCode),
			['000', '000', '000', '000', '000', '000'],
			'a message still on its way has not failed',
		);
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
				await received.sendResp();

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
	function receipt(smsId: string, statusMsg: MessageState, intermediate = false): Dlr {
		return {
			doneDate: undefined,
			errorCode: undefined,
			intermediate,
			receipt: undefined,
			smsId,
			statusId: consts.MESSAGE_STATE[statusMsg],
			statusMsg,
		};
	}

	test('never counts an intermediate report toward a merge', () => {
		const merger = new DlrMerger({ log: silentLog, max: 10, now: () => 0, timeout: 60_000 });

		merger.expect(['msg-1', 'msg-2']);

		assert.equal(merger.collect(receipt('msg-1', 'ENROUTE', true)), undefined);
		assert.equal(merger.collect(receipt('msg-2', 'ENROUTE', true)), undefined);
		assert.equal(merger.collect(receipt('msg-1', 'DELIVERED')), undefined);

		const merged = merger.collect(receipt('msg-2', 'DELIVERED'));

		assert.ok(merged);
		assert.equal(merged.statusMsg, 'DELIVERED');
		assert.equal(merged.segments.length, 2);
	});

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
			shortMessageOctets: undefined,
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

		const latin1 = 'å'.repeat(153 * 3);
		const overLatin1 = await submitSms(deps, { encoding: 'LATIN1', from: '46701113311', maxSegments: 3, message: latin1, to: '46709771337' });

		assert.ok(overLatin1.err instanceof Error);
		assert.equal(attempts.length, 4);

		const sentLatin1 = await submitSms(deps, { encoding: 'LATIN1', from: '46701113311', maxSegments: 4, message: latin1, to: '46709771337' });

		assert.equal(sentLatin1.err, undefined);
		assert.equal(attempts.length, 8);
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
		session.on('sessionError', err => {
			events.push(err instanceof PduRefusedError ? 'refused' : 'sessionError');
		});

		const reconnected = once<true>(resolve => { session.on('reconnected', () => { resolve(true); }); });

		peerOf(smpp).sock.write(unreadablePdu);
		await reconnected;

		assert.deepEqual(events, ['sessionError'], 'an unframeable stream is the link dying, not one PDU refused');
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
		assert.ok(!infos.includes('reconnect - retrying'));
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
		const incoming = once<Sms>(resolve => {
			smpp.on('session', bound => bound.on('sms', sms => {
				resolve(sms);
				void sms.sendResp();
			}));
		});
		const { session } = await connect(t, smpp, { reconnect: { maxDelay: 100, minDelay: 20 } });

		assert.ok(session);

		const sent = await session.sendSms({
			dlr: true,
			from: '46701113311',
			message: 'x'.repeat(400),
			to: '46709771337',
		});
		const sms = await incoming;

		assert.deepEqual(sent.smsIds, [1, 2, 3].map(part => `${sms.smsId}-${String(part)}`));

		// Answered on the link that then drops, so an SMSC has no reason to ever send it again.
		await sendReceipt(peerOf(smpp), `${sms.smsId}-1`);

		const reconnected = once<true>(resolve => { session.on('reconnected', () => { resolve(true); }); });

		await peerOf(smpp).close();
		await reconnected;

		const merged = once<MessageDlr>(resolve => { session.on('messageDlr', resolve); });

		await sendReceipt(peerOf(smpp), `${sms.smsId}-2`);
		await sendReceipt(peerOf(smpp), `${sms.smsId}-3`);

		const report = await merged;

		assert.equal(report.smsId, sms.smsId);
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

		await incoming.handle(submitPdu(2));

		assert.equal(messages, 1, 'the harness delivers a message whose link stayed');
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

describe('reconnect from the first bind', () => {
	type LogSpy = { delays: number[]; log: SmppLog; messages: string[] };

	/** The backoff is only visible in the log, which is where the loop announces each wait. */
	function logSpy(): LogSpy {
		const delays: number[] = [];
		const messages: string[] = [];
		const noop = (): void => undefined;
		const record = (msg: string): void => { messages.push(msg); };

		return {
			delays,
			log: {
				debug: noop,
				error: record,
				info: (msg, metadata) => {
					messages.push(msg);

					if (msg === 'reconnect - retrying') delays.push(Number(metadata?.delay));
				},
				verbose: noop,
				warn: record,
			},
			messages,
		};
	}

	/** A port nothing answers on: taken and given straight back. */
	async function closedPort(): Promise<number> {
		const listener = net.createServer();

		await new Promise<void>(resolve => { listener.listen(0, resolve); });

		const address = listener.address();
		const port = typeof address === 'object' && address !== null ? address.port : 0;

		await new Promise<void>(resolve => { listener.close(() => { resolve(); }); });

		return port;
	}

	/** A client still retrying holds a socket and a timer nothing else releases. */
	function abortAfter(
		t: TestContext,
		controller: AbortController,
		connecting: ReturnType<typeof client>,
	): void {
		t.after(async () => {
			controller.abort();

			const { session } = await connecting;

			await session?.close({ signal: AbortSignal.abort() });
		});
	}

	test('gives up on the first attempt where reconnect alone is asked for', async () => {
		const port = await closedPort();
		const spy = logSpy();
		const started = Date.now();
		const { err, session } = await client({ log: spy.log, port, reconnect: { maxDelay: 40, minDelay: 10 } });

		assert.ok(err instanceof Error);
		assert.equal(session, undefined);
		assert.ok(Date.now() - started < 1000, 'the default answers the caller rather than retrying');
		assert.ok(!spy.messages.includes('reconnect - retrying'), 'nothing may retry what the default gave up on');
	});

	test('retries the first connect with backoff and binds once the SMSC listens', async t => {
		const port = await closedPort();
		const spy = logSpy();
		const controller = new AbortController();
		const connecting = client({
			log: spy.log,
			port,
			reconnect: { fromStart: true, maxDelay: 40, minDelay: 10 },
			signal: controller.signal,
		});

		abortAfter(t, controller, connecting);
		await delay(200);

		const listening = await server({ port });

		assert.equal(listening.err, undefined);
		assert.ok(listening.server);
		closeAfter(t, listening.server);

		const { err, session } = await connecting;

		assert.equal(err, undefined);
		assert.ok(session);
		assert.equal(session.loggedIn, true);
		assert.ok(spy.delays.length >= 3, 'the SMSC was down for several attempts');
		assert.deepEqual(spy.delays.slice(0, 3), [10, 20, 40], 'each wait doubles, up to maxDelay');
		assert.ok(
			!spy.messages.includes('session - reconnected'),
			'a first link is not a link coming back',
		);
	});

	// Bind flooding is what the backoff bounds; credentials an SMSC refuses now it may take later.
	test('retries a bind the SMSC refuses rather than giving up on it', async t => {
		let binds = 0;
		const spy = logSpy();
		const smpp = await startServer(t, { authenticate: () => ++binds > 2 });
		const controller = new AbortController();
		const connecting = client({
			log: spy.log,
			port: smpp.port,
			reconnect: { fromStart: true, maxDelay: 40, minDelay: 10 },
			signal: controller.signal,
		});

		abortAfter(t, controller, connecting);

		const { err, session } = await connecting;

		assert.equal(err, undefined);
		assert.ok(session);
		assert.equal(binds, 3, 'the two refusals were retried, not reported');
		assert.deepEqual(spy.delays, [10, 20], 'a link the SMSC refused a bind on does not reset the backoff');
	});

	// A drop while the bind is in flight is where the attempt's own session could retry as well.
	test('retries once per attempt when the peer drops the link mid-bind', async t => {
		let binds = 0;
		const spy = logSpy();
		const smpp = await startServer(t, {
			authenticate: input => {
				binds++;

				if (binds > 2) return true;

				input.session.sock.destroy();

				return false;
			},
		});
		const controller = new AbortController();
		const connecting = client({
			log: spy.log,
			port: smpp.port,
			reconnect: { fromStart: true, maxDelay: 40, minDelay: 10 },
			signal: controller.signal,
		});

		abortAfter(t, controller, connecting);

		const { err, session } = await connecting;

		assert.equal(err, undefined);
		assert.ok(session);
		assert.deepEqual(spy.delays, [10, 20], 'only the loop that owns the retry announces one');
	});

	test('hands back a session that reported nothing and reconnects like any other', async t => {
		const port = await closedPort();
		const controller = new AbortController();
		const connecting = client({
			port,
			reconnect: { fromStart: true, maxDelay: 40, minDelay: 10 },
			signal: controller.signal,
		});

		abortAfter(t, controller, connecting);
		await delay(100);

		const listening = await server({ port });

		assert.equal(listening.err, undefined);
		assert.ok(listening.server);
		closeAfter(t, listening.server);

		const { session } = await connecting;

		assert.ok(session);

		const events: string[] = [];

		session.on('close', () => { events.push('close'); });
		session.on('disconnected', () => { events.push('disconnected'); });

		const reconnected = once<true>(resolve => { session.on('reconnected', () => { resolve(true); }); });

		await peerOf(listening.server).close();
		await reconnected;

		assert.deepEqual(events, ['disconnected'], 'the attempts before the first link reported nothing');

		const closed = once<true>(resolve => { session.on('close', () => { resolve(true); }); });

		controller.abort();
		await closed;

		// Which is why a deadline for the wait may not be a signal that goes on arming afterwards.
		assert.deepEqual(events, ['disconnected', 'close'], 'the signal that bounded the wait ends the session');
	});

	test('lets an abort out of the initial retries', async () => {
		const port = await closedPort();
		const controller = new AbortController();
		const connecting = client({
			port,
			reconnect: { fromStart: true, maxDelay: 40, minDelay: 10 },
			signal: controller.signal,
		});

		await delay(60);
		controller.abort();

		const settled = await within(2000, connecting);

		assert.ok(settled, 'an aborted signal is the way out of a wait nothing else ends');
		assert.ok(settled.err instanceof Error);
		assert.ok(settled.err.cause instanceof Error, 'an abort carries what the attempts kept failing with');
		assert.equal(settled.session, undefined);
	});

	test('holds the process open between the initial attempts', async t => {
		const port = await closedPort();
		const controller = new AbortController();
		const timeouts = (): number => process.getActiveResourcesInfo().filter(name => name === 'Timeout').length;
		const before = timeouts();
		const connecting = client({
			port,
			reconnect: { fromStart: true, maxDelay: 5000, minDelay: 5000 },
			signal: controller.signal,
		});

		abortAfter(t, controller, connecting);
		await delay(200);

		assert.ok(timeouts() > before, 'the wait should hold a process whose only work is this client');

		controller.abort();

		const settled = await within(2000, connecting);

		assert.ok(settled);
		assert.ok(settled.err instanceof Error);
	});

	test('refuses fromStart spelled anywhere but inside reconnect', async () => {
		const misspelled = { fromStart: true, port: 1, reconnect: false } as const;

		assert.match(
			checkSessionOptions(misspelled).err?.message ?? '',
			/reconnect: \{ fromStart: true \}/,
			'off and from-start contradict each other, so the one spelling has to be named',
		);

		const refused = await client(misspelled);

		assert.ok(refused.err instanceof Error);
		assert.equal(refused.session, undefined);
		assert.match(checkSessionOptions({ reconnect: { fromStart: 'yes' } }).err?.message ?? '', /fromStart/);
		assert.equal(checkSessionOptions({ reconnect: { fromStart: true, minDelay: 10 } }).err, undefined);
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

describe('SendWindow', () => {
	test('gives up a queued acquire the moment its signal fires', async () => {
		const window = new SendWindow({ limit: 1, log: silentLog });
		const controller = new AbortController();

		assert.deepEqual(await window.acquire(undefined), {});

		const queued = window.acquire(controller.signal);

		controller.abort();

		assert.match((await queued).err?.message ?? '', /Aborted while waiting for a send window slot/);
		assert.equal(window.unfinished(), 1, 'a waiter that gave up is owed nothing');
	});

	// release() hands the slot straight to the next waiter, so one nobody awaits loses it for good.
	test('never hands a freed slot to a waiter that gave up', async () => {
		const window = new SendWindow({ limit: 1, log: silentLog });
		const controller = new AbortController();

		await window.acquire(undefined);

		const abandoned = window.acquire(controller.signal);

		controller.abort();
		await abandoned;
		window.release();

		assert.equal(window.unfinished(), 0, 'the slot is free, not stranded on the waiter that left');
		assert.deepEqual(await window.acquire(undefined), {}, 'so the next send takes it at once');
	});

	test('takes no slot for a signal that was already aborted', async () => {
		const window = new SendWindow({ limit: 1, log: silentLog });

		await window.acquire(undefined);

		const refused = await window.acquire(AbortSignal.abort());

		assert.match(refused.err?.message ?? '', /Aborted while waiting for a send window slot/);
		assert.equal(window.unfinished(), 1);
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

describe('sendResp()', () => {
	// A response the wire never carried leaves the peer owed one, so nothing may count it answered.
	test('does not count a response that never reached the wire as an answer', async t => {
		const sock = new net.Socket();
		const session = new Session({ sock });

		closeAfter(t, session);
		sock.destroy();

		let answered = 0;
		const sms = createSms({
			from: '46701113311',
			message: 'never answered',
			pduObjs: [submitPdu(1)],
			session,
			to: '46709771337',
		}, {
			lostLink: () => false,
			onAnswered: () => { answered++; },
			send: () => Promise.resolve({ err: new Error('never sent') }),
		});

		assert.match((await sms.sendResp()).err?.message ?? '', /Socket is closed/);
		assert.equal(answered, 0);
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

function segment(reference: number, part: number, total: number, width: 8 | 16 = 8): PduObject {
	const udh = width === 8
		? Buffer.from([0x05, 0x00, 0x03, reference, total, part])
		: Buffer.from([0x06, 0x08, 0x04, reference >>> 8, reference & 0xff, total, part]);
	const body = Buffer.concat([udh, Buffer.from('fragment')]);

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
			short_message: body,
			source_addr: '46701113311',
		},
		seqNr: part,
		shortMessageOctets: body,
		tlvs: {},
	};
}

/** The same segment with its body where SMPP 3.4 5.3.2.32 allows it instead. */
function payloadSegment(reference: number, part: number, total: number): PduObject {
	const carried = segment(reference, part, total);
	const body = carried.shortMessageOctets;

	assert.ok(body);

	return {
		...carried,
		params: { ...carried.params, short_message: Buffer.alloc(0) },
		shortMessageOctets: Buffer.alloc(0),
		tlvs: { message_payload: { tagId: 0x0424, tagName: 'message_payload', tagValue: body } },
	};
}

function sarTlvs(reference: number, part: number, total: number): PduObject['tlvs'] {
	return {
		sar_msg_ref_num: { tagId: 0x020c, tagName: 'sar_msg_ref_num', tagValue: reference },
		sar_segment_seqnum: { tagId: 0x020f, tagName: 'sar_segment_seqnum', tagValue: part },
		sar_total_segments: { tagId: 0x020e, tagName: 'sar_total_segments', tagValue: total },
	};
}

/** The same segment numbered by the sar_* TLVs, which carry no UDH and set no esm_class bit. */
function sarSegment(reference: number, part: number, total: number): PduObject {
	const body = Buffer.from('fragment');
	const carried = segment(reference, part, total);

	return {
		...carried,
		params: { ...carried.params, esm_class: 0, short_message: body },
		shortMessageOctets: body,
		tlvs: sarTlvs(reference, part, total),
	};
}

/** Reads the concatenation the way a session does, so no test can number a segment by hand. */
function collectPdu(reassembler: Reassembler, pduObj: PduObject): Collected {
	const concat = concatOf(pduObj);

	assert.ok(concat, 'the fixture must number itself as a segment');

	return reassembler.collect(pduObj, concat);
}

describe('where a segment says it is concatenated', () => {
	// The UDH reference is 8 bits and sar_msg_ref_num 16, so one number is two unrelated counters.
	test('names the spelling a segment was numbered by, alongside the reference', () => {
		assert.deepEqual(concatOf(sarSegment(5, 2, 3)), { part: 2, reference: 5, spelling: 'sar', total: 3 });
		assert.deepEqual(concatOf(segment(5, 2, 3)), { part: 2, reference: 5, spelling: 'udh', total: 3 });
		assert.deepEqual(
			concatOf(segment(0x2af1, 2, 3, 16)),
			{ part: 2, reference: 0x2af1, spelling: 'udh', total: 3 },
			'GSM 03.40 element 0x08 numbers a segment as element 0x00 does, two octets wider',
		);
	});

	test('reads a segment carrying both spellings from its UDH', () => {
		const both = { ...segment(5, 1, 2), tlvs: sarTlvs(9, 2, 4) };

		assert.deepEqual(concatOf(both), { part: 1, reference: 5, spelling: 'udh', total: 2 });
	});

	// A UDH carrying only an application port numbers nothing, so the TLVs are all there is to read.
	test('reads the sar_* TLVs where the UDH names no concatenation', () => {
		const carried = sarSegment(5, 1, 2);
		const body = Buffer.concat([Buffer.from([0x04, 0x04, 0x02, 0x17, 0x00]), Buffer.from('fragment')]);
		const ported = {
			...carried,
			params: { ...carried.params, esm_class: 0x40, short_message: body },
			shortMessageOctets: body,
		};

		assert.deepEqual(concatOf(ported), { part: 1, reference: 5, spelling: 'sar', total: 2 });
	});

	test('reads a UDH carried in message_payload', () => {
		assert.deepEqual(concatOf(payloadSegment(6, 1, 2)), { part: 1, reference: 6, spelling: 'udh', total: 2 });
	});

	test('reads no concatenation where a sar_* TLV is missing', () => {
		const lone = {
			...sarSegment(5, 1, 2),
			tlvs: { sar_msg_ref_num: { tagId: 0x020c, tagName: 'sar_msg_ref_num', tagValue: 5 } },
		};

		assert.equal(concatOf(lone), undefined);
	});

	test('reads no concatenation from a message that is not a segment', () => {
		const whole = { ...sarSegment(5, 1, 2), tlvs: {} };

		assert.equal(concatOf(whole), undefined);
	});
});

describe('reassembly bounds', () => {
	function collect(
		reassembler: Reassembler,
		reference: number,
		part: number,
		total: number,
	): Collected {
		return collectPdu(reassembler, segment(reference, part, total));
	}

	function collectSar(
		reassembler: Reassembler,
		reference: number,
		part: number,
		total: number,
	): Collected {
		return collectPdu(reassembler, sarSegment(reference, part, total));
	}

	test('hands back every segment in order once the last one arrives', () => {
		const reassembler = new Reassembler({
			log: silentLog,
			max: 10,
			now: () => 0,
			onLost: () => undefined,
			timeout: 60_000,
		});
		const second = collect(reassembler, 4, 2, 3);
		const third = collect(reassembler, 4, 3, 3);

		assert.ok(second.kept);
		assert.ok(third.kept);
		assert.equal(second.whole, undefined);
		assert.equal(third.whole, undefined);

		const collected = collect(reassembler, 4, 1, 3);

		assert.ok(collected.kept);
		assert.ok(collected.whole);
		assert.deepEqual(collected.whole.map(pduObj => pduObj.seqNr), [1, 2, 3]);
		assert.equal(reassembler.size, 0);

		// One id base per group: every segment of it was answered with a part of that base.
		assert.equal(second.smsId, collected.smsId);
		assert.equal(third.smsId, collected.smsId);
	});

	// The header is stripped by its own declared length, so the wider element assembles identically.
	test('assembles a message numbered by a 16-bit UDH reference', () => {
		const reassembler = new Reassembler({
			log: silentLog,
			max: 10,
			now: () => 0,
			onLost: () => undefined,
			timeout: 60_000,
		});

		const first = collectPdu(reassembler, segment(0x2af1, 1, 2, 16));

		assert.ok(first.kept);
		assert.equal(first.whole, undefined);

		const collected = collectPdu(reassembler, segment(0x2af1, 2, 2, 16));

		assert.ok(collected.kept);
		assert.ok(collected.whole);
		assert.equal(decodeSegments(collected.whole), 'fragmentfragment');
	});

	// A group the store cannot hold at all is refused, not accepted and then thrown away.
	test('refuses a lone segment whose own arrival overruns the octet cap', () => {
		const lost: LostGroup[] = [];
		const reassembler = new Reassembler({
			log: silentLog,
			max: 10,
			maxOctets: 10,
			now: () => 0,
			onLost: one => { lost.push(one); },
			timeout: 60_000,
		});
		const refused = collect(reassembler, 8, 1, 2);

		assert.equal(refused.kept, false);
		assert.equal(reassembler.size, 0);
		assert.deepEqual(lost, [], 'the peer holds the only segment there was, so nothing was lost');
	});

	// The two addresses are 22 octets, so only the 14 the TLV carries can overrun a cap of 30.
	test('counts a body carried in message_payload against the octet cap', () => {
		function collectPayload(maxOctets: number): Collected {
			const reassembler = new Reassembler({
				log: silentLog,
				max: 10,
				maxOctets,
				now: () => 0,
				onLost: () => undefined,
				timeout: 60_000,
			});

			return collectPdu(reassembler, payloadSegment(9, 1, 2));
		}

		assert.equal(collectPayload(30).kept, false, 'a TLV body the cap cannot hold is refused, not dropped later');
		assert.equal(collectPayload(40).kept, true);
	});

	// The segments before it were answered ESME_ROK, so dropping those is not the same as refusing one.
	test('reports the answered segments of a group that overruns the cap mid-message', () => {
		const lost: LostGroup[] = [];
		const reassembler = new Reassembler({
			log: silentLog,
			max: 10,
			// One segment is 36 octets, so the second overruns a group already holding the first.
			maxOctets: 50,
			now: () => 0,
			onLost: one => { lost.push(one); },
			timeout: 60_000,
		});

		assert.equal(collect(reassembler, 8, 1, 3).kept, true);
		assert.equal(collect(reassembler, 8, 2, 3).kept, false);
		assert.equal(reassembler.size, 0);
		// One of the two the group held is the refused segment, which the peer still has.
		assert.deepEqual(
			lost.map(one => ({ parts: one.parts, reason: one.reason, total: one.total })),
			[{ parts: 1, reason: 'evicted', total: 3 }],
		);
	});

	// An alphanumeric sender may carry the separator the key is built with, and two of them are two peers.
	test('keeps two address pairs that differ only in where a separator sits apart', () => {
		const reassembler = new Reassembler({
			log: silentLog,
			max: 10,
			now: () => 0,
			onLost: () => undefined,
			timeout: 60_000,
		});
		const addressed = (source: string, destination: string): PduObject => {
			const carried = segment(3, 1, 2);

			return {
				...carried,
				params: { ...carried.params, destination_addr: destination, source_addr: source },
			};
		};

		assert.equal(collectPdu(reassembler, addressed('A_B', 'C')).kept, true);
		assert.equal(collectPdu(reassembler, addressed('A', 'B_C')).kept, true);
		assert.equal(reassembler.size, 2, 'two senders, so two groups, and neither completes the other');

		reassembler.clear();
	});

	// Nothing about the bounds reads a UDH, and a group the TLVs numbered is bounded the same way.
	test('bounds a sar_* group by the same count and octet caps', () => {
		const counted = new Reassembler({
			log: silentLog,
			max: 1,
			now: () => 0,
			onLost: () => undefined,
			timeout: 60_000,
		});
		const capped = (maxOctets: number): Reassembler => new Reassembler({
			log: silentLog,
			max: 10,
			maxOctets,
			now: () => 0,
			onLost: () => undefined,
			timeout: 60_000,
		});

		assert.equal(collectSar(counted, 1, 1, 2).kept, true);
		assert.equal(collectSar(counted, 2, 1, 2).kept, true);
		assert.equal(counted.size, 1, 'the second group evicted the first, as a UDH group would');
		counted.clear();

		// A sar_* segment is the two 11-octet addresses plus an 8-octet body, with no UDH to carry.
		assert.equal(collectSar(capped(20), 3, 1, 2).kept, false);
		assert.equal(collectSar(capped(30), 3, 1, 2).kept, true);
	});

	// Nothing else says a message the peer has already been answered for was thrown away.
	test('names every group it gives up on, and why', () => {
		let now = 0;
		let issued = 0;
		const ids = [
			'0199e0eb-4c11-7a02-9f31-2b6d80c4e517',
			'0199e0eb-9d42-7bc6-8e70-51af3c92d6b8',
			'0199e0ec-0e73-7d18-bb29-7c04ea51f3a9',
		];
		const lost: LostGroup[] = [];
		const reassembler = new Reassembler({
			log: silentLog,
			max: 1,
			newId: () => ids[issued++] ?? '',
			now: () => now,
			onLost: one => { lost.push(one); },
			timeout: 60,
		});

		collect(reassembler, 1, 1, 2);
		// A group numbered by the TLVs is given up on, and reported, exactly as a UDH group is.
		collectSar(reassembler, 2, 1, 3);

		now = 61;
		reassembler.sweep();
		collect(reassembler, 3, 1, 2);
		reassembler.clear();

		assert.deepEqual(lost.map(one => one.reason), ['evicted', 'expired', 'linkGone']);
		assert.deepEqual(lost.map(one => one.parts), [1, 1, 1]);
		assert.deepEqual(lost.map(one => one.total), [2, 3, 2]);
		assert.deepEqual(lost.map(one => one.smsId), ids, 'each group carries an id of its own');
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
		const reassembler = new Reassembler({
			log,
			max: 10,
			now: () => 0,
			onLost: () => undefined,
			timeout: 60_000,
		});

		assert.deepEqual(
			[collect(reassembler, 1, 1, 0), collect(reassembler, 2, 0, 3), collect(reassembler, 3, 4, 3)]
				.map(one => (one.kept ? undefined : one.refusal)),
			Array(3).fill('unplaceable'),
		);
		assert.equal(reassembler.size, 0);
		assert.deepEqual(warnings, Array(3).fill('reassembler - dropping an impossibly numbered segment'));
	});

	// Parts 1/2 then 2/3 would otherwise complete the stored two-part group, truncating the message.
	test('refuses a segment that renumbers how many parts the message has', () => {
		const reassembler = new Reassembler({
			log: silentLog,
			max: 10,
			now: () => 0,
			onLost: () => undefined,
			timeout: 60_000,
		});

		const first = collect(reassembler, 9, 1, 2);

		assert.ok(first.kept);
		assert.equal(first.whole, undefined);
		assert.equal(collect(reassembler, 9, 2, 3).kept, false);
		assert.equal(reassembler.size, 1);

		reassembler.clear();
	});

	// 0.4.0 held incomplete groups without limit and swept them only when other traffic arrived.
	test('drops the oldest incomplete message once the cap is reached', () => {
		const reassembler = new Reassembler({
			log: silentLog,
			max: 2,
			now: () => 0,
			onLost: () => undefined,
			timeout: 60_000,
		});

		for (const reference of [1, 2, 3]) {
			const collected = collect(reassembler, reference, 1, 2);

			assert.ok(collected.kept);
			assert.equal(collected.whole, undefined);
		}

		// Completing the first one must not produce a message: it was evicted.
		const reopened = collect(reassembler, 1, 2, 2);

		assert.ok(reopened.kept);
		assert.equal(reopened.whole, undefined);
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
			onLost: () => undefined,
			timeout: 60_000,
		});

		for (const reference of [1, 2, 3]) {
			const collected = collect(reassembler, reference, 1, 2);

			assert.ok(collected.kept);
			assert.equal(collected.whole, undefined);
		}

		assert.equal(reassembler.size, 2);

		const reopened = collect(reassembler, 1, 2, 2);

		assert.ok(reopened.kept);
		assert.equal(reopened.whole, undefined);

		reassembler.clear();
	});

	// A retained subarray keeps its whole framed PDU alive, up to maxPduLength per segment.
	test('copies a segment out of the buffer it arrived in', () => {
		const reassembler = new Reassembler({
			log: silentLog,
			max: 10,
			now: () => 0,
			onLost: () => undefined,
			timeout: 60_000,
		});
		const framed = Buffer.alloc(1024);
		const first = segment(6, 1, 2);

		Buffer.concat([Buffer.from([0x05, 0x00, 0x03, 6, 2, 1]), Buffer.from('fragment')]).copy(framed);
		first.params.short_message = framed.subarray(0, 14);

		const held = collectPdu(reassembler, first);

		assert.ok(held.kept);
		assert.equal(held.whole, undefined);

		framed.fill(0x00);

		const collected = collect(reassembler, 6, 2, 2);

		assert.ok(collected.kept);
		assert.ok(collected.whole);
		assert.equal(decodeSegments(collected.whole), 'fragmentfragment');
	});

	test('expires an incomplete message once its timeout has passed', () => {
		let now = 0;
		const reassembler = new Reassembler({
			log: silentLog,
			max: 10,
			now: () => now,
			onLost: () => undefined,
			timeout: 60,
		});
		const first = collect(reassembler, 9, 1, 2);

		assert.ok(first.kept);
		assert.equal(first.whole, undefined);

		now = 61;

		// The other half arrives after the group expired, so it starts a new, still-incomplete one.
		const late = collect(reassembler, 9, 2, 2);

		assert.ok(late.kept);
		assert.equal(late.whole, undefined);
		assert.notEqual(late.smsId, first.smsId);
		assert.equal(reassembler.size, 1);

		reassembler.clear();
	});
});

// Jasmin dispatches one request per connector at a time: holding a group unanswered until it was
// whole deadlocked every multi-segment message against it (interop-tests/findings/03-jasmin.md).
describe('the status a refused segment is answered with', () => {
	// SMPP 3.4 lists ESME_RMSGQFUL under submit_sm_resp only; 4.6.2's retryable code is another.
	test('names one the command the segment arrived on defines', () => {
		assert.equal(refusedSegmentStatus('submit_sm', 'full', 'udh'), 'ESME_RMSGQFUL');
		assert.equal(refusedSegmentStatus('deliver_sm', 'full', 'udh'), 'ESME_RX_T_APPN');
		assert.equal(refusedSegmentStatus('submit_sm', 'unplaceable', 'udh'), 'ESME_RINVESMCLASS');
		assert.equal(refusedSegmentStatus('deliver_sm', 'unplaceable', 'udh'), 'ESME_RINVESMCLASS');
		// esm_class is 0x00 on a sar_* segment and entirely valid: the TLV values are what cannot be honoured.
		assert.equal(refusedSegmentStatus('submit_sm', 'unplaceable', 'sar'), 'ESME_RINVTLVVAL');
		assert.equal(refusedSegmentStatus('deliver_sm', 'unplaceable', 'sar'), 'ESME_RINVTLVVAL');
		assert.equal(refusedSegmentStatus('submit_sm', 'full', 'sar'), 'ESME_RMSGQFUL');
	});

	// Which command that is, for the one that travels both ways, is what the end it arrived at says.
	test('reads a data_sm as the command its direction makes it', () => {
		assert.equal(standsInFor('data_sm', 'esme'), 'deliver_sm');
		assert.equal(standsInFor('data_sm', 'smsc'), 'submit_sm');
		assert.equal(standsInFor('deliver_sm', 'esme'), 'deliver_sm');
		assert.equal(standsInFor('submit_sm', 'smsc'), 'submit_sm');
		assert.equal(standsInFor('enquire_link', 'smsc'), 'enquire_link');
		assert.equal(refusedSegmentStatus(standsInFor('data_sm', 'smsc'), 'full', 'udh'), 'ESME_RMSGQFUL');
		assert.equal(refusedSegmentStatus(standsInFor('data_sm', 'esme'), 'full', 'udh'), 'ESME_RX_T_APPN');
	});
});

describe('a peer that sends the next segment only once the last one is answered', () => {
	const text = 'A relay that waits for each response before it sends the next segment. '.repeat(4);

	function segmentsOf(reference: number): Buffer[] {
		const segments = splitMessage(text, { reference });

		assert.ok(segments.length > 1, 'the fixture must need more than one segment');

		return segments;
	}

	async function submit(session: Session, segment: Buffer): Promise<PduObject> {
		const answered = await session.send({
			cmdName: 'submit_sm',
			params: submitSmParams(
				{ from: '46701113311', message: text, to: '46709771337' },
				segment,
				{ encoding: 'ASCII', multipart: true },
			),
		});

		assert.equal(answered.err, undefined);
		assert.ok(answered.pduObj);

		return answered.pduObj;
	}

	async function submitSerially(session: Session, reference: number): Promise<PduObject[]> {
		const answers: PduObject[] = [];

		for (const segment of segmentsOf(reference)) {
			answers.push(await submit(session, segment));
		}

		return answers;
	}

	test('gets every segment answered as it arrives, and the application one whole message', async t => {
		const smpp = await startServer(t);
		const messages: Sms[] = [];
		const incoming = once<Sms>(resolve => {
			smpp.on('session', bound => bound.on('sms', sms => {
				messages.push(sms);
				resolve(sms);
			}));
		});
		const { session } = await connect(t, smpp, { responseTimeout: 1000 });

		assert.ok(session);

		const answers = await submitSerially(session, 0x2A);
		const sms = await incoming;

		assert.equal(sms.message, text);
		assert.equal(sms.pduObjs.length, answers.length);
		assert.equal(messages.length, 1, 'the application sees one message, not one per segment');
		assert.equal(sms.answeredOnArrival, true);
		assert.deepEqual(answers.map(answer => answer.cmdStatus), answers.map(() => 'ESME_ROK'));
		assert.deepEqual(
			answers.map(answer => paramText(answer.params.message_id)),
			answers.map((_answer, index) => `${sms.smsId}-${String(index + 1)}`),
		);
		assert.deepEqual(await sms.sendResp(), {});
	});

	// The documented single-segment contract, which the segment-by-segment answer must not touch.
	test('answers a single-segment message only once the application does, with the id it chose', async t => {
		const smpp = await startServer(t);
		const incoming = once<Sms>(resolve => {
			smpp.on('session', bound => bound.on('sms', resolve));
		});
		const { session } = await connect(t, smpp);

		assert.ok(session);

		const submitted = session.send({
			cmdName: 'submit_sm',
			params: {
				destination_addr: '46709771337',
				short_message: 'one segment, answered by the application',
				source_addr: '46701113311',
			},
		});
		const sms = await incoming;

		assert.equal(await within(150, submitted), undefined, 'nothing may answer for the application');
		assert.equal(sms.answeredOnArrival, false);
		assert.deepEqual(await sms.sendResp({ smsId: '0199e0e9-4a3e-7c62-9a4b-1f0c5d7e8a21' }), {});

		const answered = await submitted;

		assert.ok(answered.pduObj);
		assert.equal(
			paramText(answered.pduObj.params.message_id),
			'0199e0e9-4a3e-7c62-9a4b-1f0c5d7e8a21',
		);
	});

	test('refuses an id and a refusing status for segments already on the wire', async t => {
		const smpp = await startServer(t);
		const incoming = once<Sms>(resolve => {
			smpp.on('session', bound => bound.on('sms', resolve));
		});
		const { session } = await connect(t, smpp, { responseTimeout: 1000 });

		assert.ok(session);

		await submitSerially(session, 0x2B);

		const sms = await incoming;
		const named = await sms.sendResp({ smsId: '0199e0ea-1f3d-7ab4-8c21-6d4e5f0a9b73' });
		const refused = await sms.sendResp({ status: 'ESME_RMSGQFUL' });

		assert.match(named.err?.message ?? '', /fixed when its first segment arrived/);
		assert.match(refused.err?.message ?? '', /onRequest/);
		assert.deepEqual(await sms.sendResp({ status: 'ESME_ROK' }), {});
		assert.equal(sms.answeredOnArrival, true);
	});

	test('reports a half-arrived message it has already answered, and holds nothing after', async t => {
		const smpp = await startServer(t, { reassemblyTimeout: 60 });
		const messages: Sms[] = [];
		const lost = once<Error>(resolve => {
			smpp.on('session', bound => {
				bound.on('sessionError', resolve);
				bound.on('sms', sms => { messages.push(sms); });
			});
		});
		const { session } = await connect(t, smpp, { responseTimeout: 1000 });

		assert.ok(session);

		const [first] = segmentsOf(0x2C);

		assert.ok(first);

		const answered = await submit(session, first);

		assert.equal(answered.cmdStatus, 'ESME_ROK');
		assert.match((await lost).message, /Gave up 1 of \d+ segments/);
		assert.equal(messages.length, 0);
		assert.deepEqual(await peerOf(smpp).close(), {}, 'a group nothing completed is not held');
	});

	test('close() still waits for a concatenated message the application has not answered', async t => {
		const smpp = await startServer(t, { shutdownTimeout: 50 });
		const incoming = once<Sms>(resolve => {
			smpp.on('session', bound => bound.on('sms', resolve));
		});
		const { session } = await connect(t, smpp, { responseTimeout: 1000 });

		assert.ok(session);

		await submitSerially(session, 0x2D);
		await incoming;

		const closed = await peerOf(smpp).close();

		assert.ok(closed.err instanceof Error);
		assert.match(closed.err.message, /1 message\(s\) unanswered/);
	});

	// pduObjs.length is 1 either way here, so answeredOnArrival is the only thing that can say.
	test('marks a one-part concatenated message answered, as its segment count cannot', async t => {
		const smpp = await startServer(t);
		const incoming = once<Sms>(resolve => {
			smpp.on('session', bound => bound.on('sms', resolve));
		});
		const { session } = await connect(t, smpp, { responseTimeout: 1000 });

		assert.ok(session);

		const answered = await session.send({
			cmdName: 'submit_sm',
			params: {
				destination_addr: '46709771337',
				esm_class: consts.ESM_CLASS.UDH_INDICATOR,
				short_message: Buffer.concat([
					Buffer.from([0x05, 0x00, 0x03, 0x2F, 0x01, 0x01]),
					Buffer.from('one part of one'),
				]),
				source_addr: '46701113311',
			},
		});
		const sms = await incoming;

		assert.equal(answered.err, undefined);
		assert.ok(answered.pduObj);
		assert.equal(answered.pduObj.cmdStatus, 'ESME_ROK');
		assert.equal(paramText(answered.pduObj.params.message_id), sms.smsId);
		assert.equal(sms.pduObjs.length, 1);
		assert.equal(sms.answeredOnArrival, true);
		assert.deepEqual(await sms.sendResp(), {});
	});

	// esm_class said there was a UDH, and there is no group its concatenation fields can join.
	test('answers a segment whose UDH cannot be honoured rather than leaving the peer waiting', async t => {
		const smpp = await startServer(t);
		const messages: Sms[] = [];

		smpp.on('session', bound => bound.on('sms', sms => { messages.push(sms); }));

		const { session } = await connect(t, smpp, { responseTimeout: 1000 });

		assert.ok(session);

		const answered = await session.send({
			cmdName: 'submit_sm',
			params: {
				destination_addr: '46709771337',
				esm_class: consts.ESM_CLASS.UDH_INDICATOR,
				short_message: Buffer.concat([
					Buffer.from([0x05, 0x00, 0x03, 0x2E, 0x02, 0x09]),
					Buffer.from('part nine of two'),
				]),
				source_addr: '46701113311',
			},
		});

		assert.equal(answered.err, undefined);
		assert.ok(answered.pduObj);
		assert.equal(answered.pduObj.cmdStatus, 'ESME_RINVESMCLASS');
		assert.deepEqual(messages, []);
	});

	// Its esm_class is 0x00 and correct, so the refusal names the optional parameters instead.
	test('refuses a sar_* segment the TLVs number impossibly by naming those TLVs', async t => {
		const smpp = await startServer(t);
		const messages: Sms[] = [];

		smpp.on('session', bound => bound.on('sms', sms => { messages.push(sms); }));

		const { session } = await connect(t, smpp, { responseTimeout: 1000 });

		assert.ok(session);

		const answered = await session.send({
			cmdName: 'submit_sm',
			params: {
				destination_addr: '46709771337',
				short_message: 'part nine of two',
				source_addr: '46701113311',
			},
			tlvs: {
				sar_msg_ref_num: { tagValue: 0x2e },
				sar_segment_seqnum: { tagValue: 9 },
				sar_total_segments: { tagValue: 2 },
			},
		});

		assert.equal(answered.err, undefined);
		assert.ok(answered.pduObj);
		assert.equal(answered.pduObj.cmdStatus, 'ESME_RINVTLVVAL');
		assert.deepEqual(messages, []);
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

	/** The peer answers nothing, so the single slot stays taken for the life of the test. */
	async function oneSlotHeld(
		t: TestContext,
		options: Parameters<typeof client>[0] = {},
	): Promise<Session> {
		const smpp = await startServer(t);
		const onWire = once<PduObject>(resolve => {
			smpp.on('session', bound => bound.on('incomingPduObj', resolve));
		});

		smpp.on('session', bound => bound.on('sms', () => undefined));

		const { session } = await connect(t, smpp, { maxOutstanding: 1, ...options });

		assert.ok(session);
		void session.sendSms({ from: '46701113311', message: 'holds the only slot', to: '46709771337' });

		await onWire;

		return session;
	}

	test('gives up on a send still queued behind a full window', async t => {
		const session = await oneSlotHeld(t, { responseTimeout: 10_000 });
		const controller = new AbortController();
		const queued = session.sendSms(
			{ from: '46701113311', message: 'queued behind the held slot', to: '46709771337' },
			{ signal: controller.signal },
		);

		await delay(20);
		controller.abort();

		const sent = await within(500, queued);

		assert.ok(sent, 'an abort must not wait out a slot the caller no longer wants');
		assert.match(sent.err?.message ?? '', /Aborted while waiting for a send window slot/);
		assert.equal(sent.unanswered, 0, 'it never reached the socket, so the peer cannot have taken it');
	});

	test('gives up on a queued send where responseTimeout: 0 never would', async t => {
		const session = await oneSlotHeld(t, { responseTimeout: 0 });
		const controller = new AbortController();
		const queued = session.sendSms(
			{ from: '46701113311', message: 'queued with nothing else to end the wait', to: '46709771337' },
			{ signal: controller.signal },
		);

		await delay(20);
		controller.abort();

		const sent = await within(500, queued);

		assert.ok(sent, 'the signal is the only bound this wait has');
		assert.match(sent.err?.message ?? '', /Aborted while waiting for a send window slot/);
		assert.equal(sent.unanswered, 0);
	});

	test('leaves the freed slot to the next send rather than to the waiter that gave up', async t => {
		const smpp = await startServer(t);
		const holding = once<Sms>(resolve => { smpp.on('session', bound => bound.on('sms', resolve)); });
		let firstTaken = false;

		smpp.on('session', bound => {
			bound.on('sms', async sms => {
				if (firstTaken) await sms.sendResp();

				firstTaken = true;
			});
		});

		const { session } = await connect(t, smpp, { maxOutstanding: 1, responseTimeout: 10_000 });

		assert.ok(session);
		void session.sendSms({ from: '46701113311', message: 'holds the only slot', to: '46709771337' });

		const held = await holding;
		const controller = new AbortController();
		const abandoned = session.sendSms(
			{ from: '46701113311', message: 'abandoned in the queue', to: '46709771337' },
			{ signal: controller.signal },
		);

		await delay(20);
		controller.abort();

		const gaveUp = await within(500, abandoned);

		assert.ok(gaveUp, 'the waiter that gave up must settle before the slot it left is freed');
		// Any other error means it never reached the queue, so there was no waiter to strand.
		assert.match(gaveUp.err?.message ?? '', /Aborted while waiting for a send window slot/);
		await held.sendResp();

		const following = await within(1000, session.sendSms({
			from: '46701113311',
			message: 'takes the freed slot',
			to: '46709771337',
		}));

		assert.ok(following, 'a slot handed to a waiter that left is one the window never gets back');
		assert.equal(following.err, undefined);
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

		assert.deepEqual(await sms.sendResp(), {});

		const receiptSent = await sms.sendDlr('DELIVERED');
		const ids = [1, 2, 3].map(part => `${sms.smsId}-${String(part)}`);

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

	// emit() releases the hold of a listener that throws; one that rejects may cost no more than that.
	test('a listener that rejected before answering does not hold the shutdown up', async t => {
		const smpp = await startServer(t, { shutdownTimeout: 30_000 });
		const failed = once<Error>(resolve => {
			smpp.on('session', bound => {
				bound.on('sessionError', resolve);
				bound.on('sms', () => Promise.reject(new Error('the listener gave up')));
			});
		});
		const { session } = await connect(t, smpp);

		assert.ok(session);

		const sent = session.sendSms({
			from: '46701113311',
			message: 'the listener rejects',
			to: '46709771337',
		});

		assert.equal((await failed).message, 'the listener gave up');

		const started = Date.now();

		assert.deepEqual(await peerOf(smpp).close(), {});
		assert.ok(Date.now() - started < 1000);
		assert.ok((await sent).err instanceof Error);
	});

	test('waits for the listener still working when another one rejected', async t => {
		const smpp = await startServer(t, { shutdownTimeout: 30_000 });
		const failed = once<Error>(resolve => {
			smpp.on('session', bound => {
				bound.on('sessionError', resolve);
				bound.on('sms', async sms => {
					await delay(100);
					await sms.sendResp({ smsId: 'answered-after-the-other-gave-up' });
				});
				bound.on('sms', () => Promise.reject(new Error('the audit listener gave up')));
			});
		});
		const { session } = await connect(t, smpp);

		assert.ok(session);

		const sent = session.sendSms({
			from: '46701113311',
			message: 'two listeners, one gives up',
			to: '46709771337',
		});

		assert.equal((await failed).message, 'the audit listener gave up');
		assert.deepEqual(await peerOf(smpp).close(), {});
		assert.deepEqual((await sent).smsIds, ['answered-after-the-other-gave-up']);
	});

	// Nothing reached the peer, so a drain counting this answered would report an outcome that never was.
	test('leaves a message the library refused to answer unanswered', async t => {
		const { sms, smpp } = await submitInFlight(t, {}, { shutdownTimeout: 50 });
		const refused = await sms.sendResp({ smsId: '' });
		const closed = await peerOf(smpp).close();

		assert.match(refused.err?.message ?? '', /smsId must not be empty/);
		assert.ok(closed.err instanceof Error);
		assert.match(closed.err.message, /1 message\(s\) unanswered/);
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
		// No 'sms' listener, so the single-segment message holding the only slot is never answered.
		const smpp = await startServer(t);
		const onWire = once<PduObject>(resolve => {
			smpp.on('session', bound => bound.on('incomingPduObj', resolve));
		});
		const { session } = await connect(t, smpp, { maxOutstanding: 1, shutdownTimeout: 50 });

		assert.ok(session);

		const holding = session.sendSms({
			from: '46701113311',
			message: 'holds the only slot',
			to: '46709771337',
		});
		const queued = session.sendSms({
			from: '46701113311',
			message: 'x'.repeat(400),
			to: '46709771337',
		});

		await onWire;

		const closed = await session.close();

		assert.ok(closed.err instanceof Error);
		assert.match(closed.err.message, /4 request\(s\)/);
		assert.ok((await holding).err instanceof Error);
		assert.ok((await queued).err instanceof Error);
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
		const incoming = once<Sms>(resolve => {
			smpp.on('session', bound => bound.on('sms', sms => {
				resolve(sms);
				void sms.sendResp();
			}));
		});
		const { session } = await connect(t, smpp, {
			smsIdFormat: { receipt: 'decimal', submitResp: 'hex' },
		});

		assert.ok(session);

		const merged = once<MessageDlr>(resolve => { session.on('messageDlr', resolve); });
		const sent = await sendOne(session, 'x'.repeat(200));
		const sms = await incoming;

		assert.deepEqual(sent.smsIds, [1, 2].map(part => `${sms.smsId}-${String(part)}`));

		for (const smsId of sent.smsIds) {
			await sendReceipt(peerOf(smpp), smsId);
		}

		assert.equal((await merged).smsId, sms.smsId);
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
