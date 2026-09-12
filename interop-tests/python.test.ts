import assert from 'node:assert/strict';
import test, { after, describe } from 'node:test';
import type { Session } from '../src/session.ts';
import type { Sms } from '../src/sms.ts';
import { encodings } from '../src/defs/encodings.ts';
import { paramText } from '../src/defs/types.ts';
import { isCommand, server } from '../src/index.ts';

const DRIVER = process.env.PYTHON_DRIVER ?? 'python:8080';
const SMPP_PORT = Number(process.env.SMPP_PORT ?? '2775');
const REFUSED_DEST = 'REFUSEME';

function delay(ms: number): Promise<void> {
	return new Promise(resolve => { setTimeout(resolve, ms); });
}

async function waitFor<T>(get: () => T | undefined, budget = 8000): Promise<T | undefined> {
	const deadline = Date.now() + budget;
	let value = get();

	while (value === undefined && Date.now() < deadline) {
		await delay(50);
		value = get();
	}

	return value;
}

type JsonBody = Record<string, unknown>;

async function post(path: string, body: JsonBody): Promise<JsonBody> {
	const res = await fetch(`http://${DRIVER}${path}`, {
		body: JSON.stringify(body),
		headers: { 'Content-Type': 'application/json' },
		method: 'POST',
	});

	return res.json() as Promise<JsonBody>;
}

async function get(path: string): Promise<JsonBody> {
	const res = await fetch(`http://${DRIVER}${path}`);

	return res.json() as Promise<JsonBody>;
}

async function bindReader(name: string, opts: Partial<JsonBody> = {}): Promise<void> {
	const bound = await post('/bind', { mode: 'transceiver', name, password: 'pw', systemId: name, ...opts });

	assert.equal(bound.ok, true, JSON.stringify(bound));

	const started = await post('/startReader', { autoSendEnquireLink: true, name });

	assert.equal(started.ok, true, JSON.stringify(started));
}

// --- Shared infra: one server() for the whole file, one session per named python-smpplib bind,
// tracked by the system_id the driver binds with - the same pattern as kannel.test.ts's variant. ---

const allSms: { sms: Sms; systemId: string }[] = [];
const systemIdBySession = new Map<Session, string>();

const { err: serverErr, server: smpp } = await server({
	onRequest: async (session, pduObj) => {
		if (!isCommand(pduObj, 'submit_sm') || pduObj.params.destination_addr !== REFUSED_DEST) return false;

		await session.sendReturn(pduObj, 'ESME_RTHROTTLED');

		return true;
	},
	port: SMPP_PORT,
});

assert.equal(serverErr, undefined);
assert.ok(smpp);

const smppServer = smpp;

smppServer.on('session', session => {
	session.on('incomingPduObj', pduObj => {
		if (!pduObj.cmdName.startsWith('bind_')) return;

		systemIdBySession.set(session, paramText(pduObj.params.system_id));
	});

	session.on('sms', sms => {
		const systemId = systemIdBySession.get(session);

		if (systemId) allSms.push({ sms, systemId });
	});
});

after(async () => {
	await smppServer.close();
});

function sessionFor(systemId: string): Session | undefined {
	return [...smppServer.sessions].find(s => systemIdBySession.get(s) === systemId);
}

async function waitForSession(systemId: string, budget = 8000): Promise<Session> {
	const found = await waitFor(() => sessionFor(systemId), budget);

	assert.ok(found, `no session bound for system_id ${systemId} within ${String(budget)}ms`);

	return found;
}

async function waitForSms(systemId: string, message: string, budget = 8000): Promise<Sms> {
	const found = await waitFor(
		() => allSms.find(entry => entry.systemId === systemId && entry.sms.message === message)?.sms,
		budget,
	);

	assert.ok(found, `no sms carrying ${JSON.stringify(message)} arrived for ${systemId}`);

	return found;
}

type ReceivedEntry = { dataCoding: number; esmClass: number; from: string; hex: string; text: string; to: string };

async function waitForReceived(name: string, predicate: (e: ReceivedEntry) => boolean, budget = 8000): Promise<ReceivedEntry> {
	const found = await waitFor(async () => {
		const status = await get(`/received?name=${name}`);
		const list = status.received as ReceivedEntry[];

		return list.find(predicate);
	}, budget);

	assert.ok(found, `no matching received entry for ${name} within ${String(budget)}ms`);

	return found;
}

type AckResult = { messageId?: string; status?: number };

// A single-segment submit_sm is only answered once sendResp() is called on the arrived sms, so
// /submit itself does not wait for the ack (see driver.py) - this polls for it afterwards.
async function waitForAck(name: string, sequence: number, budget = 8000): Promise<AckResult> {
	const found = await waitFor(async () => {
		const status = await get(`/ack?name=${name}&sequence=${String(sequence)}`);

		return status.found ? status : undefined;
	}, budget);

	assert.ok(found, `no ack for sequence ${String(sequence)} (${name}) within ${String(budget)}ms`);

	return found;
}

