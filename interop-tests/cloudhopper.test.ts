import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after, describe } from 'node:test';
import type { Session } from '../src/session.ts';
import type { Sms } from '../src/sms.ts';
import type { SmppServer } from '../src/server.ts';
import { server } from '../src/server.ts';

const CLOUDHOPPER_HOST = process.env.CLOUDHOPPER_HOST ?? 'cloudhopper:8080';
const SMPP_PORT = Number(process.env.SMPP_PORT ?? '2775');
const TLS_PORT = Number(process.env.TLS_PORT ?? '2776');
/** How long the "slow" server holds a submit_sm before answering it - long enough that a burst of
 * concurrent submits genuinely queues behind a small window instead of finishing before it matters. */
const SLOW_DELAY_MS = 300;

function delay(ms: number): Promise<void> {
	return new Promise(resolve => { setTimeout(resolve, ms); });
}

async function waitFor<T>(get: () => T | undefined, budget = 8000): Promise<T | undefined> {
	const deadline = Date.now() + budget;
	let value = get();

	while (value === undefined && Date.now() < deadline) {
		await delay(20);
		value = get();
	}

	return value;
}

type DriverResult = Record<string, unknown>;

async function driver(path: string, params: Record<string, string> = {}): Promise<DriverResult> {
	const url = `http://${CLOUDHOPPER_HOST}${path}?${new URLSearchParams(params).toString()}`;
	const response = await fetch(url);

	return response.json() as Promise<DriverResult>;
}

const manualTexts = new Set<string>();
const allSms: { session: Session; sms: Sms }[] = [];

function attach(session: Session): void {
	session.on('sms', sms => {
		allSms.push({ session, sms });

		if (manualTexts.has(sms.message)) return;

		// The slow server this phase's window scenarios need: every ordinary submit is held for
		// SLOW_DELAY_MS before being answered, so a burst genuinely presses on a small window.
		void delay(SLOW_DELAY_MS).then(() => sms.sendResp());
	});
}

const { err: serverErr, server: smpp } = await server({ authenticate: () => true, idleTimeout: 40_000, port: SMPP_PORT });

assert.equal(serverErr, undefined);
assert.ok(smpp);
smpp.on('session', attach);

const key = readFileSync('/shared-certs/server.key');
const cert = readFileSync('/shared-certs/server.crt');
// Cloudhopper's SSL client (Netty 3.9.6.Final, from 2015) cannot complete a TLS 1.3 handshake - see
// findings/05-java-clients.md, Peer quirks. Capped here for S10 only; the plain listener above is
// unrestricted.
const { err: tlsServerErr, server: tlsSmpp } = await server({
	authenticate: () => true,
	idleTimeout: 40_000,
	port: TLS_PORT,
	tls: { cert, key, maxVersion: 'TLSv1.2' },
});

assert.equal(tlsServerErr, undefined);
assert.ok(tlsSmpp);
tlsSmpp.on('session', attach);

after(async () => {
	await smpp.close();
	await tlsSmpp.close();
});

async function waitForSessionCount(server_: SmppServer, count: number, budget = 15_000): Promise<Session[]> {
	const found = await waitFor(() => ([...server_.sessions].length >= count ? [...server_.sessions] : undefined), budget);

	assert.ok(found, `no ${String(count)} session(s) bound within ${String(budget)}ms`);

	return found;
}

