import assert from 'node:assert/strict';
import http from 'node:http';
import test, { after, describe } from 'node:test';
import type { MessageState } from '../src/defs/constants.ts';
import type { Dlr } from '../src/dlr.ts';
import type { Session } from '../src/session.ts';
import type { Sms } from '../src/sms.ts';
import { ConcatReference } from '../src/udh.ts';
import { consts } from '../src/defs/constants.ts';
import { detect, encodings } from '../src/defs/encodings.ts';
import { paramText } from '../src/defs/types.ts';
import { server } from '../src/server.ts';
import { splitMessage } from '../src/message.ts';
import { submitSmParams } from '../src/send-sms.ts';

// smsbox HTTP hosts, one per variant - all point at the same node:2775 SMPP server.
const MAIN_SMSBOX = process.env.MAIN_SMSBOX ?? 'kannel-smsbox:13013';
const IV33_SMSBOX = process.env.IV33_SMSBOX ?? 'kannel-iv33-smsbox:13013';
const MAXP1_SMSBOX = process.env.MAXP1_SMSBOX ?? 'kannel-maxp1-smsbox:13013';
const NOTRX_SMSBOX = process.env.NOTRX_SMSBOX ?? 'kannel-notrx-smsbox:13013';
const SMPP_PORT = Number(process.env.SMPP_PORT ?? '2775');
const CALLBACK_PORT = Number(process.env.CALLBACK_PORT ?? '8080');
const SENDSMS_USER = 'tester';
const SENDSMS_PASS = 'testerpw';

type Variant = 'iv33' | 'main' | 'maxp1' | 'notrx';

function delay(ms: number): Promise<void> {
	return new Promise(resolve => { setTimeout(resolve, ms); });
}

/** Polls until `get()` stops returning undefined, or the budget runs out. */
async function waitFor<T>(get: () => T | undefined, budget = 5000): Promise<T | undefined> {
	const deadline = Date.now() + budget;
	let value = get();

	while (value === undefined && Date.now() < deadline) {
		await delay(20);
		value = get();
	}

	return value;
}

// --- Shared infra: one long-lived server() and one HTTP callback listener for the whole file,
// since every Kannel variant dials in and keeps retrying from container start, independent of
// when this file's tests run. ---

type MoCallback = { coding: string; from: string; text: string; to: string; udh: string };
type DlrCallback = { answer: string; id: string; type: string };

const moCallbacks = new Map<Variant, MoCallback[]>();
const dlrCallbacks: DlrCallback[] = [];

function variantFromPath(pathname: string): Variant | undefined {
	if (pathname === '/mo') return 'main';
	if (pathname === '/mo/iv33') return 'iv33';
	if (pathname === '/mo/maxp1') return 'maxp1';
	if (pathname === '/mo/notrx') return 'notrx';

	return undefined;
}

function rawQueryValue(rawUrl: string, key: string): string {
	const match = new RegExp(`[?&]${key}=([^&]*)`).exec(rawUrl);

	return match?.[1] ?? '';
}

function percentDecodeBytes(raw: string): Buffer {
	const bytes: number[] = [];

	for (let i = 0; i < raw.length; i++) {
		if (raw[i] === '%' && i + 2 < raw.length) {
			bytes.push(Number.parseInt(raw.slice(i + 1, i + 3), 16));
			i += 2;
		} else {
			bytes.push(raw.charCodeAt(i));
		}
	}

	return Buffer.from(bytes);
}

// Kannel's %a decodes GSM text to a normal string before percent-escaping it, but for UCS-2
// (coding=2) it escapes the raw big-endian bytes instead - URLSearchParams decodes percent-escapes
// as UTF-8, which turns those raw bytes into mojibake, so coding=2 needs a byte-level percent-decode
// through our own UCS2 decoder instead.
function moText(rawUrl: string, url: URL): string {
	if (url.searchParams.get('coding') !== '2') return url.searchParams.get('text') ?? '';

	return encodings.UCS2.decode(percentDecodeBytes(rawQueryValue(rawUrl, 'text')));
}

