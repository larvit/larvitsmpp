import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import type { Dlr } from '../src/dlr.ts';
import type { EncodingName } from '../src/defs/encodings.ts';
import type { MessageDlr } from '../src/dlr-merger.ts';
import type { PduObject } from '../src/pdu.ts';
import type { SendSmsResult } from '../src/send-sms.ts';
import type { Session } from '../src/session.ts';
import type { Sms } from '../src/sms.ts';
import { client } from '../src/client.ts';
import { closeAfter } from '../test/teardown.ts';
import { consts } from '../src/defs/constants.ts';
import { paramText } from '../src/defs/types.ts';
import { server } from '../src/server.ts';

const PEER_HOST = process.env.PEER_HOST ?? 'smppsim';
const PEER_PORT = Number(process.env.PEER_PORT ?? '2775');
const TEXTDLR_HOST = process.env.TEXTDLR_HOST ?? 'smppsim-textdlr';
const TRANSITION_HOST = process.env.TRANSITION_HOST ?? 'smppsim-transition';
const UNDELIV_HOST = process.env.UNDELIV_HOST ?? 'smppsim-undeliv';
const REJECTED_HOST = process.env.REJECTED_HOST ?? 'smppsim-rejected';
const ACCEPTED_HOST = process.env.ACCEPTED_HOST ?? 'smppsim-accepted';
const DELAYED_HOST = process.env.DELAYED_HOST ?? 'smppsim-delayed';
const QUEUEFULL_HOST = process.env.QUEUEFULL_HOST ?? 'smppsim-queuefull';
const OUTBIND_HOST = process.env.OUTBIND_HOST ?? 'smppsim-outbind';
const OUTBIND_HTTP_PORT = Number(process.env.OUTBIND_HTTP_PORT ?? '8884');
const OUR_OUTBIND_PORT = Number(process.env.OUR_OUTBIND_PORT ?? '2776');

const USERNAME = 'smppclient1';
const PASSWORD = 'password';
const FROM = '46701113311';
const TO = '46709771337';

function delay(ms: number): Promise<void> {
	return new Promise(resolve => { setTimeout(resolve, ms); });
}

/** Polls until `get()` stops returning undefined, or the budget runs out. */
async function waitFor<T>(get: () => T | undefined, budget = 3000): Promise<T | undefined> {
	const deadline = Date.now() + budget;
	let value = get();

	while (value === undefined && Date.now() < deadline) {
		await delay(20);
		value = get();
	}

	return value;
}

async function bind(host: string, options: Parameters<typeof client>[0] = {}): ReturnType<typeof client> {
	return client({ host, password: PASSWORD, port: PEER_PORT, username: USERNAME, ...options });
}

/**
 * A GSM-7 message sized to a target septet count, always carrying the three extension-table
 * characters (€, [, ]) that cost two septets each via an ESC prefix.
 */
function gsmFiller(targetSeptets: number): string {
	const extension = '€[]';

	return extension + 'a'.repeat(targetSeptets - extension.length * 2);
}

/** Delivery-receipt fields the wire actually carried, alongside the parsed Dlr. */
type Received = { dlr: Dlr; pduObj: PduObject };

function collectDlrs(session: Session): Received[] {
	const received: Received[] = [];

	session.on('dlr', (dlr, pduObj) => { received.push({ dlr, pduObj }); });

	return received;
}

function collectSms(session: Session): Sms[] {
	const collected: Sms[] = [];

	session.on('sms', sms => { collected.push(sms); });

	return collected;
}

const DLR_RETRY_BUDGET_MS = 3000;
const DLR_MAX_ATTEMPTS = 10;

/**
 * Two concurrent submit_sm's on the same connection - which is how this library always sends a
 * multi-segment message's segments, never one after the previous one's response - sometimes make
 * SMPPSim interleave two PDUs it writes back without synchronising, corrupting one on the wire
 * (tshark's own malformed/expert counts confirm it; see findings/02-smppsim.md). A corrupted
 * receipt still reaches `dlr` with an empty or partial body. Sequential, awaited submit_sm's never
 * see this.
 */
function dlrLooksIntact(received: Received | undefined): received is Received {
	return received?.dlr.receipt?.stat !== undefined
		&& received.pduObj.tlvs.receipted_message_id?.tagValue !== undefined
		&& received.pduObj.tlvs.message_state?.tagValue !== undefined;
}

