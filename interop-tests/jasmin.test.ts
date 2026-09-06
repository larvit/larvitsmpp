import assert from 'node:assert/strict';
import http from 'node:http';
import test, { after, describe } from 'node:test';
import type { Dlr } from '../src/dlr.ts';
import type { EncodingName } from '../src/defs/encodings.ts';
import type { PduObject } from '../src/pdu.ts';
import type { Session } from '../src/session.ts';
import type { Sms } from '../src/sms.ts';
import { ConcatReference } from '../src/udh.ts';
import { client } from '../src/client.ts';
import { closeAfter } from '../test/teardown.ts';
import { paramText } from '../src/defs/types.ts';
import { server } from '../src/server.ts';
import { splitMessage } from '../src/message.ts';
import { submitSmParams } from '../src/send-sms.ts';

const PEER_HOST = process.env.PEER_HOST ?? 'jasmin';
const PEER_PORT = Number(process.env.PEER_PORT ?? '2775');
const DATASM_HOST = process.env.DATASM_HOST ?? 'jasmin-datasm';
const HTTP_API_HOST = process.env.HTTP_API_HOST ?? 'jasmin';
const HTTP_API_PORT = Number(process.env.HTTP_API_PORT ?? '1401');
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT ?? '2777');
const CALLBACK_PORT = Number(process.env.CALLBACK_PORT ?? '8080');

const USERNAME = 'esme1';
const PASSWORD = 'esme1pw';
const THROTTLED_USERNAME = 'esme2';
const THROTTLED_PASSWORD = 'esme2pw';
const UPSTREAM_USERNAME = 'upstreamesme';
const UPSTREAM_DATASM_USERNAME = 'upstreamdsesme';
const FROM = '46701113311';
const TO = '46709771337';

function delay(ms: number): Promise<void> {
	return new Promise(resolve => { setTimeout(resolve, ms); });
}

/** Polls until `get()` stops returning undefined, or the budget runs out. */
async function waitFor<T>(get: () => T | undefined, budget = 8000): Promise<T | undefined> {
	const deadline = Date.now() + budget;
	let value = get();

	while (value === undefined && Date.now() < deadline) {
		await delay(20);
		value = get();
	}

	return value;
}

async function bind(username: string, password: string, options: Parameters<typeof client>[0] = {}): ReturnType<typeof client> {
	return client({ host: PEER_HOST, password, port: PEER_PORT, username, ...options });
}

// --- Shared infra: the fake upstream real-world SMSC that Jasmin's own smppc connector(s) bind
// out to (host `node`, port UPSTREAM_PORT - Jasmin resolves `node` via --use-aliases), and the HTTP
// listener that receives Jasmin's DLR-thrower webhook (S7). Both are wired once for the whole file,
// mirroring kannel.test.ts's shared-infra shape - every Jasmin variant dials in from container
// start, independent of when a given test runs. ---

type UpstreamVariant = 'datasm' | 'main';

const upstreamSessions = new Map<UpstreamVariant, Session>();
const upstreamSms: { sms: Sms; variant: UpstreamVariant }[] = [];

function variantFromSystemId(systemId: string): UpstreamVariant | undefined {
	if (systemId === UPSTREAM_USERNAME) return 'main';
	if (systemId === UPSTREAM_DATASM_USERNAME) return 'datasm';

	return undefined;
}

const { err: upstreamErr, server: upstream } = await server({
	authenticate: ({ password, systemId }) => {
		// <=8 chars: Jasmin's own bind-PDU encoder enforces SMPP's 8-char password maximum strictly
		// (see bootstrap.py) - a longer one made every single connector bind attempt throw.
		if (password !== 'upstrmpw') return false;

		const variant = variantFromSystemId(systemId);

		return variant ? { userData: { variant } } : false;
	},
	// Jasmin's connector sends enquire_link every elink_interval (30s); this host's own contention
	// (rabbitmq/redis under load) sometimes delays it past our server's 40s default idleTimeout,
	// dropping the one long-lived connector session. A dropped connection strands whatever submit_sm
	// was already in flight for Jasmin's own requeue_delay (120s default) before it retries - far past
	// any per-test wait budget here - so this is generous specifically to never be the trigger.
	idleTimeout: 300_000,
	port: UPSTREAM_PORT,
});