const httpServer = http.createServer((req, res) => {
	const url = new URL(req.url ?? '/', 'http://node');

	if (url.pathname === '/dlr') {
		dlrCallbacks.push({
			answer: url.searchParams.get('answer') ?? '',
			id: url.searchParams.get('id') ?? '',
			type: url.searchParams.get('type') ?? '',
		});
		res.writeHead(200);
		res.end();

		return;
	}

	const variant = variantFromPath(url.pathname);

	if (variant) {
		const list = moCallbacks.get(variant) ?? [];

		list.push({
			coding: url.searchParams.get('coding') ?? '',
			from: url.searchParams.get('from') ?? '',
			text: moText(req.url ?? '', url),
			to: url.searchParams.get('to') ?? '',
			udh: url.searchParams.get('udh') ?? '',
		});
		moCallbacks.set(variant, list);
		res.writeHead(200);
		res.end();

		return;
	}

	res.writeHead(404);
	res.end();
});

await new Promise<void>(resolve => { httpServer.listen(CALLBACK_PORT, resolve); });

function variantFromSystemId(systemId: string): Variant | undefined {
	if (systemId === 'kannel') return 'main';
	if (systemId === 'kannel-iv33') return 'iv33';
	if (systemId === 'kannel-maxp1') return 'maxp1';
	if (systemId === 'kannel-notrx') return 'notrx';

	return undefined;
}

const allSms: { sms: Sms; variant: Variant }[] = [];
const allDlrs: { dlr: Dlr; variant: Variant }[] = [];
const bindPdus: { params: Record<string, unknown>; variant: Variant }[] = [];

const { err: serverErr, server: smpp } = await server({
	authenticate: ({ password, systemId }) => {
		if (password !== 'kannelpw') return false;

		const variant = variantFromSystemId(systemId);

		return variant ? { userData: { variant } } : false;
	},
	idleTimeout: 40_000,
	port: SMPP_PORT,
});

assert.equal(serverErr, undefined);
assert.ok(smpp);

const smppServer = smpp;

smppServer.on('session', session => {
	session.on('incomingPduObj', pduObj => {
		if (!pduObj.cmdName.startsWith('bind_')) return;

		const variant = variantFromSystemId(paramText(pduObj.params.system_id));

		if (variant) bindPdus.push({ params: pduObj.params, variant });
	});

	session.on('sms', sms => {
		const variant = (session.userData as { variant?: Variant } | undefined)?.variant;

		if (variant) allSms.push({ sms, variant });
	});

	session.on('dlr', dlr => {
		const variant = (session.userData as { variant?: Variant } | undefined)?.variant;

		if (variant) allDlrs.push({ dlr, variant });
	});
});

after(async () => {
	await smppServer.close();
	await new Promise<void>(resolve => { httpServer.close(() => { resolve(); }); });
});

function sessionsFor(variant: Variant): Session[] {
	return [...smppServer.sessions].filter(s => (s.userData as { variant?: Variant } | undefined)?.variant === variant);
}

async function waitForSessions(variant: Variant, count: number, budget = 15_000): Promise<Session[]> {
	const found = await waitFor(() => (sessionsFor(variant).length >= count ? sessionsFor(variant) : undefined), budget);

	assert.ok(found, `no ${String(count)} session(s) bound for variant ${variant} within ${String(budget)}ms`);

	return found;
}

// Kannel's sendsms answers 202 with a body of "0: Accepted for delivery" or "3: Queued for later
// delivery" - the HTTP status is never 200 (Table 7-16 of the user guide).
async function sendsms(host: string, params: Record<string, string>): Promise<{ body: string; status: number }> {
	const url = new URL(`http://${host}/cgi-bin/sendsms`);

	url.search = new URLSearchParams({ password: SENDSMS_PASS, username: SENDSMS_USER, ...params }).toString();

	const response = await fetch(url);
	const body = await response.text();

	assert.equal(response.status, 202);
	assert.match(body, /^[03]: /);

	return { body, status: response.status };
}