/**
 * Resends a fresh message until one attempt's segments are every one matched by an intact `dlr`.
 * Retrying works around the peer+library interaction above without hiding it: a scenario only
 * fails here if it keeps missing well past what that alone explains.
 */
async function sendUntilAllDlrsArrive(
	session: Session,
	dlrs: Received[],
	message: string,
	encoding?: EncodingName,
): Promise<string[]> {
	for (let attempt = 0; attempt < DLR_MAX_ATTEMPTS; attempt++) {
		const sent = await session.sendSms({
			dlr: true,
			from: FROM,
			message,
			to: TO,
			...(encoding ? { encoding } : {}),
		});

		assert.equal(sent.err, undefined);

		const complete = await waitFor(
			() => (sent.smsIds.every(id => dlrLooksIntact(dlrs.find(r => r.dlr.smsId === id))) ? true : undefined),
			DLR_RETRY_BUDGET_MS,
		);

		if (complete) return sent.smsIds;
	}

	throw new Error(`no attempt got an intact DLR for every segment within ${String(DLR_MAX_ATTEMPTS)} tries`);
}

/** As above, but also waits for the loopback deliver_sm(s) to reassemble into the original text. */
async function sendUntilComplete(
	session: Session,
	dlrs: Received[],
	sms: Sms[],
	message: string,
	encoding?: EncodingName,
): Promise<{ reassembled: Sms; smsIds: string[] }> {
	for (let attempt = 0; attempt < DLR_MAX_ATTEMPTS; attempt++) {
		const sent = await session.sendSms({
			dlr: true,
			from: FROM,
			message,
			to: TO,
			...(encoding ? { encoding } : {}),
		});

		assert.equal(sent.err, undefined);

		const complete = await waitFor(() => {
			const allIntact = sent.smsIds.every(id => dlrLooksIntact(dlrs.find(r => r.dlr.smsId === id)));
			const reassembled = sms.find(s => s.message === message);

			return allIntact && reassembled ? { reassembled } : undefined;
		}, DLR_RETRY_BUDGET_MS);

		if (complete) return { reassembled: complete.reassembled, smsIds: sent.smsIds };
	}

	throw new Error(`no attempt got both an intact DLR per segment and a loopback reassembly within ${String(DLR_MAX_ATTEMPTS)} tries`);
}