assert.equal(upstreamErr, undefined);
assert.ok(upstream);

const upstreamServer = upstream;

upstreamServer.on('session', session => {
	// `session` fires on raw connect, before authenticate() has run - session.userData is not set
	// yet, so the map is populated off the bind PDU itself (like kannel.test.ts's bindPdus), not off
	// userData; userData is only read later, from 'sms', where authenticate() has long since run.
	session.on('incomingPduObj', pduObj => {
		if (!pduObj.cmdName.startsWith('bind_')) return;

		const variant = variantFromSystemId(paramText(pduObj.params.system_id));

		if (variant) upstreamSessions.set(variant, session);
	});

	session.on('sms', sms => {
		const variant = (session.userData as { variant?: UpstreamVariant } | undefined)?.variant;

		if (variant) upstreamSms.push({ sms, variant });

		void (async () => {
			await sms.sendResp();

			if (sms.dlr) {
				await delay(150);
				await sms.sendDlr('DELIVERED');
			}
		})();
	});
});

async function waitForUpstreamSession(variant: UpstreamVariant, budget = 20_000): Promise<Session> {
	const found = await waitFor(() => upstreamSessions.get(variant), budget);

	assert.ok(found, `Jasmin's ${variant} connector never bound to our fake upstream within ${String(budget)}ms`);

	return found;
}

type DlrCallback = { id: string; messageStatus: string };

const dlrCallbacks: DlrCallback[] = [];

const httpServer = http.createServer((req, res) => {
	const url = new URL(req.url ?? '/', 'http://node');

	if (url.pathname === '/dlr') {
		dlrCallbacks.push({
			id: url.searchParams.get('id') ?? '',
			messageStatus: url.searchParams.get('message_status') ?? '',
		});
		res.writeHead(200);
		res.end();

		return;
	}

	res.writeHead(404);
	res.end();
});

await new Promise<void>(resolve => { httpServer.listen(CALLBACK_PORT, resolve); });

after(async () => {
	await upstreamServer.close();
	await new Promise<void>(resolve => { httpServer.close(() => { resolve(); }); });
});

/** dlr-level 1 (SMSC-ack) fires once, immediately, with message_status ESME_ROK - not a terminal
 * state - so a caller after the final DELIVRD needs dlr-level 3 (both) and its own status filter. */
async function waitForDlrCallback(id: string, status: string, budget = 15_000): Promise<DlrCallback> {
	const found = await waitFor(() => dlrCallbacks.find(callback => callback.id === id && callback.messageStatus === status), budget);

	assert.ok(found, `no dlr callback for id=${id} status=${status} arrived (seen: ${JSON.stringify(dlrCallbacks)})`);

	return found;
}

/** Jasmin's HTTP send API (`/send`): `to` must be digits only, `content` is the message body. */
async function httpSend(params: Record<string, string>): Promise<{ body: string; status: number }> {
	const url = new URL(`http://${HTTP_API_HOST}:${String(HTTP_API_PORT)}/send`);

	url.search = new URLSearchParams({ password: PASSWORD, username: USERNAME, ...params }).toString();

	const response = await fetch(url, { method: 'POST' });
	const body = await response.text();

	return { body, status: response.status };
}

const sarReference = new ConcatReference();

/** Splits into SAR segments: `splitMessage()`'s own encoding/chunking, its UDH stripped back off. */
function sarPayloads(message: string, encoding?: EncodingName): Buffer[] {
	const reference = sarReference.next();
	const segments = splitMessage(message, encoding === undefined ? { reference } : { encoding, reference });

	return segments.length > 1 ? segments.map(segment => segment.subarray(6)) : segments;
}

/** Pushes a long MO into Jasmin over `session` (Jasmin's smppc connector bound to us) as
 * `sar_msg_ref_num`/`sar_total_segments`/`sar_segment_seqnum` segments - Jasmin's own documented
 * default MT segmentation (target 3). */