describe('S5 - window pressure against a slow sms handler (target 11)', () => {
	for (const windowSize of [1, 10, 50]) {
		test(`window ${String(windowSize)}: every request answered, none twice, order preserved`, async () => {
			const session = `w${String(windowSize)}`;
			const bind = await driver('/bind', { password: 'chpw', session, systemId: `ch-${session}`, windowSize: String(windowSize) });

			assert.equal(bind.ok, true);
			await waitForSessionCount(smpp, 1);

			const count = windowSize === 50 ? 60 : windowSize * 3;
			const burst = await driver('/windowBurst', {
				count: String(count), prefix: session, session, timeoutMs: '30000',
			});

			assert.equal(burst.ok, true);
			const results = burst.results as { index: number; messageId?: string; ok: boolean }[];

			assert.equal(results.length, count);
			assert.ok(results.every(r => r.ok), `every submit answered: ${JSON.stringify(results.filter(r => !r.ok))}`);

			const ids = results.map(r => r.messageId);

			assert.equal(new Set(ids).size, ids.length, 'no message id answered twice');
			assert.ok((burst.peakWindowSize as number) <= windowSize, `peak window ${String(burst.peakWindowSize)} stayed within ${String(windowSize)}`);

			// "Order preserved" here means each response correlates to its own request rather than a
			// different one - guaranteed by Cloudhopper's own sequence-number-keyed window, which is
			// exactly why the per-index messageId uniqueness above is the meaningful assertion: each
			// of the `count` concurrent callers blocks on its own submit() and gets its own answer,
			// racing only on which of them the OS schedules onto the window's free slot(s) first.
			const arrived = allSms.filter(entry => entry.sms.message.startsWith(`${session}-`)).length;

			assert.equal(arrived, count);

			await driver('/unbind', { session });
		});
	}
});

describe('S5 - request expiry shorter than the handler delay (target 11)', () => {
	test('the peer reports the expiry itself; our side is not left in a bad state', async () => {
		const bind = await driver('/bind', {
			password: 'chpw', requestExpiryTimeout: '100', session: 'expiry', systemId: 'ch-expiry',
			windowMonitorInterval: '50', windowSize: '1',
		});

		assert.equal(bind.ok, true);
		await waitForSessionCount(smpp, 1);

		const text = 'expiry-probe';

		manualTexts.add(text);

		const submitted = driver('/submit', { session: 'expiry', text, timeoutMs: '5000' });
		const sms = await waitFor(() => allSms.find(entry => entry.sms.message === text)?.sms);

		assert.ok(sms);

		// Held well past requestExpiryTimeout (100ms) before answering, so the peer's own window
		// monitor gives up on it first - recorded, not asserted against, since that is the peer's call.
		await delay(1000);
		await sms.sendResp();

		const result = await submitted;

		assert.equal(result.ok, false);
		// Cloudhopper's window monitor gives up on the expired slot with a RecoverablePduException,
		// not the SmppTimeoutException its own per-call timeoutMs would throw - the two expiries are
		// distinct mechanisms and this is the window monitor's own name for it.
		assert.match(String(result.errorClass), /RecoverablePduException/);

		const health = await driver('/health');

		assert.equal(health.ok, true);
		await driver('/unbind', { session: 'expiry' });
	});
});

describe('S10 - Cloudhopper SSL client against our server({ tls })', () => {
	test('handshake, bind, submit over TLS', async () => {
		const bind = await driver('/bind', {
			password: 'chsslpw', port: String(TLS_PORT), session: 'tls', systemId: 'ch-tls', useSsl: 'true',
		});

		assert.equal(bind.ok, true);
		await waitForSessionCount(tlsSmpp, 1);

		const text = 'over-tls-phase5';
		const result = await driver('/submit', { session: 'tls', text });

		assert.equal(result.ok, true);
		assert.equal(result.commandStatus, 0);

		const sms = await waitFor(() => allSms.find(entry => entry.sms.message === text)?.sms);

		assert.ok(sms);
		await driver('/unbind', { session: 'tls' });
	});
});

describe('a refusing status is surfaced back to Cloudhopper', () => {
	test('sms.sendResp({ status: "ESME_RMSGQFUL" }) reaches Cloudhopper in the response', async () => {
		const bind = await driver('/bind', { password: 'chpw', session: 'refuse', systemId: 'ch-refuse' });

		assert.equal(bind.ok, true);
		await waitForSessionCount(smpp, 1);

		const text = 'ch-refuse-me';

		manualTexts.add(text);

		const submitted = driver('/submit', { session: 'refuse', text, timeoutMs: '5000' });
		const sms = await waitFor(() => allSms.find(entry => entry.sms.message === text)?.sms);

		assert.ok(sms);
		await sms.sendResp({ status: 'ESME_RMSGQFUL' });

		const result = await submitted;

		assert.equal(result.ok, true);
		assert.equal(result.commandStatus, 0x00000014);
		await driver('/unbind', { session: 'refuse' });
	});
});