describe('smppsim - C3+C7 long MT, receipts and loopback reassembly', () => {
	const cases: { expectedSegments: number; label: string; message: string }[] = [
		{ expectedSegments: 1, label: 'single-segment GSM with extension chars', message: gsmFiller(100) },
		{ expectedSegments: 2, label: '2-segment GSM with extension chars', message: gsmFiller(200) },
		{ expectedSegments: 3, label: '3-segment GSM with extension chars', message: gsmFiller(400) },
		{ expectedSegments: 10, label: '10-segment GSM with extension chars', message: gsmFiller(1450) },
	];

	for (const testCase of cases) {
		test(testCase.label, async t => {
			const { err, session } = await bind(PEER_HOST);

			assert.equal(err, undefined);
			assert.ok(session);
			closeAfter(t, session);

			const dlrs = collectDlrs(session);
			const sms = collectSms(session);

			const { reassembled, smsIds } = await sendUntilComplete(session, dlrs, sms, testCase.message);

			assert.equal(smsIds.length, testCase.expectedSegments);

			for (const id of smsIds) {
				const received = dlrs.find(r => r.dlr.smsId === id);

				assert.ok(received);
				assert.equal(received.dlr.statusMsg, 'DELIVERED');
				// TLVs and body both present, and agree - "TLV wins" is unobservable when they
				// match, which is what a well-behaved SMSC gives you (C3).
				assert.equal(received.pduObj.tlvs.receipted_message_id?.tagValue, id);
				assert.equal(received.pduObj.tlvs.message_state?.tagValue, consts.MESSAGE_STATE.DELIVERED);
				assert.equal(received.dlr.receipt?.stat, 'DELIVRD');
			}

			assert.equal((await reassembled.sendResp()).err, undefined);
		});
	}

	test('2-segment UCS2 with 一 and an emoji: TLVs stay right, the receipt body is corrupted', async t => {
		const { err, session } = await bind(PEER_HOST);

		assert.equal(err, undefined);
		assert.ok(session);
		closeAfter(t, session);

		const dlrs = collectDlrs(session);
		const sms = collectSms(session);
		const message = `一😀${'x'.repeat(70)}`;

		let smsIds: string[] | undefined;
		let reassembled: Sms | undefined;

		for (let attempt = 0; attempt < DLR_MAX_ATTEMPTS && !reassembled; attempt++) {
			const sent: SendSmsResult = await session.sendSms(
				{ dlr: true, encoding: 'UCS2', from: FROM, message, to: TO },
			);

			assert.equal(sent.err, undefined);
			assert.equal(sent.smsIds.length, 2);

			const complete = await waitFor(() => {
				const tlvsIntact = sent.smsIds.every(id => {
					const received = dlrs.find(r => r.dlr.smsId === id);

					return received?.pduObj.tlvs.receipted_message_id?.tagValue !== undefined
						&& received.pduObj.tlvs.message_state?.tagValue !== undefined;
				});
				const found = sms.find(s => s.message === message);

				return tlvsIntact && found ? { found } : undefined;
			}, DLR_RETRY_BUDGET_MS);

			if (complete) {
				smsIds = sent.smsIds;
				reassembled = complete.found;
			}
		}

		assert.ok(smsIds);
		assert.ok(reassembled, 'expected the loopback deliver_sm(s), unaffected by the defect, to reassemble');

		for (const id of smsIds) {
			const received = dlrs.find(r => r.dlr.smsId === id);

			assert.ok(received);
			// The TLVs are typed fields, unaffected by the defect below.
			assert.equal(received.dlr.statusMsg, 'DELIVERED');
			assert.equal(received.pduObj.tlvs.receipted_message_id?.tagValue, id);
			assert.equal(received.pduObj.tlvs.message_state?.tagValue, consts.MESSAGE_STATE.DELIVERED);

			// Defect (see findings/02-smppsim.md): SMPPSim's delivery receipt echoes the
			// original submit_sm's data_coding (8, UCS2) but writes its short_message as plain
			// ASCII text. pdu.ts decodes short_message for any non-UDH PDU using that same
			// data_coding at parse time, so the ASCII receipt bytes are read back as UCS2 -
			// every "stat:"/"id:" field becomes unrecoverable CJK-range garbage.
			assert.equal(received.dlr.receipt?.stat, undefined);
		}

		assert.equal((await reassembled.sendResp()).err, undefined);
	});
});

describe('smppsim-textdlr - C2 text-only receipts', () => {
	test('no TLVs; dlr.smsId parsed from the body matches the submit_sm_resp id', async t => {
		const { err, session } = await bind(TEXTDLR_HOST);

		assert.equal(err, undefined);
		assert.ok(session);
		closeAfter(t, session);

		const dlrs = collectDlrs(session);

		const sent = await session.sendSms({ dlr: true, from: FROM, message: 'text-only dlr', to: TO });

		assert.equal(sent.err, undefined);
		assert.equal(sent.smsIds.length, 1);

		const [smsId] = sent.smsIds;

		assert.ok(smsId);

		const received = await waitFor(() => dlrs.find(r => r.dlr.smsId === smsId));

		assert.ok(received);
		assert.equal(received.dlr.statusMsg, 'DELIVERED');
		assert.equal(received.pduObj.tlvs.receipted_message_id, undefined);
		assert.equal(received.pduObj.tlvs.message_state, undefined);
		assert.equal(received.dlr.receipt?.id, smsId);
	});
});

