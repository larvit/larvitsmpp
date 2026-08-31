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

type Gate = { open: () => void; passed: Promise<true> };

/** A promise the test opens by hand, guarded by once() against waiting on one it never does. */
function gate(): Gate {
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
		const { session } = await connect(t, smpp);

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

		await peerOf(smpp).close();
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
	async function submitInFlight(t: TestContext, options: Parameters<typeof client>[0] = {}) {
		const smpp = await startServer(t);
		const incoming = once<Sms>(resolve => {
			smpp.on('session', bound => bound.on('sms', resolve));
		});
		const { session } = await connect(t, smpp, options);

		assert.ok(session);

		const sent = session.sendSms({ from: '46701113311', message: 'answer me', to: '46709771337' });

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

	test('unbind() waits out a submit already on the wire before it unbinds', async t => {
		const { sent, session, sms } = await submitInFlight(t);
		const unbound = session.unbind();

		await sms.sendResp({ smsId: 'answered-before-unbind' });

		assert.deepEqual((await sent).smsIds, ['answered-before-unbind']);
		assert.deepEqual(await unbound, {});
	});

	test('gives up on a request that outlasts shutdownTimeout', async t => {
		const { sent, session } = await submitInFlight(t, { shutdownTimeout: 50 });
		const closed = await session.close();

		assert.ok(closed.err instanceof Error);
		assert.match(closed.err.message, /unfinished/);

		const result = await sent;

		assert.ok(result.err instanceof Error);
		assert.equal(result.err.message, 'Session closed before a response arrived');
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

		const rebinding = gate();
		const release = gate();
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
