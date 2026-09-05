import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import type { Dlr } from '../src/dlr.ts';
import type { Session } from '../src/session.ts';
import type { Sms } from '../src/sms.ts';
import { client } from '../src/client.ts';
import { closeAfter } from '../test/teardown.ts';

const PEER_HOST = process.env.PEER_HOST ?? 'smscsim';
const PEER_PORT = Number(process.env.PEER_PORT ?? '2775');
const PEER_WEB_PORT = Number(process.env.PEER_WEB_PORT ?? '12775');
const FAILING_PEER_HOST = process.env.FAILING_PEER_HOST ?? 'smscsim-failing';
const FAILING_PEER_PORT = Number(process.env.FAILING_PEER_PORT ?? '2775');

// smscsim signs every deliver_sm it sends unprompted (a DLR, or an injected MO) with a
// `rand.Int()`-derived sequence_number, unconstrained to the SMPP 3.4 4.7.1 ceiling
// (0x7FFFFFFF) - about half land above it, and pdu.ts refuses the PDU outright, so the DLR or
// MO is silently lost (see findings/01-smscsim.md, "an out-of-range deliver_sm sequence
// number"). Retrying with a fresh send works around that peer+library interaction without
// hiding it: a scenario only fails here if it keeps missing well past what chance alone explains.
const DLR_RETRY_BUDGET_MS = 3000;
const DLR_MAX_ATTEMPTS = 20;

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

/** Resends the message until one attempt's segments are every one matched by a `dlr` event. */
async function sendUntilAllDlrsArrive(session: Session, dlrs: Dlr[], message: string): Promise<string[]> {
	for (let attempt = 0; attempt < DLR_MAX_ATTEMPTS; attempt++) {
		const sent = await session.sendSms({ dlr: true, from: '46701113311', message, to: '46709771337' });

		assert.equal(sent.err, undefined);

		const complete = await waitFor(
			() => (sent.smsIds.every(id => dlrs.some(dlr => dlr.smsId === id)) ? true : undefined),
			DLR_RETRY_BUDGET_MS,
		);

		if (complete) return sent.smsIds;
	}

	throw new Error(`no attempt got a DLR for every segment within ${String(DLR_MAX_ATTEMPTS)} tries`);
}

describe('smscsim - C1 bind, keepalive, unbind', () => {
	for (const bindType of ['transceiver', 'transmitter', 'receiver'] as const) {
		test(`binds as ${bindType}, keeps the link, unbinds cleanly`, async t => {
			const closes: unknown[] = [];
			const sessionErrors: Error[] = [];

			const { err, session } = await client({
				bindType,
				enquireLinkInterval: 1000,
				host: PEER_HOST,
				port: PEER_PORT,
				username: `c1-${bindType}`,
			});

			assert.equal(err, undefined);
			assert.ok(session);
			closeAfter(t, session);

			session.on('close', () => { closes.push(undefined); });
			session.on('sessionError', sessionError => { sessionErrors.push(sessionError); });

			// smscsim never sends an unsolicited enquire_link of its own - its ENQUIRE_LINK case
			// only answers one (confirmed in its source, smsc.go). So the interval-driven
			// keepalive is checked through its own response, not through `incomingPduObj`.
			const enquired = await session.send({ cmdName: 'enquire_link' });

			assert.equal(enquired.err, undefined);
			assert.ok(enquired.pduObj);
			assert.equal(enquired.pduObj.cmdName, 'enquire_link_resp');
			assert.equal(enquired.pduObj.cmdStatus, 'ESME_ROK');

			await delay(1500);

			const unbound = await session.unbind();

			assert.equal(unbound.err, undefined);

			await delay(50);

			assert.deepEqual(closes, [undefined]);
			assert.deepEqual(sessionErrors, []);
		});
	}
});

describe('smscsim - a single SMS', () => {
	test('one id back, a DLR within 5s naming it DELIVERED', async t => {
		const dlrs: Dlr[] = [];

		const { err, session } = await client({ host: PEER_HOST, port: PEER_PORT, username: 'single-sms' });

		assert.equal(err, undefined);
		assert.ok(session);
		closeAfter(t, session);

		session.on('dlr', dlr => { dlrs.push(dlr); });

		const smsIds = await sendUntilAllDlrsArrive(session, dlrs, 'hello world');

		assert.equal(smsIds.length, 1);

		const [smsId] = smsIds;

		assert.ok(smsId);

		const matched = dlrs.find(dlr => dlr.smsId === smsId);

		assert.ok(matched);
		assert.equal(matched.statusMsg, 'DELIVERED');
	});
});