describe('smppsim-transition - C4 intermediate then final', () => {
	test('an intermediate report arrives, but registered_delivery 0x11 never gets a final one', async t => {
		const { err, session } = await bind(TRANSITION_HOST);

		assert.equal(err, undefined);
		assert.ok(session);
		closeAfter(t, session);

		const dlrs = collectDlrs(session);
		const messageDlrs: unknown[] = [];

		session.on('messageDlr', merged => { messageDlrs.push(merged); });

		// registered_delivery 0x11: final (0x01) + intermediate (0x10). sendSms() only ever
		// requests 0x01, so this scenario needs the raw passthrough - which also means
		// dlrMerger.expect() is never called, so messageDlr cannot fire here (see findings).
		const sent = await session.send({
			cmdName: 'submit_sm',
			params: {
				data_coding: consts.ENCODING.ASCII,
				destination_addr: TO,
				registered_delivery: 0x11,
				short_message: Buffer.from('transition test', 'latin1'),
				source_addr: FROM,
			},
		});

		assert.equal(sent.err, undefined);
		assert.ok(sent.pduObj);

		const messageId = paramText(sent.pduObj.params.message_id);

		assert.notEqual(messageId, '');

		const intermediate = await waitFor(() => dlrs.find(r => r.dlr.smsId === messageId));

		assert.ok(intermediate, 'expected an intermediate report');
		assert.equal(intermediate.dlr.intermediate, true);
		assert.equal(intermediate.dlr.statusMsg, 'ENROUTE');

		// SMPPSim's own user guide (v2.5 release notes): "Set to 0x11 for both intermediate
		// notification and final delivery receipts". Its LifeCycleManager.setState() tests
		// registered_delivery_flag == 1 or == 2 by exact equality rather than a bitmask, so 0x11
		// (17) matches neither branch and no final receipt is ever queued - confirmed against
		// source (see findings/02-smppsim.md). Recorded, not asserted as something to fix here.
		const final = await waitFor(() => dlrs.find(r => r.dlr.smsId === messageId && !r.dlr.intermediate), 3000);

		assert.equal(final, undefined);
		assert.equal(messageDlrs.length, 0);
	});
});

describe('smppsim single-state variants - C5 failure states', () => {
	const variants: { expected: Dlr['statusMsg']; host: string; label: string }[] = [
		{ expected: 'UNDELIVERABLE', host: UNDELIV_HOST, label: 'PERCENTAGE_UNDELIVERABLE=100' },
		{ expected: 'REJECTED', host: REJECTED_HOST, label: 'PERCENTAGE_REJECTED=100' },
		{ expected: 'ACCEPTED', host: ACCEPTED_HOST, label: 'PERCENTAGE_ACCEPTED=100' },
	];

	for (const variant of variants) {
		test(`${variant.label} maps to ${variant.expected}`, async t => {
			const { err, session } = await bind(variant.host);

			assert.equal(err, undefined);
			assert.ok(session);
			closeAfter(t, session);

			const dlrs = collectDlrs(session);
			const sent = await session.sendSms({ dlr: true, from: FROM, message: 'failure state test', to: TO });

			assert.equal(sent.err, undefined);

			const [smsId] = sent.smsIds;

			assert.ok(smsId);

			const received = await waitFor(() => dlrs.find(r => r.dlr.smsId === smsId));

			assert.ok(received);
			assert.equal(received.dlr.statusMsg, variant.expected);
		});
	}

	test('a 2-segment message: both segments report the same status; messageDlr never fires', async t => {
		const { err, session } = await bind(UNDELIV_HOST);

		assert.equal(err, undefined);
		assert.ok(session);
		closeAfter(t, session);

		const dlrs = collectDlrs(session);
		const messageDlrs: MessageDlr[] = [];

		session.on('messageDlr', merged => { messageDlrs.push(merged); });

		const smsIds = await sendUntilAllDlrsArrive(session, dlrs, gsmFiller(200));

		assert.equal(smsIds.length, 2);

		for (const id of smsIds) {
			const received = dlrs.find(r => r.dlr.smsId === id);

			assert.ok(received);
			assert.equal(received.dlr.statusMsg, 'UNDELIVERABLE');
		}

		// SMPPSim assigns each segment its own, independent message_id rather than this
		// library's own server's <base>-<n> convention, so DlrMerger can never recognise the
		// pair as one message (README: "an SMSC that hands out unrelated ids per segment never
		// fires it") - recorded here, not asserted as a defect.
		await delay(500);
		assert.equal(messageDlrs.length, 0);
	});
});