/** The next incoming `sms` for a variant carrying `message`, polling past ones that don't match. */
async function waitForSms(variant: Variant, message: string, budget = 8000): Promise<Sms> {
	const found = await waitFor(
		() => allSms.find(entry => entry.variant === variant && entry.sms.message === message)?.sms,
		budget,
	);

	assert.ok(found, `no sms carrying ${JSON.stringify(message)} arrived for variant ${variant}`);

	return found;
}

async function waitForMoCallback(variant: Variant, text: string, budget = 8000): Promise<MoCallback> {
	const found = await waitFor(
		() => moCallbacks.get(variant)?.find(callback => callback.text === text),
		budget,
	);

	assert.ok(found, `no MO callback carrying ${JSON.stringify(text)} arrived for variant ${variant}`);

	return found;
}

async function waitForDlrCallback(id: string, type: string, budget = 8000): Promise<DlrCallback> {
	const found = await waitFor(
		() => dlrCallbacks.find(callback => callback.id === id && callback.type === type),
		budget,
	);

	assert.ok(found, `no dlr callback id=${id} type=${type} arrived (seen: ${JSON.stringify(dlrCallbacks)})`);

	return found;
}

/** Builds a `deliver_sm` per segment the way `session.sendSms()` builds `submit_sm` - see the MO
 * describe block for why this bypasses `sendSms()` itself. */
async function sendMo(session: Session, opts: { from: string; message: string; to: string }): Promise<void> {
	const encoding = detect(opts.message);
	const reference = moReference.next();
	const segments = splitMessage(opts.message, { encoding, reference });
	const multipart = segments.length > 1;

	for (const segment of segments) {
		const params = submitSmParams({ from: opts.from, message: opts.message, to: opts.to }, segment, { encoding, multipart });
		const sent = await session.send({ cmdName: 'deliver_sm', params });

		assert.equal(sent.err, undefined);
		assert.ok(sent.pduObj);
		assert.equal(sent.pduObj.cmdStatus, 'ESME_ROK');
	}
}

const moReference = new ConcatReference();

describe('kannel main variant - bind', () => {
	test('binds transceiver 34, defaults addr_ton/npi to 0, carries our system_type', async () => {
		await waitForSessions('main', 1);

		const bind = await waitFor(() => bindPdus.find(entry => entry.variant === 'main'));

		assert.ok(bind);
		assert.equal(bind.params.system_type, 'kannel-esme');
		assert.equal(bind.params.interface_version, 0x34);
		assert.equal(bind.params.addr_ton, 0);
		assert.equal(bind.params.addr_npi, 0);
		assert.equal(bind.params.address_range, '');
	});
});

describe('S1 - MT from Kannel with delivery reports', () => {
	for (const status of ['DELIVERED', 'UNDELIVERABLE', 'EXPIRED', 'ENROUTE'] as MessageState[]) {
		test(`dlr-mask=31 round trip settles as ${status}`, async () => {
			await waitForSessions('main', 1);

			const text = `s1-${status.toLowerCase()}`;
			const dlrUrl = `http://node:${String(CALLBACK_PORT)}/dlr?type=%d&answer=%A&id=%F`;

			await sendsms(MAIN_SMSBOX, {
				'dlr-mask': '31',
				'dlr-url': dlrUrl,
				from: '46701113311',
				text,
				to: '46709771337',
			});

			const sms = await waitForSms('main', text);

			assert.equal(sms.from, '46701113311');
			assert.equal(sms.to, '46709771337');
			assert.equal(sms.dlr, true);

			assert.equal((await sms.sendResp()).err, undefined);

			// dlr-mask bit 8: Kannel fires this off the submit_sm_resp alone, before any receipt.
			const submitAck = await waitForDlrCallback(sms.smsId, '8');

			assert.equal(submitAck.id, sms.smsId);

			const report = await sms.sendDlr(status);

			assert.equal(report.err, undefined);

			// Kannel's %d for a settled message: DELIVERED 1, ENROUTE 4, UNDELIVERABLE 2 - but EXPIRED
			// is its own bit (34 = 32|2), not folded into the generic failure code.
			const finalType = status === 'DELIVERED' ? '1' : status === 'ENROUTE' ? '4' : status === 'EXPIRED' ? '34' : '2';
			const final = await waitForDlrCallback(sms.smsId, finalType);

			assert.equal(final.id, sms.smsId);
		});
	}
});

