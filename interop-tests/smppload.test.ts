import assert from 'node:assert/strict';
import test, { after, describe } from 'node:test';
import type { Session } from '../src/session.ts';
import { server } from '../src/server.ts';

const SMPP_PORT = Number(process.env.SMPP_PORT ?? '2775');

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

const { err, server: smpp } = await server({ authenticate: () => true, idleTimeout: 40_000, port: SMPP_PORT });

assert.equal(err, undefined);
assert.ok(smpp);

after(async () => {
	await smpp.close();
});

// smppload 2.5.3 (built at interop-tests/peers/smppload, its issue #8 rebar3/BEAM friction worked
// around with a current rebar3 release) is otherwise blocked: every bind_transceiver it puts on the
// wire is two octets short of what its own command_length declares, corrupting command_length and
// command_id both - findings/07-load.md carries the tshark capture. S6 and S8, both scoped to this
// peer in PLAN.md, could not run; dumbclient.test.ts carries the load and window scenarios instead.
describe('smppload (blocked)', () => {
	test('the corrupted bind_transceiver is refused as an unframeable stream, not left to hang', async () => {
		let session: Session | undefined;
		let sessionErr: Error | undefined;
		let closed = false;

		smpp.on('session', incoming => {
			session = incoming;
			incoming.on('sessionError', sessionError => { sessionErr = sessionError; });
			incoming.on('close', () => { closed = true; });
		});

		const bound = await waitFor(() => session, 20_000);

		assert.ok(bound, 'smppload never opened a TCP connection to node:2775');

		const refusal = await waitFor(() => sessionErr, 10_000);

		assert.ok(refusal);
		// maxPduLength (pdu-refusal.ts) is 1MiB; the corrupted command_length (0x2a shifted into the
		// high bytes) reads as roughly 2.75M, so this is the "unreadable stream" teardown, not the
		// "one bad PDU, link stays up" path - see AGENTS.md, "A stream this library cannot frame...".
		assert.match(refusal.message, /Refusing a cmd_length of \d+/);

		await waitFor(() => (closed ? true : undefined), 5000);
		assert.equal(closed, true);
		assert.ok(bound);
		assert.equal(bound.loggedIn, false);
	});
});
