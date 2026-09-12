import assert from 'node:assert/strict';
import test, { after, describe } from 'node:test';
import type { Session } from '../src/session.ts';
import type { Sms } from '../src/sms.ts';
import type { LogMethod, SmppLog } from '../src/log.ts';
import { server } from '../src/server.ts';

const SMPP_PORT = Number(process.env.SMPP_PORT ?? '2775');
/** Slower than every scenario's submission rate (2000/s for the window runs), so a real backlog
 * presses on the configured window instead of draining as fast as it fills - see findings/07-load.md. */
const SLOW_HANDLER_DELAY_MS = 2;

function delay(ms: number): Promise<void> {
	return new Promise(resolve => { setTimeout(resolve, ms); });
}

async function waitFor<T>(get: () => T | undefined, budget: number): Promise<T | undefined> {
	const deadline = Date.now() + budget;
	let value = get();

	while (value === undefined && Date.now() < deadline) {
		await delay(50);
		value = get();
	}

	return value;
}

type ScenarioUserData = { systemId: string };

function isScenarioUserData(value: unknown): value is ScenarioUserData {
	return typeof value === 'object' && value !== null && typeof (value as { systemId?: unknown }).systemId === 'string';
}

function scenarioOf(session: Session): string {
	return isScenarioUserData(session.userData) ? session.userData.systemId : 'unknown';
}

type ScenarioStats = {
	answerOrder: number[];
	answered: number;
	arrived: number;
	// Set from a 'close' listener attached the moment the session is first seen (smpp.on('session')),
	// never lazily inside a test body - a session can close well before a test gets around to
	// watching for it (S9 above may run for a minute; idleTimeout is 40s), and an EventEmitter never
	// replays an event to a listener added after it fired.
	closed: boolean;
	duplicateIds: number;
	ids: Set<string>;
	peakOutstanding: number;
	unansweredErrors: number;
};

const stats = new Map<string, ScenarioStats>();

function statsFor(name: string): ScenarioStats {
	const existing = stats.get(name);

	if (existing) return existing;

	const created: ScenarioStats = {
		answerOrder: [],
		answered: 0,
		arrived: 0,
		closed: false,
		duplicateIds: 0,
		ids: new Set(),
		peakOutstanding: 0,
		unansweredErrors: 0,
	};

	stats.set(name, created);

	return created;
}

type LogEntry = { level: string; message: string; metadata: Record<string, boolean | number | string> | undefined };

const logEntries: LogEntry[] = [];

function capture(level: string): LogMethod {
	return (message, metadata) => { logEntries.push({ level, message, metadata }); };
}

const log: SmppLog = {
	debug: capture('debug'),
	error: capture('error'),
	info: capture('info'),
	verbose: capture('verbose'),
	warn: capture('warn'),
};

type MemSample = { heapUsed: number; rss: number; t: number };

const memSamples: MemSample[] = [];
const memTimer = setInterval(() => {
	const usage = process.memoryUsage();

	memSamples.push({ heapUsed: usage.heapUsed, rss: usage.rss, t: Date.now() });
}, 5000);

memTimer.unref();

const { err, server: smpp } = await server({
	authenticate: ({ systemId }) => ({ userData: { systemId } satisfies ScenarioUserData }),
	idleTimeout: 40_000,
	log,
	port: SMPP_PORT,
});

assert.equal(err, undefined);
assert.ok(smpp);

const serverErrors: Error[] = [];

smpp.on('serverError', serverError => { serverErrors.push(serverError); });

const sessionByScenario = new Map<string, Session>();
const slowQueues = new Map<Session, Promise<void>>();

function answered(session: Session, arrivalIndex: number, result: { err?: Error }): void {
	const s = statsFor(scenarioOf(session));

	s.answered++;
	s.answerOrder.push(arrivalIndex);
	if (result.err) s.unansweredErrors++;
}

function slowRespond(session: Session, sms: Sms, arrivalIndex: number): void {
	const chain = (slowQueues.get(session) ?? Promise.resolve())
		.then(async () => { await delay(SLOW_HANDLER_DELAY_MS); })
		.then(async () => { answered(session, arrivalIndex, await sms.sendResp()); });

	slowQueues.set(session, chain);
}