describe('long MT from Kannel', () => {
	test('300-char GSM text reassembles whole', async () => {
		await waitForSessions('main', 1);

		const text = 'g'.repeat(300);
		await sendsms(MAIN_SMSBOX, { from: '46701113311', text, to: '46709771337' });

		const sms = await waitForSms('main', text, 15_000);

		assert.equal(sms.message, text);
		assert.equal((await sms.sendResp()).err, undefined);
	});

	test('UCS-2 text with 一 and an emoji reassembles whole', async () => {
		await waitForSessions('main', 1);

		const text = `一😀${'x'.repeat(140)}`;
		await sendsms(MAIN_SMSBOX, { charset: 'UTF-8', coding: '2', from: '46701113311', text, to: '46709771337' });

		const sms = await waitForSms('main', text, 15_000);

		assert.equal(sms.message, text);
		assert.equal((await sms.sendResp()).err, undefined);
	});
});

describe('S11 - GSM extension characters', () => {
	test('€ [ ] ~ round trip through Kannel unpacked GSM7', async () => {
		await waitForSessions('main', 1);

		const text = '€[]~ok';
		await sendsms(MAIN_SMSBOX, { from: '46701113311', text, to: '46709771337' });

		const sms = await waitForSms('main', text);

		assert.equal(sms.message, text);
		assert.equal((await sms.sendResp()).err, undefined);
	});
});

describe('MO to Kannel', () => {
	test('session.sendSms() is refused by Kannel: submit_sm only flows ESME to SMSC', async () => {
		const [session] = await waitForSessions('main', 1);

		assert.ok(session);

		const result = await session.sendSms({ from: '46701113311', message: 'mo via sendSms', to: '46709771337' });

		assert.ok(result.err);
		assert.match(result.err.message, /ESME_RINVCMDID/);
	});

	test('a deliver_sm carrying a single-segment GSM message reaches the sms-service once', async () => {
		const [session] = await waitForSessions('main', 1);

		assert.ok(session);

		const text = 'mo single segment';

		await sendMo(session, { from: '46709771337', message: text, to: '46701113311' });

		const callback = await waitForMoCallback('main', text);

		// Two Kannel quirks, not this library's: %p prepends '+' to an international-TON address
		// even though the wire address carried none, and %P reports smsbox's own `global-sender`
		// rather than the deliver_sm's destination_addr (unset `my-number` on the smsc group).
		assert.equal(callback.from, '+46709771337');
		assert.equal(callback.to, '46700000000');

		const matching = moCallbacks.get('main')?.filter(c => c.text === text) ?? [];

		assert.equal(matching.length, 1);
	});

	test('a deliver_sm split over 3 GSM segments reaches the sms-service once, whole', async () => {
		const [session] = await waitForSessions('main', 1);

		assert.ok(session);

		const text = 'm'.repeat(400);

		await sendMo(session, { from: '46709771337', message: text, to: '46701113311' });

		const callback = await waitForMoCallback('main', text, 15_000);

		assert.equal(callback.text, text);

		const matching = moCallbacks.get('main')?.filter(c => c.text === text) ?? [];

		assert.equal(matching.length, 1);
	});

	test('a deliver_sm split over UCS-2 segments reaches the sms-service once, whole', async () => {
		const [session] = await waitForSessions('main', 1);

		assert.ok(session);

		const text = `一😀${'y'.repeat(200)}`;

		await sendMo(session, { from: '46709771337', message: text, to: '46701113311' });

		const callback = await waitForMoCallback('main', text, 15_000);

		assert.equal(callback.text, text);

		const matching = moCallbacks.get('main')?.filter(c => c.text === text) ?? [];

		assert.equal(matching.length, 1);
	});
});

