import assert from 'node:assert/strict';
import test, { after, describe } from 'node:test';
import type { Session } from '../src/session.ts';
import type { Sms } from '../src/sms.ts';
import { paramText } from '../src/defs/types.ts';
import { isCommand, server } from '../src/index.ts';

const DRIVER = process.env.PHP_DRIVER ?? 'php:8080';
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

		// php-smpp's submit_sm() blocks synchronously reading the response on the same connection
		// that sent it, so answering here (rather than after this event's own test observes the
		// sms) is the only way that read ever completes - unlike python-smpplib's driver, this one
		// has no separate reader thread to poll afterwards.
		void sms.sendResp();
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

async function bindClient(name: string, mode: 'receiver' | 'transceiver' | 'transmitter', opts: Partial<JsonBody> = {}): Promise<void> {
	const bound = await post('/bind', { mode, name, password: 'pw', systemId: name, ...opts });

	assert.equal(bound.ok, true, JSON.stringify(bound));
}

describe('S2 - long messages (php-smpp, three CSMS spellings)', () => {
	const modes: { csmsMethod: number; name: string }[] = [
		{ csmsMethod: 0, name: 's2-16bit-tags' },
		{ csmsMethod: 1, name: 's2-payload' },
		{ csmsMethod: 2, name: 's2-8bit-udh' },
	];

	for (const { csmsMethod, name } of modes) {
		test(`csmsMethod=${String(csmsMethod)} (${name}) reassembles into one sms with the full text`, async () => {
			await bindClient(name, 'transceiver');

			const text = 'L'.repeat(350);
			const sent = await post('/sendLong', { csmsMethod, from: '46700000001', name, text, to: '46700000002' });

			assert.equal(sent.ok, true, JSON.stringify(sent));

			await waitForSms(name, text, 15_000);
		});
	}
});

describe('S4 - bind direction (php-smpp forces separate TX and RX binds)', () => {
	test('php-smpp opens a transmitter bind and a receiver bind, both accepted', async () => {
		await bindClient('s4-tx', 'transmitter');
		await bindClient('s4-rx', 'receiver', { recvTimeoutMs: 8000 });

		const tx = await waitForSession('s4-tx');
		const rx = await waitForSession('s4-rx');

		assert.equal(tx.boundAs, 'transmitter');
		assert.equal(rx.boundAs, 'receiver');
		assert.equal(tx.bindAllows('deliver_sm'), false);
		assert.equal(rx.bindAllows('submit_sm'), false);
	});

	test('a submit_sm on the receiver bind is answered ESME_RINVBNDSTS, and the peer keeps working', async () => {
		const rx = await waitForSession('s4-rx');

		assert.ok(rx);

		const refused = await post('/submit', { dataCoding: 0, from: '46700000001', name: 's4-rx', text: 'nope', to: '46700000002' });

		assert.equal(refused.ok, false);
		assert.equal(refused.status, 4); // ESME_RINVBNDSTS

		const link = await post('/enquireLink', { name: 's4-rx' });

		assert.equal(link.ok, true);
	});

	test('submit_sm on the transmitter bind works normally', async () => {
		const text = 's4 tx works';
		const sent = await post('/submit', { dataCoding: 0, from: '46700000001', name: 's4-tx', text, to: '46700000002' });

		assert.equal(sent.ok, true, JSON.stringify(sent));

		const sms = await waitForSms('s4-tx', text);

		assert.equal(sms.session, await waitForSession('s4-tx'));
	});

	test('a deliver_sm built on the receiver bind reaches php-smpp; the transmitter bind never gets one', async () => {
		const rx = await waitForSession('s4-rx');

		const text = 's4 mo on rx';

		// php-smpp's readSMS() blocks synchronously reading and answering, so it has to be in flight
		// before the deliver_sm goes out - awaiting rx.send() first would wait on an answer nothing
		// is there yet to send.
		const receivePromise = post('/receive', { name: 's4-rx' });
		const sent = await rx.send({
			cmdName: 'deliver_sm',
			params: { destination_addr: '46700000001', short_message: Buffer.from(text), source_addr: '46700000002' },
		});

		assert.equal(sent.err, undefined);
		assert.ok(sent.pduObj);
		assert.equal(sent.pduObj.cmdStatus, 'ESME_ROK');

		const received = await receivePromise;

		assert.equal(received.ok, true);
		assert.equal(received.received, true);
		assert.equal(received.text, text);

		const nothingOnTx = await post('/receive', { name: 's4-tx' });

		assert.equal(nothingOnTx.ok, true);
		assert.equal(nothingOnTx.received, false);
	});
});

describe('Refusals via onRequest', () => {
	test('a refusing status through onRequest is surfaced to php-smpp as a catchable status, not a hang or close', async () => {
		await bindClient('refusal', 'transceiver');

		const refused = await post('/submit', { dataCoding: 0, from: '46700000001', name: 'refusal', text: 'nope', to: REFUSED_DEST });

		assert.equal(refused.ok, false);
		assert.equal(refused.status, 0x58); // ESME_RTHROTTLED

		const link = await post('/enquireLink', { name: 'refusal' });

		assert.equal(link.ok, true);

		const after1 = await post('/submit', { dataCoding: 0, from: '46700000001', name: 'refusal', text: 'still works', to: '46700000002' });

		assert.equal(after1.ok, true, JSON.stringify(after1));
	});
});

describe('Peer quirk: bindTransceiver() actually works, despite this fork\'s inherited README', () => {
	test('a transceiver bind against our server is accepted', async () => {
		await bindClient('trx-quirk', 'transceiver');

		const session = await waitForSession('trx-quirk');

		assert.equal(session.boundAs, 'transceiver');
	});
});