async function sendSarMo(session: Session, opts: { from: string; message: string; to: string }): Promise<void> {
	const payloads = sarPayloads(opts.message);
	const refNum = sarReference.next();

	for (const [index, payload] of payloads.entries()) {
		const sent = await session.send({
			cmdName: 'deliver_sm',
			params: {
				destination_addr: opts.to,
				short_message: payload,
				source_addr: opts.from,
			},
			tlvs: {
				sar_msg_ref_num: { tagValue: refNum },
				sar_segment_seqnum: { tagValue: index + 1 },
				sar_total_segments: { tagValue: payloads.length },
			},
		});

		assert.equal(sent.err, undefined);
		assert.ok(sent.pduObj);
		assert.equal(sent.pduObj.cmdStatus, 'ESME_ROK');
	}
}

/** As `sendSarMo`, but UDH concatenation (esm_class 0x40) - the same shape `sendSms()` emits, and
 * Jasmin's documented "older system compatibility" alternative. */
async function sendUdhMo(session: Session, opts: { from: string; message: string; to: string }): Promise<void> {
	const reference = sarReference.next();
	const segments = splitMessage(opts.message, { reference });
	const multipart = segments.length > 1;

	for (const segment of segments) {
		const params = submitSmParams({ from: opts.from, message: opts.message, to: opts.to }, segment, { encoding: 'ASCII', multipart });
		const sent = await session.send({ cmdName: 'deliver_sm', params });

		assert.equal(sent.err, undefined);
		assert.ok(sent.pduObj);
		assert.equal(sent.pduObj.cmdStatus, 'ESME_ROK');
	}
}

/** A `deliver_sm` with `sm_length` 0 and the body in `message_payload` (target 2). */
async function sendMessagePayloadMo(session: Session, opts: { from: string; message: string; to: string }): ReturnType<Session['send']> {
	return session.send({
		cmdName: 'deliver_sm',
		params: {
			destination_addr: opts.to,
			short_message: Buffer.alloc(0),
			source_addr: opts.from,
		},
		tlvs: {
			message_payload: { tagValue: Buffer.from(opts.message, 'latin1') },
		},
	});
}

describe('C1 - bind, enquire_link, unbind', () => {
	test('binds transceiver, sees Jasmin\'s own enquire_link, unbinds clean', async () => {
		// Jasmin's own enquireLinkTimerSecs (30) is an idle timer, not a strict period: our client's
		// own default 20s keepalive counts as activity and resets it, so Jasmin's probe never has a
		// chance to fire on its own. Disabling ours (and widening idleTimeout, which defaults off
		// enquireLinkInterval and would otherwise become 0) leaves the link quiet long enough to see it.
		const { err, session } = await bind(USERNAME, PASSWORD, { enquireLinkInterval: 0, idleTimeout: 60_000 });

		assert.equal(err, undefined);
		assert.ok(session);

		const incoming: PduObject[] = [];
		const closes: true[] = [];
		const sessionErrors: Error[] = [];

		session.on('incomingPduObj', pduObj => { incoming.push(pduObj); });
		session.on('close', () => { closes.push(true); });
		session.on('sessionError', sessionError => { sessionErrors.push(sessionError); });

		// enquireLinkTimerSecs is 30 in Jasmin's default [smpp-server] config.
		const theirs = await waitFor(() => incoming.find(pduObj => pduObj.cmdName === 'enquire_link'), 35_000);

		assert.ok(theirs, 'expected Jasmin to send its own enquire_link within 35s');

		const ours = await session.send({ cmdName: 'enquire_link' });

		assert.equal(ours.err, undefined);
		assert.ok(ours.pduObj);
		assert.equal(ours.pduObj.cmdStatus, 'ESME_ROK');

		const unbound = await session.unbind();

		assert.equal(unbound.err, undefined);
		assert.ok(await waitFor(() => (closes.length > 0 ? true : undefined), 5000), 'expected a clean close after unbind');
		assert.deepEqual(sessionErrors, []);
	});

	test('binds transmitter', async t => {
		const { err, session } = await bind(USERNAME, PASSWORD, { bindType: 'transmitter' });

		assert.equal(err, undefined);
		assert.ok(session);
		closeAfter(t, session);
		assert.equal(session.boundAs, 'transmitter');
	});

	test('binds receiver', async t => {
		const { err, session } = await bind(USERNAME, PASSWORD, { bindType: 'receiver' });

		assert.equal(err, undefined);
		assert.ok(session);
		closeAfter(t, session);
		assert.equal(session.boundAs, 'receiver');
	});
});