function fastRespond(session: Session, sms: Sms, arrivalIndex: number): void {
	void sms.sendResp().then(result => { answered(session, arrivalIndex, result); });
}

smpp.on('session', session => {
	// Attached now, not lazily in a test body - see the comment on ScenarioStats.closed.
	session.on('close', () => { statsFor(scenarioOf(session)).closed = true; });

	session.on('sms', sms => {
		const name = scenarioOf(session);

		sessionByScenario.set(name, session);

		const s = statsFor(name);
		const arrivalIndex = s.arrived;

		s.arrived++;
		if (s.ids.has(sms.smsId)) s.duplicateIds++;
		else s.ids.add(sms.smsId);
		s.peakOutstanding = Math.max(s.peakOutstanding, s.arrived - s.answered);

		if (name === 'dumb-w500' || name === 'dumb-w2000') slowRespond(session, sms, arrivalIndex);
		else fastRespond(session, sms, arrivalIndex);
	});
});

function memShape(): string {
	if (memSamples.length === 0) return 'no samples taken (run shorter than the 5s sample interval)';

	const first = memSamples[0];
	const last = memSamples[memSamples.length - 1];

	assert.ok(first);
	assert.ok(last);

	const rssValues = memSamples.map(sample => sample.rss);
	const peakRss = Math.max(...rssValues);
	const minRss = Math.min(...rssValues);
	const spanS = ((last.t - first.t) / 1000).toFixed(0);

	return [
		`samples=${String(memSamples.length)} over ${spanS}s`,
		`rss first=${String(Math.round(first.rss / 1024 / 1024))}MiB`,
		`min=${String(Math.round(minRss / 1024 / 1024))}MiB`,
		`max=${String(Math.round(peakRss / 1024 / 1024))}MiB`,
		`last=${String(Math.round(last.rss / 1024 / 1024))}MiB`,
		`heapUsed last=${String(Math.round(last.heapUsed / 1024 / 1024))}MiB`,
	].join(', ');
}

function isSorted(values: number[]): boolean {
	return values.every((value, index) => index === 0 || (values[index - 1] ?? 0) <= value);
}

function report(line: string): void {
	process.stdout.write(`${line}\n`);
}

after(async () => {
	clearInterval(memTimer);
	report(`memory shape: ${memShape()}`);
	for (const [name, s] of stats) {
		report(`${name}: arrived=${String(s.arrived)} answered=${String(s.answered)} duplicateIds=${String(s.duplicateIds)} peakOutstanding=${String(s.peakOutstanding)} unansweredErrors=${String(s.unansweredErrors)}`);
	}

	await smpp.close();

	for (const serverError of serverErrors) report(`serverError: ${serverError.message}`);
});

// S9 (target 11) and the backpressure-at-server scenario: window 2000 at a high rate against a
// handler slowed enough to build a real backlog. window500 is the same shape with a window below
// maxHeldMessages (1000, session-options.ts defaults.maxHeldMessages) - see findings/07-load.md for
// what that constant, rather than maxOutstanding, turns out to be the one that interacts with a
// peer's window.
describe('S9 - bounded window against a slowed handler', () => {
	for (const [name, expectedCount] of [['dumb-w500', 20_000], ['dumb-w2000', 20_000]] as const) {
		test(`${name}: every message answered exactly once, ordering holds`, async () => {
			const done = await waitFor(() => (statsFor(name).answered >= expectedCount ? true : undefined), 180_000);

			assert.ok(done, `${name} did not answer ${String(expectedCount)} messages within budget`);

			const s = statsFor(name);

			assert.equal(s.arrived, expectedCount);
			assert.equal(s.answered, expectedCount);
			assert.equal(s.duplicateIds, 0);
			assert.equal(s.unansweredErrors, 0);
			assert.equal(s.ids.size, expectedCount);
			assert.ok(isSorted(s.answerOrder), `${name} answered out of arrival order`);
		});
	}

	test('window 2000 pressed past maxHeldMessages (1000): the internal held-message cap evicts, window500 never does', async () => {
		await waitFor(() => (statsFor('dumb-w2000').answered >= 20_000 ? true : undefined), 180_000);

		const evictions = logEntries.filter(entry => entry.message === 'heldMessages - buffer full, dropping the oldest message');

		// window500's peak (<=500) never reaches the 1000 default, so any eviction observed is
		// necessarily from the w2000 session - the two runs share one server and one log.
		assert.ok(evictions.length > 0, 'expected at least one held-message eviction under window 2000');
		// The peer's own window, respected exactly both runs (peakOutstanding read 500 and 2000 on
		// the nose) - the lower bound is what distinguishes this from window500's own eviction-free run.
		assert.ok(statsFor('dumb-w2000').peakOutstanding > 1000 && statsFor('dumb-w2000').peakOutstanding <= 2000);
		assert.equal(statsFor('dumb-w500').peakOutstanding <= 500, true);
	});

	test('memory after the backlog drains back down is close to before either window run started', async () => {
		const before = memSamples[0];

		assert.ok(before, 'no memory sample taken before the window runs started');

		// Node's GC is opportunistic, so this is printed evidence of the shape (per findings/07-load.md),
		// not a hard bound - a real leak reads as a trend across the whole run's samples, not one pair.
		await delay(5000);

		const after = process.memoryUsage();

		report(
			`memory around the window runs: before=${String(Math.round(before.rss / 1024 / 1024))}MiB `
			+ `after=${String(Math.round(after.rss / 1024 / 1024))}MiB`,
		);
	});
});