async function echoBack(session: Session, sms: Sms, dataCoding: number, text: string): Promise<void> {
	const encName = dataCoding === 3 ? 'LATIN1' : dataCoding === 8 ? 'UCS2' : 'ASCII';
	const buf = encodings[encName].encode(text);
	const sent = await session.send({
		cmdName: 'deliver_sm',
		params: { data_coding: dataCoding, destination_addr: sms.from, short_message: buf, source_addr: sms.to },
	});

	assert.equal(sent.err, undefined);
	assert.ok(sent.pduObj);
	assert.equal(sent.pduObj.cmdStatus, 'ESME_ROK');
}

// The real GSM 03.38 basic table (128 unique chars), as this library decodes it.
const ourTable =
	'@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1BÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
// python-smpplib's own gsm.GSM_CHARACTER_TABLE[:128] - identical except at 0x5F, a backtick where
// the real table (and this library) has a section sign.
const theirTable =
	'@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1BÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ`¿abcdefghijklmnopqrstuvwxyzäöñüà';
const ESC_INDEX = 27;
const sendBasic = theirTable.slice(0, ESC_INDEX) + theirTable.slice(ESC_INDEX + 1);
const expectBasic = ourTable.slice(0, ESC_INDEX) + ourTable.slice(ESC_INDEX + 1);
const extensionChars = '€[]{}\\|~^';

describe('S11 - encodings (python-smpplib)', () => {
	test('GSM 03.38 basic table + extension table round trip (python -> server)', async () => {
		await bindReader('s11-basic');

		const sent = await post('/submit', { dataCoding: 0, from: '46700000001', name: 's11-basic', text: sendBasic + extensionChars, to: '46700000002' });

		assert.equal(sent.ok, true, JSON.stringify(sent));

		const sms = await waitForSms('s11-basic', expectBasic + extensionChars);

		assert.equal((await sms.sendResp()).err, undefined);
		assert.equal((await waitForAck('s11-basic', sent.sequence as number)).status, 0);
	});

	test('form feed (0x1B 0x0A), which smpplib\'s own gsm_encode() cannot build, round trips raw', async () => {
		await bindReader('s11-ff');

		const sent = await post('/submit', { dataCoding: 0, extraHex: '1b0a', from: '46700000001', name: 's11-ff', text: 'before-', to: '46700000002' });

		assert.equal(sent.ok, true, JSON.stringify(sent));

		const sms = await waitForSms('s11-ff', 'before-\f');

		assert.equal((await sms.sendResp()).err, undefined);
		assert.equal((await waitForAck('s11-ff', sent.sequence as number)).status, 0);
	});

	test('Latin-1 round trip', async () => {
		await bindReader('s11-latin1');

		const text = 'café £ ñ ¿¡ © ®';
		const sent = await post('/submit', { dataCoding: 3, from: '46700000001', name: 's11-latin1', text, to: '46700000002' });

		assert.equal(sent.ok, true, JSON.stringify(sent));

		const sms = await waitForSms('s11-latin1', text);

		assert.equal((await sms.sendResp()).err, undefined);
		assert.equal((await waitForAck('s11-latin1', sent.sequence as number)).status, 0);
	});

	test('UCS-2 with 一 and an emoji round trip', async () => {
		await bindReader('s11-ucs2');

		const text = '一😀hello';
		const sent = await post('/submit', { dataCoding: 8, from: '46700000001', name: 's11-ucs2', text, to: '46700000002' });

		assert.equal(sent.ok, true, JSON.stringify(sent));

		const sms = await waitForSms('s11-ucs2', text);

		assert.equal((await sms.sendResp()).err, undefined);
		assert.equal((await waitForAck('s11-ucs2', sent.sequence as number)).status, 0);
	});

	test('reverse direction: server sends GSM text back, python decodes it the same way', async () => {
		await bindReader('s11-echo-gsm');

		const text = 'hello from the server';
		const sent = await post('/submit', { dataCoding: 0, from: '46700000001', name: 's11-echo-gsm', text: 'seed', to: '46700000002' });

		assert.equal(sent.ok, true, JSON.stringify(sent));

		const sms = await waitForSms('s11-echo-gsm', 'seed');

		assert.equal((await sms.sendResp()).err, undefined);
		assert.equal((await waitForAck('s11-echo-gsm', sent.sequence as number)).status, 0);

		const session = sessionFor('s11-echo-gsm');

		assert.ok(session);
		await echoBack(session, sms, 0, text);

		const received = await waitForReceived('s11-echo-gsm', e => e.text === text);

		assert.equal(received.dataCoding, 0);
	});

	test('reverse direction: server sends UCS-2 text back, python decodes it the same way', async () => {
		await bindReader('s11-echo-ucs2');

		const seed = 'seed-ucs2';
		const sent = await post('/submit', { dataCoding: 8, from: '46700000001', name: 's11-echo-ucs2', text: seed, to: '46700000002' });

		assert.equal(sent.ok, true, JSON.stringify(sent));

		const sms = await waitForSms('s11-echo-ucs2', seed);

		assert.equal((await sms.sendResp()).err, undefined);
		assert.equal((await waitForAck('s11-echo-ucs2', sent.sequence as number)).status, 0);

		const session = sessionFor('s11-echo-ucs2');

		assert.ok(session);

		const text = '一😀back';

		await echoBack(session, sms, 8, text);

		const received = await waitForReceived('s11-echo-ucs2', e => e.text === text);

		assert.equal(received.dataCoding, 8);
	});

	test('peer quirk, documented both ways: byte 0x5F is section sign here, backtick in smpplib\'s own table', async () => {
		await bindReader('s11-quirk');

		// python encodes a literal backtick through its own gsm_encode(), landing on byte 0x5F -
		// this library decodes that byte to SECTION SIGN, the real GSM 03.38 value.
		const sent = await post('/submit', { dataCoding: 0, from: '46700000001', name: 's11-quirk', text: '`', to: '46700000002' });

		assert.equal(sent.ok, true, JSON.stringify(sent));

		const sms = await waitForSms('s11-quirk', '§');

		assert.equal((await sms.sendResp()).err, undefined);
		assert.equal((await waitForAck('s11-quirk', sent.sequence as number)).status, 0);

		// Sent back the spec-correct way (byte 0x5F again), python's own (non-standard) table reads
		// the same byte back as a backtick, not a section sign - the mismatch shows up both ways.
		const session = sessionFor('s11-quirk');

		assert.ok(session);
		await echoBack(session, sms, 0, '§');

		const received = await waitForReceived('s11-quirk', e => e.dataCoding === 0);

		assert.equal(received.text, '`');
	});
});