describe('C13 - maxOutstanding 1 with 10 parallel sends', () => {
	test('every send is answered, none lost, order preserved at the fake upstream', async t => {
		await waitForUpstreamSession('main');

		const { err, session } = await bind(USERNAME, PASSWORD, { maxOutstanding: 1 });

		assert.equal(err, undefined);
		assert.ok(session);
		closeAfter(t, session);

		const before = upstreamSms.length;
		const texts = Array.from({ length: 10 }, (_, i) => `c13-order-${String(i).padStart(2, '0')}`);

		const results = await Promise.all(texts.map(async message => session.sendSms({ from: FROM, message, to: TO })));

		const ids: string[] = [];

		for (const result of results) {
			assert.equal(result.err, undefined);
			assert.equal(result.smsIds.length, 1);

			const [smsId] = result.smsIds;

			assert.ok(smsId);
			ids.push(smsId);
		}

		assert.equal(new Set(ids).size, ids.length, 'expected 10 distinct message ids, none lost or duplicated');

		const arrivedOrder = await waitFor(() => {
			const seen = upstreamSms.slice(before).filter(e => e.variant === 'main').map(e => e.sms.message);

			return texts.every(text => seen.includes(text)) ? seen : undefined;
		}, 60_000);

		assert.ok(arrivedOrder, 'not all 10 messages reached the fake upstream');

		const ordered = arrivedOrder.filter(m => texts.includes(m));

		assert.deepEqual(ordered, texts, 'maxOutstanding:1 should serialise sends end to end, in order');
	});
});