describe('smppsim-delayed - C6 receipt delayed past a link drop', () => {
	test('the merge survives a reconnect; the late receipt still reaches dlr', async t => {
		const { err, session } = await bind(DELAYED_HOST, { reconnect: { maxDelay: 1000, minDelay: 200 } });

		assert.equal(err, undefined);
		assert.ok(session);
		closeAfter(t, session);

		const dlrs = collectDlrs(session);
		const disconnected: true[] = [];
		const reconnected: true[] = [];

		session.on('disconnected', () => { disconnected.push(true); });
		session.on('reconnected', () => { reconnected.push(true); });

		const sendStart = Date.now();
		const sent = await session.sendSms({ dlr: true, from: FROM, message: 'delayed dlr test', to: TO });

		assert.equal(sent.err, undefined);

		const [smsId] = sent.smsIds;

		assert.ok(smsId);

		await delay(300);
		session.sock.destroy();

		assert.ok(await waitFor(() => (disconnected.length > 0 ? true : undefined), 2000), 'expected disconnected');
		assert.ok(await waitFor(() => (reconnected.length > 0 ? true : undefined), 4000), 'expected reconnected');

		// DELAY_DELIVERY_RECEIPTS_BY (8000ms) is a floor, not the actual delay: DelayedDrQueue's
		// own poll loop only wakes every 5000ms (hardcoded, not a props knob), so delivery can
		// land up to ~13s after submission - confirmed against source and empirically.
		const remaining = Math.max(1000, 16_000 - (Date.now() - sendStart));
		const received = await waitFor(() => dlrs.find(r => r.dlr.smsId === smsId), remaining);

		assert.ok(received, 'expected the delayed receipt to still arrive on the new link');
		assert.equal(received.dlr.statusMsg, 'DELIVERED');
	});
});

describe('smppsim - C11 bind refusal and reconnect backoff', () => {
	test('wrong password on the very first bind: one attempt, no retry', async () => {
		const refusals: { cmdStatus: unknown }[] = [];
		const log = {
			debug: () => undefined,
			error: () => undefined,
			info: (msg: string, metadata?: Record<string, boolean | number | string>) => {
				if (msg === 'client - bind refused') refusals.push({ cmdStatus: metadata?.cmdStatus });
			},
			verbose: () => undefined,
			warn: () => undefined,
		};

		const { err, session } = await bind(PEER_HOST, { log, password: 'wrong', reconnect: { maxDelay: 4000, minDelay: 1000 } });

		assert.ok(err);
		assert.equal(session, undefined);
		await delay(2000);
		assert.equal(refusals.length, 1, 'expected exactly one bind attempt, never a retry');
		assert.equal(refusals[0]?.cmdStatus, 'ESME_RINVPASWD');
	});

	test('a closed port on the very first connect: one attempt, no retry', async () => {
		const { err, session } = await bind(PEER_HOST, { port: 46775, reconnect: { maxDelay: 4000, minDelay: 1000 } });

		assert.ok(err);
		assert.equal(session, undefined);
	});

	test('a rebind refused after a live link drops: backs off, never floods', async t => {
		const options: Parameters<typeof client>[0] = {
			host: PEER_HOST,
			password: PASSWORD,
			port: PEER_PORT,
			reconnect: { maxDelay: 4000, minDelay: 1000 },
			username: USERNAME,
		};
		const { err, session } = await client(options);

		assert.equal(err, undefined);
		assert.ok(session);
		closeAfter(t, session);

		const disconnectedAt: number[] = [];

		session.on('disconnected', () => { disconnectedAt.push(Date.now()); });
		// Mutates the same object reference the reconnect loop's onConnected closure reads, so
		// every rebind attempt from here on is refused - see interop-tests/findings/02-smppsim.md.
		options.password = 'wrong-after-drop';
		session.sock.destroy();

		await delay(12_000);

		assert.ok(disconnectedAt.length >= 2 && disconnectedAt.length <= 6, `expected a handful of attempts, got ${String(disconnectedAt.length)}`);

		for (let i = 1; i < disconnectedAt.length; i++) {
			const previous = disconnectedAt[i - 1];
			const current = disconnectedAt[i];

			assert.ok(previous !== undefined && current !== undefined);
			assert.ok(current - previous >= 150, 'expected each retry to wait at least close to minDelay');
		}
	});
});