describe('S2 - long messages (python-smpplib, UDH)', () => {
	for (const segments of [2, 3, 10]) {
		test(`${String(segments)} segments reassemble whole, each answered on arrival`, async () => {
			const name = `s2-udh-${String(segments)}`;

			await bindReader(name);

			const text = Array.from({ length: 153 * (segments - 1) + 10 }, (_, i) => String(i % 10)).join('');

			const sent = await post('/submitLong', { dataCoding: 0, from: '46700000001', name, text, to: '46700000002' });

			assert.equal(sent.ok, true, JSON.stringify(sent));
			assert.equal(sent.parts, segments);

			const sms = await waitForSms(name, text, 15_000);

			assert.equal(sms.answeredOnArrival, true);

			const results = sent.results as { messageId: string; status: number }[];

			assert.equal(results.length, segments);

			for (const [i, result] of results.entries()) {
				assert.equal(result.status, 0);
				assert.equal(result.messageId, `${sms.smsId}-${String(i + 1)}`);
			}
		});
	}
});

describe('Keepalive - python-smpplib\'s reactive enquire_link', () => {
	test('idle past idleTimeout (40s) with no keepalive: our server drops the session', async () => {
		const name = 'keepalive-none';

		await post('/bind', { mode: 'transceiver', name, password: 'pw', systemId: name, timeoutSecs: 50 });

		const session = await waitForSession(name);
		const closed: unknown[] = [];

		session.on('close', () => { closed.push(undefined); });

		const idle = await post('/idleSilent', { name, seconds: 45 });

		assert.equal(idle.ok, true, JSON.stringify(idle));
		assert.equal(idle.closed, true);
		assert.deepEqual(closed, [undefined]);
	});

	test('idle past idleTimeout (40s) with auto_send_enquire_link: the link survives', async () => {
		const name = 'keepalive-auto';

		await post('/bind', { mode: 'transceiver', name, password: 'pw', systemId: name, timeoutSecs: 10 });
		await waitForSession(name);
		await post('/startReader', { autoSendEnquireLink: true, name });

		const closed: unknown[] = [];
		const session = sessionFor(name);

		assert.ok(session);
		session.on('close', () => { closed.push(undefined); });

		await delay(45_000);

		const status = await get(`/status?name=${name}`);

		assert.equal(status.readerRunning, true);
		assert.equal(status.readerError, null);
		assert.deepEqual(closed, []);
		assert.ok(sessionFor(name), 'session should still be bound');
	});
});

describe('Refusals via onRequest', () => {
	test('a refusing status through onRequest is surfaced to python-smpplib, not a hang or close', async () => {
		const name = 'refusal';

		await bindReader(name);

		// Refused through onRequest, before reassembly and before the sms event, so this is answered
		// without any sendResp() call - unlike every other submit in this file.
		const refused = await post('/submit', { dataCoding: 0, from: '46700000001', name, text: 'nope', to: REFUSED_DEST });

		assert.equal(refused.ok, true, JSON.stringify(refused));
		assert.equal((await waitForAck(name, refused.sequence as number)).status, 0x58); // ESME_RTHROTTLED

		const link = await post('/enquireLink', { name });

		assert.equal(link.ok, true);

		const after1 = await post('/submit', { dataCoding: 0, from: '46700000001', name, text: 'still works', to: '46700000002' });

		assert.equal(after1.ok, true, JSON.stringify(after1));

		const sms = await waitForSms(name, 'still works');

		assert.equal((await sms.sendResp()).err, undefined);
		assert.equal((await waitForAck(name, after1.sequence as number)).status, 0);
	});
});