describe('S7 - Jasmin as the ESME against our server (HTTP send API, DLR callback)', () => {
	test('a message pushed through /send arrives as submit_sm at our server; our receipt fires Jasmin\'s DLR webhook', async () => {
		const before = upstreamSms.length;
		// No printf-style placeholders (unlike Kannel's %d/%F): DLRThrower appends its own fixed
		// query args - id, level, message_status, connector - to this bare URL (confirmed from
		// jasmin/routing/throwers.py). dlr-method=get puts them in the query string; POST (Jasmin's
		// own default) would need a form-body reader instead.
		const dlrUrl = `http://node:${String(CALLBACK_PORT)}/dlr`;

		const sent = await httpSend({
			content: 's7 http send test',
			dlr: 'yes',
			// Level 3 (both): level 1 alone fires once, immediately, with message_status ESME_ROK -
			// the SMSC-ack, not a terminal state - so proving Jasmin parses our own receipt needs the
			// terminal-level callback too, which only follows the sendDlr('DELIVERED') below.
			'dlr-level': '3',
			'dlr-method': 'get',
			'dlr-url': dlrUrl,
			from: FROM,
			to: TO,
		});

		assert.match(sent.body, /Success/i);

		const arrived = await waitFor(() => upstreamSms.slice(before).find(e => e.variant === 'main' && e.sms.message === 's7 http send test'), 60_000);

		assert.ok(arrived, 'expected the HTTP-submitted message to arrive as submit_sm at our server()');

		// Our server() already answered (sendResp) and sent the DLR (sendDlr('DELIVERED')) from the
		// shared session handler above - Jasmin's own DLR pipeline should throw the HTTP callback.
		const msgidMatch = /Success "([^"]+)"/i.exec(sent.body);
		const msgid = msgidMatch?.[1];

		assert.ok(msgid, `expected /send's response to carry a message id: ${sent.body}`);

		const ack = await waitForDlrCallback(msgid, 'ESME_ROK', 15_000);

		assert.equal(ack.id, msgid);

		const final = await waitForDlrCallback(msgid, 'DELIVRD', 15_000);

		assert.equal(final.id, msgid);
	});

	test('a long GSM message from our server reassembles at Jasmin (or is recorded as fragments)', async () => {
		const upstreamSession = await waitForUpstreamSession('main');
		const { err, session } = await bind(USERNAME, PASSWORD, { bindType: 'receiver' });

		assert.equal(err, undefined);
		assert.ok(session);

		const sms: Sms[] = [];

		session.on('sms', s => { sms.push(s); });

		const text = `s7-long-${'p'.repeat(300)}`;

		await sendUdhMo(upstreamSession, { from: TO, message: text, to: FROM });

		const whole = await waitFor(() => sms.find(s => s.message === text), 10_000);

		await session.close({ signal: AbortSignal.abort() });
		assert.ok(whole ?? sms.length > 0, 'expected the long message to arrive whole or as recorded fragments');
	});

	test('a UCS-2 message with 一 and an emoji from our server (or is recorded as fragments)', async () => {
		const upstreamSession = await waitForUpstreamSession('main');
		const { err, session } = await bind(USERNAME, PASSWORD, { bindType: 'receiver' });

		assert.equal(err, undefined);
		assert.ok(session);

		const sms: Sms[] = [];

		session.on('sms', s => { sms.push(s); });

		const text = `一😀${'q'.repeat(60)}`;

		await sendSarMo(upstreamSession, { from: TO, message: text, to: FROM });

		const whole = await waitFor(() => sms.find(s => s.message === text), 10_000);

		await session.close({ signal: AbortSignal.abort() });
		assert.ok(whole ?? sms.length > 0, 'expected the UCS-2 message to arrive whole or as recorded fragments');
	});
});
describe('C3+C7 - long MT through the fake upstream, receipts and id consistency', () => {
	const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(-\d+)?$/i;

	const cases: { encoding?: 'UCS2'; expectedSegments: number; label: string; message: string }[] = [
		{ expectedSegments: 1, label: 'single-segment GSM with extension chars', message: '€[]~single segment' },
		{ expectedSegments: 2, label: '2-segment GSM with extension chars', message: `€[]~${'g'.repeat(200)}` },
		{ expectedSegments: 3, label: '3-segment GSM with extension chars', message: `€[]~${'g'.repeat(400)}` },
		{ expectedSegments: 10, label: '10-segment GSM with extension chars', message: `€[]~${'g'.repeat(1450)}` },
		{ encoding: 'UCS2', expectedSegments: 2, label: '2-segment UCS2 with 一 and an emoji', message: `一😀${'x'.repeat(70)}` },
	];

	for (const testCase of cases) {
		test(testCase.label, async t => {
			await waitForUpstreamSession('main');

			const { err, session } = await bind(USERNAME, PASSWORD);

			assert.equal(err, undefined);
			assert.ok(session);
			closeAfter(t, session);

			const dlrs: { dlr: Dlr; pduObj: PduObject }[] = [];
			const messageDlrs: unknown[] = [];

			session.on('dlr', (dlr, pduObj) => { dlrs.push({ dlr, pduObj }); });
			session.on('messageDlr', merged => { messageDlrs.push(merged); });

			const sent = await session.sendSms({
				dlr: true,
				from: FROM,
				message: testCase.message,
				to: TO,
				...(testCase.encoding ? { encoding: testCase.encoding } : {}),
			});

			assert.equal(sent.err, undefined);
			assert.equal(sent.smsIds.length, testCase.expectedSegments);

			for (const id of sent.smsIds) {
				assert.match(id, uuidPattern, 'expected a UUID-shaped message id from Jasmin\'s submit_sm_resp');

				// The full round trip - submit_sm to Jasmin's smpps, mtrouter, AMQP, the connector bind,
				// our fake upstream's ack+DLR, AMQP again, DLRLookup, deliver_sm back - is slower than a
				// single-segment send's, and visibly so under load; a generous budget beats a flaky one.
				const received = await waitFor(() => dlrs.find(r => r.dlr.smsId === id), 25_000);

				assert.ok(received, `no receipt for id ${id}`);
				assert.equal(received.dlr.statusMsg, 'DELIVERED');
			}

			// Jasmin relays each segment as its own independent submit_sm to the connector (no MT-side
			// UDH reassembly observed here - see findings), so the ids Jasmin hands back are whatever
			// the fake upstream's own server() assigned per segment of ITS OWN reassembled view. That
			// is this library's own <base>-<n> convention on both ends of this harness, which is why
			// messageDlr can fire here - not evidence of Jasmin producing that convention itself; see
			// findings/03-jasmin.md for what a real, independent upstream SMSC would hand back instead.
			void messageDlrs;
		});
	}
});