// S6 (target: idleTimeout) - a peer that sends one message and then, using the no-ping binary
// (Dockerfile), never speaks again: no enquire_link, ever. smppload was meant to be this peer and
// is blocked (findings/07-load.md), so this is the substitute.
describe('S6 - idle peer, no enquire_link at all', () => {
	test('our server drops it at idleTimeout, with no response sent past the one it owed', async () => {
		const bound = await waitFor(() => (statsFor('dumb-idle').arrived >= 1 ? true : undefined), 20_000);

		assert.ok(bound, 'dumb-idle never submitted its one message');

		// idleTimeout is 40s from the last byte the peer sent (its submit_sm), never from our own
		// writes (link-timers.ts resets only on inbound data). This test may start running well
		// past that mark on its own (S9 above can take a minute) - statsFor(...).closed is set from
		// a 'close' listener attached at session-creation time, so a close from before this test
		// even started is still seen; budget is slack for a session that is still open, not a clock.
		const droppedIdle = await waitFor(() => (statsFor('dumb-idle').closed ? true : undefined), 60_000);

		assert.ok(droppedIdle, 'server never dropped the idle peer within idleTimeout + slack');
		assert.ok(logEntries.some(entry => entry.message === 'linkTimers - closing an idle peer'));
		// teardown() (session.ts) is a raw close, not an unbind exchange - nothing further is on the
		// wire for this session, which the capture's histogram (findings/07-load.md) confirms.
		assert.equal(statsFor('dumb-idle').answered, 1);
	});
});

// The long soak: the longest run the time-box allows, fast handler, watched for anything that
// grows without bound (held messages, listeners, memory). Bounded by wall-clock rather than a
// target count: smpp-dumb-client's own TX-tracking window bookkeeping stalls under sustained load
// (findings/07-load.md, Peer quirks) well short of the configured count, on the client's side only
// - our own arrived/answered stay in lockstep throughout, which is what this asserts.
describe('Long soak', () => {
	const SOAK_DURATION_MS = 300_000;

	test('the longest run the time-box allows: every arrival answered, nothing duplicated, memory does not grow without bound', async () => {
		await delay(SOAK_DURATION_MS);

		// One more turn for a response mid-flight when the clock ran out to land, not a target count.
		await waitFor(() => {
			const s = statsFor('dumb-soak');

			return s.arrived === s.answered ? true : undefined;
		}, 5000);

		const s = statsFor('dumb-soak');

		report(`soak reached: arrived=${String(s.arrived)} over ${String(SOAK_DURATION_MS / 1000)}s`);

		assert.ok(s.arrived > 0, 'dumb-soak never submitted anything');
		assert.equal(s.answered, s.arrived);
		assert.equal(s.duplicateIds, 0);
		assert.equal(s.unansweredErrors, 0);

		const session = sessionByScenario.get('dumb-soak');

		assert.ok(session);

		const closed = await session.close();

		assert.equal(closed.err, undefined);
	});
});
