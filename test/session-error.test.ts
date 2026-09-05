import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import type { PduHeader, Session } from '../src/index.ts';
import type { TestContext } from 'node:test';
import { PduRefusedError, client, server } from '../src/index.ts';
import { closeAfter } from './teardown.ts';
import { shortened, truncatedTlv, withUnknownCmdId } from './malformed-pdus.ts';

const receipt = {
	destination_addr: '46709771337',
	short_message: 'id:01a07342-a1d0-7479-88d6-c80082e19aec stat:DELIVRD err:000 text:',
	source_addr: '46701113311',
};

function once<T>(register: (resolve: (value: T) => void) => void): Promise<T> {
	return new Promise<T>(resolve => { register(resolve); });
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => { setTimeout(resolve, ms); });
}

function raceWithin<T>(ms: number, promise: Promise<T>): Promise<T | false> {
	return Promise.race([promise, delay(ms).then((): false => false)]);
}

/** Polls until the condition holds; false means it never did within the budget. */
async function waitFor(condition: () => boolean, budget = 2000): Promise<boolean> {
	const deadline = Date.now() + budget;

	while (!condition()) {
		if (Date.now() > deadline) return false;

		await delay(5);
	}

	return true;
}

/** A bound client, and the server session at the far end whose socket the tests write from. */
async function linked(t: TestContext, options: Parameters<typeof client>[0] = {}) {
	const { err, server: smpp } = await server({ port: 0 });

	assert.equal(err, undefined);
	assert.ok(smpp);
	closeAfter(t, smpp);

	const accepted = once<Session>(resolve => { smpp.on('session', resolve); });
	const { session } = await client({ port: smpp.port, ...options });

	assert.ok(session);
	closeAfter(t, session);

	const peer = await raceWithin(2000, accepted);

	assert.ok(peer, 'the server never accepted a session');

	return { peer, session };
}

describe('telling a refused PDU from a failed session', () => {
	test('narrows a refusal to its class, command and reason, from the entry point alone', async t => {
		const { peer, session } = await linked(t);
		const failed = once<Error>(resolve => { session.on('sessionError', resolve); });

		peer.sock.write(truncatedTlv({ cmdName: 'deliver_sm', params: receipt, seqNr: 5 }));

		const reported = await raceWithin(2000, failed);

		assert.ok(reported instanceof PduRefusedError, 'a refusal narrows without a cast');

		const header: PduHeader = reported.header;

		assert.equal(header.cmdName, 'deliver_sm');
		assert.equal(header.seqNr, 5);
		assert.equal(reported.reason, 'tlvs');
	});

	test('names which part of the PDU it could not read, one refusal at a time', async t => {
		const { peer, session } = await linked(t);
		const seen: Error[] = [];

		session.on('sessionError', err => { seen.push(err); });

		peer.sock.write(withUnknownCmdId({ cmdName: 'enquire_link', seqNr: 9 }));
		peer.sock.write(shortened({ cmdName: 'deliver_sm', params: receipt, seqNr: 6 }, 3));
		peer.sock.write(truncatedTlv({ cmdName: 'deliver_sm', params: receipt, seqNr: 7 }));

		assert.ok(await waitFor(() => seen.length === 3), 'one sessionError per refused PDU');
		assert.deepEqual(
			seen.map(err => (err instanceof PduRefusedError ? err.reason : err.message)),
			['command', 'body', 'tlvs'],
		);
	});

	test('reports a listener that threw as an error that is no refusal', async t => {
		const { peer, session } = await linked(t, { responseTimeout: 200 });
		const failed = once<Error>(resolve => { peer.on('sessionError', resolve); });

		peer.on('sms', () => { throw new Error('listener exploded'); });

		await session.sendSms({ from: '46701113311', message: 'blows the listener up', to: '46709771337' });

		const reported = await raceWithin(2000, failed);

		assert.ok(reported, 'the listener that threw never reached the session');
		assert.ok(!(reported instanceof PduRefusedError), 'a session failure is not a refused PDU');
		assert.equal(reported.message, 'listener exploded');
	});

	test('reports a socket the peer reset as an error that is no refusal', async t => {
		const { peer, session } = await linked(t, { reconnect: false });
		const failed = once<Error>(resolve => { session.on('sessionError', resolve); });

		peer.sock.resetAndDestroy();

		const reported = await raceWithin(2000, failed);

		assert.ok(reported, 'a reset socket never reached the session');
		assert.ok(!(reported instanceof PduRefusedError), 'a dead socket is not a refused PDU');
	});
});