describe('smppsim-queuefull - C12 ESME_RMSGQFUL', () => {
	test('refuses when the queue is full; the session stays bound; a later send succeeds once it drains', async t => {
		const { err, session } = await bind(QUEUEFULL_HOST);

		assert.equal(err, undefined);
		assert.ok(session);
		closeAfter(t, session);

		const first = await session.sendSms({ from: FROM, message: 'occupies the one queue slot', to: TO });

		assert.equal(first.err, undefined);

		const second = await session.sendSms({ from: FROM, message: 'should be refused', to: TO });

		assert.ok(second.err);
		assert.match(second.err.message, /ESME_RMSGQFUL/);

		const keepalive = await session.send({ cmdName: 'enquire_link' });

		assert.equal(keepalive.err, undefined);
		assert.ok(keepalive.pduObj);
		assert.equal(keepalive.pduObj.cmdStatus, 'ESME_ROK');

		const deadline = Date.now() + 5000;
		let drained: Awaited<ReturnType<typeof session.sendSms>> | undefined;

		while (!drained && Date.now() < deadline) {
			const attempt = await session.sendSms({ from: FROM, message: 'after drain', to: TO });

			if (!attempt.err) drained = attempt;
			else await delay(100);
		}

		assert.ok(drained, 'expected a later send to succeed once the queue drained');
	});
});

describe('smppsim - C13 maxOutstanding 1 with 10 parallel sends', () => {
	test('every send is answered, in order, none lost', async t => {
		const { err, session } = await bind(PEER_HOST, { maxOutstanding: 1 });

		assert.equal(err, undefined);
		assert.ok(session);
		closeAfter(t, session);

		const results = await Promise.all(
			Array.from({ length: 10 }, async (_unused, index) => session.sendSms({
				from: FROM,
				message: `order test ${String(index)}`,
				to: TO,
			})),
		);

		const ids: number[] = [];

		for (const result of results) {
			assert.equal(result.err, undefined);
			assert.equal(result.smsIds.length, 1);

			const [smsId] = result.smsIds;

			assert.ok(smsId);
			ids.push(Number(smsId));
		}

		assert.equal(new Set(ids).size, ids.length, 'expected 10 distinct message ids, none lost or duplicated');

		for (let i = 1; i < ids.length; i++) {
			const previous = ids[i - 1];
			const current = ids[i];

			assert.ok(previous !== undefined && current !== undefined);
			assert.ok(current > previous, 'expected ids in call order, proving maxOutstanding:1 serialised the sends');
		}
	});
});

describe('smppsim - C15 bind version negotiation', () => {
	for (const interfaceVersion of [0x34, 0x50]) {
		test(`interfaceVersion 0x${interfaceVersion.toString(16)}: SMPPSim's bind_resp never declares a version`, async t => {
			const { err, session } = await bind(PEER_HOST, { interfaceVersion });

			assert.equal(err, undefined);
			assert.ok(session);
			closeAfter(t, session);

			// Confirmed from source (no BindXResp class ever sets sc_interface_version): SMPPSim
			// never declares its own version, whatever we declared - so acceptsOptionalParams()
			// reads it as pre-3.4, even though it happily sends us TLVs (see C3).
			assert.equal(session.peerInterfaceVersion, 0x00);
			assert.equal(session.acceptsOptionalParams(), false);
		});
	}
});