describe('S6 - wait-ack expiry and keepalive', () => {
	// Runs before the wait-ack test below, which deliberately provokes a disconnect/reconnect on
	// this same variant's session - a stable link is needed to observe the keepalive cleanly.
	test('enquire_link every 5s keeps a 60s-idle session from hitting idleTimeout (40s)', async () => {
		const [session] = await waitForSessions('main', 1);

		assert.ok(session);

		const closes: unknown[] = [];

		session.on('close', () => { closes.push(undefined); });

		await delay(60_000);

		assert.deepEqual(closes, []);
	});

	test('a submit_sm answered past wait-ack (5s) - Kannel\'s reaction is recorded, not judged', async () => {
		await waitForSessions('main', 1);

		const text = 's6-slow-resp';
		const before = allSms.filter(e => e.variant === 'main').length;

		await sendsms(MAIN_SMSBOX, { from: '46701113311', text, to: '46709771337' });

		const sms = await waitForSms('main', text);

		await delay(7000);
		await sms.sendResp().catch(() => undefined);

		// wait-ack-expire defaults to 0x00 (disconnect/reconnect); reconnect-delay is 1s, so give it
		// room to rebind and possibly resend the same submit_sm on the new session.
		await delay(4000);

		const after = allSms.filter(e => e.variant === 'main' && e.sms.message === text);

		assert.ok(after.length >= 1, 'the original sms is still on record');
		// Recorded for findings, not asserted: whether a resend duplicated the sms is peer behaviour.
		void before;
	});
});

describe('iv33 variant - interface_version 0x33', () => {
	test('binds at 0x33 and negotiates no optional params', async () => {
		const [session] = await waitForSessions('iv33', 1);

		assert.ok(session);
		assert.equal(session.peerInterfaceVersion, 0x33);
		assert.equal(session.acceptsOptionalParams(), false);
	});

	test('MT + DLR round trip still correlates with no TLVs on the receipt', async () => {
		const [session] = await waitForSessions('iv33', 1);

		assert.ok(session);
		assert.equal(session.acceptsOptionalParams(), false);

		const text = 'iv33 round trip';
		const dlrUrl = `http://node:${String(CALLBACK_PORT)}/dlr?type=%d&answer=%A&id=%F`;

		await sendsms(IV33_SMSBOX, { 'dlr-mask': '31', 'dlr-url': dlrUrl, from: '46701113311', text, to: '46709771337' });

		const sms = await waitForSms('iv33', text);

		assert.equal((await sms.sendResp()).err, undefined);
		await waitForDlrCallback(sms.smsId, '8');
		await sms.sendDlr('DELIVERED');
		await waitForDlrCallback(sms.smsId, '1');
	});
});

describe('maxp1 variant - max-pending-submits 1', () => {
	test('a burst of 20 sendsms calls all arrive, in order, all answered', async () => {
		const [session] = await waitForSessions('maxp1', 1);

		assert.ok(session);

		// max-pending-submits=1 means bearerbox holds the link to one outstanding submit_sm at a
		// time - answer each as it lands, or the whole burst stalls behind the first message.
		session.on('sms', sms => { void sms.sendResp(); });

		const texts = Array.from({ length: 20 }, (_, i) => `burst-${String(i).padStart(2, '0')}`);

		// Sequential, not Promise.all: concurrent fetch()es reach smsbox's HTTP listener in whatever
		// order the OS schedules them, so only a request-then-response chain keeps send order
		// meaningful - max-pending-submits=1 is exercised regardless, since 20 calls in a tight loop
		// still outrun one-at-a-time SMPP submission.
		for (const text of texts) {
			await sendsms(MAXP1_SMSBOX, { from: '46701113311', text, to: '46709771337' });
		}

		const arrived = await waitFor(() => {
			const got = allSms.filter(e => e.variant === 'maxp1').map(e => e.sms.message);

			return texts.every(text => got.includes(text)) ? got : undefined;
		}, 20_000);

		assert.ok(arrived, 'not all 20 burst messages arrived');

		const ordered = allSms.filter(e => e.variant === 'maxp1').map(e => e.sms.message).filter(m => texts.includes(m));

		assert.deepEqual(ordered, texts);
	});
});