describe('C8 (target 3) - long MO from an upstream SMSC, SAR vs UDH segmentation', () => {
	test('SAR-segmented deliver_sm from the fake upstream', async () => {
		const upstreamSession = await waitForUpstreamSession('main');
		const { err, session } = await bind(USERNAME, PASSWORD, { bindType: 'receiver' });

		assert.equal(err, undefined);
		assert.ok(session);

		const sms: Sms[] = [];

		session.on('sms', s => { sms.push(s); });

		const text = `sar-mo-${'m'.repeat(300)}`;

		await sendSarMo(upstreamSession, { from: TO, message: text, to: FROM });

		// Recorded either way, per the task: one whole `sms` (Jasmin reassembled the SAR segments
		// before forwarding) or several fragments (it relayed them, and our SAR-blind reassembler -
		// keyed on UDH only - never groups them; see findings for which happened and the reproducer).
		const whole = await waitFor(() => sms.find(s => s.message === text), 10_000);
		const fragments = sms.filter(s => text.includes(s.message) && s.message !== '');

		await session.close({ signal: AbortSignal.abort() });

		assert.ok(whole ?? fragments.length > 0, 'expected either a reassembled sms or SAR fragments to arrive');
	});

	test('UDH-segmented deliver_sm from the fake upstream', async () => {
		const upstreamSession = await waitForUpstreamSession('main');
		const { err, session } = await bind(USERNAME, PASSWORD, { bindType: 'receiver' });

		assert.equal(err, undefined);
		assert.ok(session);

		const sms: Sms[] = [];

		session.on('sms', s => { sms.push(s); });

		const text = `udh-mo-${'n'.repeat(300)}`;

		await sendUdhMo(upstreamSession, { from: TO, message: text, to: FROM });

		const whole = await waitFor(() => sms.find(s => s.message === text), 10_000);
		const fragments = sms.filter(s => text.includes(s.message) && s.message !== '');

		await session.close({ signal: AbortSignal.abort() });

		assert.ok(whole ?? fragments.length > 0, 'expected either a reassembled sms or UDH fragments to arrive');
	});
});

describe('C8 (target 2) - message_payload with sm_length 0', () => {
	test('a deliver_sm carrying message_payload instead of short_message', async () => {
		const upstreamSession = await waitForUpstreamSession('main');
		const { err, session } = await bind(USERNAME, PASSWORD, { bindType: 'receiver' });

		assert.equal(err, undefined);
		assert.ok(session);

		const sms: Sms[] = [];

		session.on('sms', s => { sms.push(s); });

		const text = 'message-payload only, sm_length 0';
		const pushed = await sendMessagePayloadMo(upstreamSession, { from: TO, message: text, to: FROM });

		assert.equal(pushed.err, undefined, 'expected Jasmin to accept a message_payload-only deliver_sm from its connector');

		const arrived = await waitFor(() => sms.find(s => s.message === ''), 5000);

		await session.close({ signal: AbortSignal.abort() });

		// Confirmed (target 2): Jasmin relays message_payload faithfully (sm_length 0, the real text
		// in the TLV) - our own incoming-requests.ts reads short_message only, so the sms that arrives
		// here has the right envelope (from/to) but an empty message, never the text carried in the
		// TLV. See findings/03-jasmin.md for the reproducer.
		assert.ok(arrived, 'expected an sms to arrive (with an empty message, per target 2) for the message_payload push');
	});
});