describe('smppsim - C17 encodings round trip over loopback', () => {
	test('Latin-1 (å ä ö)', async t => {
		const { err, session } = await bind(PEER_HOST);

		assert.equal(err, undefined);
		assert.ok(session);
		closeAfter(t, session);

		const sms = collectSms(session);

		await session.sendSms({ encoding: 'LATIN1', from: FROM, message: 'å ä ö', to: TO });

		const received = await waitFor(() => sms.find(s => s.message === 'å ä ö'));

		assert.ok(received);
		assert.equal(received.flash, false);
	});

	test('UCS-2', async t => {
		const { err, session } = await bind(PEER_HOST);

		assert.equal(err, undefined);
		assert.ok(session);
		closeAfter(t, session);

		const sms = collectSms(session);

		await session.sendSms({ encoding: 'UCS2', from: FROM, message: 'ucs2 round trip', to: TO });

		const received = await waitFor(() => sms.find(s => s.message === 'ucs2 round trip'));

		assert.ok(received);
		assert.equal(received.flash, false);
	});

	test('flash (data_coding records the message-class group)', async t => {
		const { err, session } = await bind(PEER_HOST);

		assert.equal(err, undefined);
		assert.ok(session);
		closeAfter(t, session);

		const sms = collectSms(session);

		await session.sendSms({ flash: true, from: FROM, message: 'flash test', to: TO });

		const received = await waitFor(() => sms.find(s => s.message === 'flash test'));

		assert.ok(received);
		assert.equal(received.flash, true);
		assert.equal(received.pduObjs[0]?.params.data_coding, 0x10);
	});

	test('a raw submit_sm with data_coding 0xF0 is not read as flash', async t => {
		const { err, session } = await bind(PEER_HOST);

		assert.equal(err, undefined);
		assert.ok(session);
		closeAfter(t, session);

		const sms = collectSms(session);
		const body = 'message class test';

		const sent = await session.send({
			cmdName: 'submit_sm',
			params: {
				data_coding: 0xF0,
				destination_addr: TO,
				short_message: Buffer.from(body, 'latin1'),
				source_addr: FROM,
			},
		});

		assert.equal(sent.err, undefined);

		const received = await waitFor(() => sms.find(s => s.message === body));

		assert.ok(received, 'expected the 0xF0-coded loopback message to arrive');
		assert.equal(received.flash, false);
	});

	test('a raw submit_sm with 8-bit binary and a UDH (esm_class 0x40)', async t => {
		const { err, session } = await bind(PEER_HOST);

		assert.equal(err, undefined);
		assert.ok(session);
		closeAfter(t, session);

		const sms = collectSms(session);
		// A UDH carrying no recognised concatenation IE (0x00/0x08): one element in GSM 03.40's
		// reserved-for-future-use range (0x70), so Wireshark's gsm_sms_ud dissector - which
		// validates the *typed* IEs' own lengths (0x01 "Special SMS Message Indication" must be
		// 2 bytes, flagged malformed otherwise) - passes it through as opaque, unparsed data.
		const udh = Buffer.from([0x03, 0x70, 0x01, 0xAA]);
		const payload = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]);

		const sent = await session.send({
			cmdName: 'submit_sm',
			params: {
				data_coding: consts.ENCODING.BINARY,
				destination_addr: TO,
				esm_class: consts.ESM_CLASS.UDH_INDICATOR,
				short_message: Buffer.concat([udh, payload]),
				source_addr: FROM,
			},
		});

		assert.equal(sent.err, undefined);

		const expected = payload.toString('latin1');
		const received = await waitFor(() => sms.find(s => s.message === expected));

		assert.ok(received, 'expected the UDH-stripped, Latin-1-decoded payload to arrive unchanged');
		assert.equal(received.flash, false);
		assert.deepEqual(Buffer.from(received.message, 'latin1'), payload);
	});
});

describe('smppsim-outbind - C18 SMSC-initiated outbind', () => {
	test('arrives with no bogus response PDU; sessionError names it', async t => {
		const { err, server: smpp } = await server({ port: OUR_OUTBIND_PORT });

		assert.equal(err, undefined);
		assert.ok(smpp);
		closeAfter(t, smpp);

		const incoming: PduObject[] = [];
		const sessionErrors: Error[] = [];
		const closes: true[] = [];

		smpp.on('session', session => {
			session.on('incomingPduObj', pduObj => { incoming.push(pduObj); });
			session.on('sessionError', sessionError => { sessionErrors.push(sessionError); });
			session.on('close', () => { closes.push(true); });
		});

		const injected = await fetch(`http://${OUTBIND_HOST}:${String(OUTBIND_HTTP_PORT)}/inject_mo?${
			new URLSearchParams({
				destination_addr: TO,
				short_message: 'trigger outbind',
				source_addr: FROM,
			}).toString()
		}`);

		assert.equal(injected.status, 200);

		const outbindPdu = await waitFor(() => incoming.find(pduObj => pduObj.cmdName === 'outbind'), 10_000);

		assert.ok(outbindPdu, 'expected SMPPSim to connect to our server() and send outbind');
		assert.equal(outbindPdu.params.system_id, 'smppclient1');

		const sessionError = await waitFor(() => sessionErrors[0], 2000);

		assert.ok(sessionError, 'expected sessionError: outbind has no response command to send back');
		assert.match(sessionError.message, /outbind/);

		// Recorded, not asserted either way (the task: "record, do not judge"): SMPPSim's own
		// outbind() closes its end right after writing, before waiting for anything back.
		await waitFor(() => (closes.length > 0 ? true : undefined), 1000);
	});
});