describe('notrx variant - separate TX and RX binds', () => {
	test('Kannel opens a transmitter bind and a receiver bind, both accepted', async () => {
		const sessions = await waitForSessions('notrx', 2);

		assert.deepEqual(sessions.map(s => s.boundAs).sort(), ['receiver', 'transmitter']);
	});

	test('submit_sm from Kannel arrives on the transmitter bind, is answered, nothing refused', async () => {
		const sessions = await waitForSessions('notrx', 2);
		const tx = sessions.find(s => s.boundAs === 'transmitter');

		assert.ok(tx);

		const text = 'notrx mt';

		await sendsms(NOTRX_SMSBOX, { from: '46701113311', text, to: '46709771337' });

		const sms = await waitForSms('notrx', text);

		assert.equal(sms.session, tx);
		assert.equal((await sms.sendResp()).err, undefined);
	});

	test('a receipt built on the receiver bind reaches Kannel; the transmitter bind cannot carry one', async () => {
		const sessions = await waitForSessions('notrx', 2);
		const tx = sessions.find(s => s.boundAs === 'transmitter');
		const rx = sessions.find(s => s.boundAs === 'receiver');

		assert.ok(tx);
		assert.ok(rx);

		// sms.sendDlr() ties the receipt to the session the submit_sm arrived on (the TX bind), which
		// cannot carry deliver_sm at all (see README, Bind direction) - documented behaviour, not a
		// defect. A split-bind peer's receipt has to be sent on the RX session directly.
		//
		// session.send() is the library's unchecked raw passthrough (README), so this probes Kannel's
		// own direction enforcement, not ours: Kannel answers ESME_ROK to a deliver_sm on its
		// transmitter bind rather than refusing it - recorded as a peer quirk, not asserted as a spec
		// violation this library must guard against.
		const onTx = await tx.send({
			cmdName: 'deliver_sm',
			params: { destination_addr: '46701113311', short_message: 'nope', source_addr: '46709771337' },
		});

		assert.equal(onTx.err, undefined);

		const text = 'notrx dlr target';
		const dlrUrl = `http://node:${String(CALLBACK_PORT)}/dlr?type=%d&answer=%A&id=%F`;

		await sendsms(NOTRX_SMSBOX, { 'dlr-mask': '31', 'dlr-url': dlrUrl, from: '46701113311', text, to: '46709771337' });

		const sms = await waitForSms('notrx', text);

		assert.equal((await sms.sendResp()).err, undefined);
		await waitForDlrCallback(sms.smsId, '8');

		const receiptDate = '2609051200';
		const receiptSent = await rx.send({
			cmdName: 'deliver_sm',
			params: {
				destination_addr: sms.from,
				esm_class: consts.ESM_CLASS.MC_DELIVERY_RECEIPT,
				short_message: `id:${sms.smsId} sub:001 dlvrd:001 submit date:${receiptDate} done date:${receiptDate} `
					+ 'stat:DELIVRD err:000 text:',
				source_addr: sms.to,
			},
		});

		assert.equal(receiptSent.err, undefined);
		assert.ok(receiptSent.pduObj);
		assert.equal(receiptSent.pduObj.cmdStatus, 'ESME_ROK');

		await waitForDlrCallback(sms.smsId, '1');
	});

	test('MO built on the receiver bind reaches the sms-service', async () => {
		const sessions = await waitForSessions('notrx', 2);
		const rx = sessions.find(s => s.boundAs === 'receiver');

		assert.ok(rx);

		const text = 'notrx mo on rx';

		await sendMo(rx, { from: '46709771337', message: text, to: '46701113311' });

		const callback = await waitForMoCallback('notrx', text);

		assert.equal(callback.text, text);
	});
});