describe('smscsim - multipart segments', () => {
	test('a 2-segment GSM message gets 2 ids and a DLR per id', async t => {
		const dlrs: Dlr[] = [];

		const { err, session } = await client({ host: PEER_HOST, port: PEER_PORT, username: 'gsm-multipart' });

		assert.equal(err, undefined);
		assert.ok(session);
		closeAfter(t, session);

		session.on('dlr', dlr => { dlrs.push(dlr); });

		// 200 plain GSM chars: over the 160-char single-segment budget, under the 306-char
		// 2-segment one (153 septets each).
		const smsIds = await sendUntilAllDlrsArrive(session, dlrs, 'a'.repeat(200));

		assert.equal(smsIds.length, 2);
	});

	test('a 2-segment UCS2 message (一 and an emoji) gets 2 ids and a DLR per id', async t => {
		const dlrs: Dlr[] = [];

		const { err, session } = await client({ host: PEER_HOST, port: PEER_PORT, username: 'ucs2-multipart' });

		assert.equal(err, undefined);
		assert.ok(session);
		closeAfter(t, session);

		session.on('dlr', dlr => { dlrs.push(dlr); });

		// 一 (2 bytes) + an emoji (a surrogate pair, 4 bytes) + 70 padding chars (2 bytes each):
		// 146 bytes, over the 140-byte single-segment budget, under the 268-byte 2-segment one.
		const smsIds = await sendUntilAllDlrsArrive(session, dlrs, `一😀${'x'.repeat(70)}`);

		assert.equal(smsIds.length, 2);
	});
});

describe('smscsim - MO injection through the web UI', () => {
	test('a message posted to the web page arrives as an sms event', async t => {
		const { err, session } = await client({
			bindType: 'transceiver',
			host: PEER_HOST,
			port: PEER_PORT,
			username: 'mo-inject',
		});

		assert.equal(err, undefined);
		assert.ok(session);
		closeAfter(t, session);

		const incoming: Sms[] = [];

		session.on('sms', sms => { incoming.push(sms); });

		let sms: Sms | undefined;

		for (let attempt = 0; attempt < DLR_MAX_ATTEMPTS && !sms; attempt++) {
			const before = incoming.length;

			const response = await fetch(`http://${PEER_HOST}:${String(PEER_WEB_PORT)}/`, {
				body: new URLSearchParams({
					message: 'hello from the web UI',
					recipient: '46709771337',
					sender: '46701113311',
					system_id: 'mo-inject',
				}),
				method: 'POST',
				redirect: 'manual',
			});

			assert.equal(response.status, 303);
			assert.match(response.headers.get('location') ?? '', /message=/);

			await waitFor(() => incoming[before], DLR_RETRY_BUDGET_MS);
			sms = incoming[before];
		}

		assert.ok(sms, 'no MO message arrived across the attempts');
		assert.equal(sms.from, '46701113311');
		assert.equal(sms.to, '46709771337');
		assert.equal(sms.message, 'hello from the web UI');

		assert.equal((await sms.sendResp()).err, undefined);
	});
});

describe('smscsim-failing - C12 refusals', () => {
	test('even sequence numbers are refused, odd ones get an undeliverable DLR', async t => {
		const dlrs: Dlr[] = [];

		const { err, session } = await client({ host: FAILING_PEER_HOST, port: FAILING_PEER_PORT, username: 'c12' });

		assert.equal(err, undefined);
		assert.ok(session);
		closeAfter(t, session);

		session.on('dlr', dlr => { dlrs.push(dlr); });

		let refusedSeen = false;
		let acceptedConfirmed = false;

		for (let attempt = 0; attempt < DLR_MAX_ATTEMPTS && !(refusedSeen && acceptedConfirmed); attempt++) {
			const before = dlrs.length;

			// Sequential: smscsim keys its refusal on each submit_sm's own sequence number parity.
			const result = await session.sendSms({
				dlr: true,
				from: '46701113311',
				message: `refusal check ${String(attempt)}`,
				to: '46709771337',
			});

			if (result.err !== undefined) {
				assert.match(result.err.message, /ESME_RSYSERR/);
				refusedSeen = true;
				continue;
			}

			assert.equal(result.smsIds.length, 1);

			const [smsId] = result.smsIds;

			assert.ok(smsId);

			const matched = await waitFor(() => dlrs.slice(before).find(dlr => dlr.smsId === smsId), DLR_RETRY_BUDGET_MS);

			if (matched) {
				assert.equal(matched.statusMsg, 'UNDELIVERABLE');
				acceptedConfirmed = true;
			}
		}

		assert.ok(refusedSeen, 'no send was refused across the attempts');
		assert.ok(acceptedConfirmed, 'no accepted send got a confirmed undeliverable DLR');

		// The session must stay bound and usable after a refusal.
		const enquired = await session.send({ cmdName: 'enquire_link' });

		assert.equal(enquired.err, undefined);
	});
});