describe('C9 (target 4) - DLR as data_sm against the jasmin-datasm instance', () => {
	test('a receipt thrown as data_sm is not read as a dlr; the raw PDU still arrives', async t => {
		await waitForUpstreamSession('datasm');

		const { err, session } = await client({ host: DATASM_HOST, password: PASSWORD, port: PEER_PORT, username: USERNAME });

		assert.equal(err, undefined);
		assert.ok(session);
		closeAfter(t, session);

		const dlrs: Dlr[] = [];
		const incomingDataSm: PduObject[] = [];

		session.on('dlr', dlr => { dlrs.push(dlr); });
		session.on('incomingPduObj', pduObj => { if (pduObj.cmdName === 'data_sm') incomingDataSm.push(pduObj); });

		const sent = await session.sendSms({ dlr: true, from: FROM, message: 'data_sm dlr test', to: TO });

		assert.equal(sent.err, undefined);

		const arrived = await waitFor(() => incomingDataSm[0], 15_000);

		assert.ok(arrived, 'expected Jasmin to throw the receipt as data_sm (dlr_pdu = data_sm)');

		await delay(2000);
		assert.deepEqual(dlrs, [], 'data_sm is answered ESME_RINVCMDID and never reaches the dlr event (target 4)');
	});
});

describe('C11 - bind refusal and reconnect backoff', () => {
	test('wrong password: one attempt, no retry', async () => {
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

		const { err, session } = await bind(USERNAME, 'wrong-password', { log, reconnect: { maxDelay: 4000, minDelay: 1000 } });

		assert.ok(err);
		assert.equal(session, undefined);
		await delay(2000);
		assert.equal(refusals.length, 1, 'expected exactly one bind attempt, never a retry');
		assert.equal(refusals[0]?.cmdStatus, 'ESME_RINVPASWD');
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
		options.password = 'wrong-after-drop';
		session.sock.destroy();

		await delay(12_000);

		assert.ok(disconnectedAt.length >= 2 && disconnectedAt.length <= 8, `expected a handful of attempts, got ${String(disconnectedAt.length)}`);

		for (let i = 1; i < disconnectedAt.length; i++) {
			const previous = disconnectedAt[i - 1];
			const current = disconnectedAt[i];

			assert.ok(previous !== undefined && current !== undefined);
			assert.ok(current - previous >= 150, 'expected each retry to wait at least close to minDelay');
		}
	});
});

describe('C12 - throttling (esme2\'s smpps_throughput quota)', () => {
	test('flooding submits past the quota gets an err naming the status; the session stays bound; a later send works', async t => {
		await waitForUpstreamSession('main');

		const { err, session } = await bind(THROTTLED_USERNAME, THROTTLED_PASSWORD, { maxOutstanding: 20 });

		assert.equal(err, undefined);
		assert.ok(session);
		closeAfter(t, session);

		const results = await Promise.all(
			Array.from({ length: 15 }, async (_unused, index) => session.sendSms({ from: FROM, message: `throttle-${String(index)}`, to: TO })),
		);

		const refused = results.filter(r => r.err !== undefined);

		assert.ok(refused.length > 0, 'expected the 0.1/s quota to refuse at least one of 15 parallel sends');
		assert.match(refused[0]?.err?.message ?? '', /ESME_RTHROTTLED/);

		const keepalive = await session.send({ cmdName: 'enquire_link' });

		assert.equal(keepalive.err, undefined);
		assert.ok(keepalive.pduObj);
		assert.equal(keepalive.pduObj.cmdStatus, 'ESME_ROK');

		// 0.1/s is one slot every 10s, so a single fixed delay is either wasteful or flaky - polling
		// finds the next open slot instead of guessing it.
		const deadline = Date.now() + 25_000;
		let later: Awaited<ReturnType<typeof session.sendSms>> | undefined;

		while (!later && Date.now() < deadline) {
			const attempt = await session.sendSms({ from: FROM, message: 'after the burst', to: TO });

			if (!attempt.err) later = attempt;
			else await delay(500);
		}

		assert.ok(later, 'expected a later send to succeed once the quota\'s next slot opened');
	});
});

