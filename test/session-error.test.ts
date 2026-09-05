import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import type { PduHeader, PduObjectInput, Session } from '../src/index.ts';
import type { TestContext } from 'node:test';
import { PduRefusedError, client, objToPdu, server } from '../src/index.ts';
import { closeAfter } from './teardown.ts';

const receipt = {
	destination_addr: '46709771337',
	short_message: 'id:01a07342-a1d0-7479-88d6-c80082e19aec stat:DELIVRD err:000 text:',
	source_addr: '46701113311',
};

function once<T>(register: (resolve: (value: T) => void) => void): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error('waited 5000 ms for an event that never fired'));
		}, 5000);

		register(value => {
			clearTimeout(timer);
			resolve(value);
		});
	});
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

	return { peer: await accepted, session };
}

/** The octets objToPdu built, wearing a command id the codec has no command for. */
function unknownCommand(seqNr: number): Buffer {
	const { buffer } = objToPdu({ cmdName: 'enquire_link', seqNr });

	assert.ok(buffer);
	buffer.writeUInt32BE(0x00010001, 4);

	return buffer;
}

/** command_length honoured, so the stream stays in sync, with the declared body cut short. */
function shortened(input: PduObjectInput, octets: number): Buffer {
	const { buffer } = objToPdu(input);

	assert.ok(buffer);

	const cut = buffer.subarray(0, buffer.length - octets);

	cut.writeUInt32BE(cut.length, 0);

	return cut;
}

/** The same, with a message_state TLV declaring four octets of value and carrying one. */
function truncatedTlv(input: PduObjectInput): Buffer {
	const { buffer } = objToPdu(input);

	assert.ok(buffer);

	const appended = Buffer.concat([buffer, Buffer.from('0427000401', 'hex')]);

	appended.writeUInt32BE(appended.length, 0);

	return appended;
}

describe('telling a refused PDU from a failed session', () => {
	test('narrows a refusal to its class, command and reason, from the entry point alone', async t => {
		const { peer, session } = await linked(t);
		const failed = once<Error>(resolve => { session.on('sessionError', resolve); });

		peer.sock.write(truncatedTlv({ cmdName: 'deliver_sm', params: receipt, seqNr: 5 }));

		const reported = await failed;

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

		peer.sock.write(unknownCommand(9));
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

		const reported = await failed;

		assert.ok(!(reported instanceof PduRefusedError), 'a session failure is not a refused PDU');
		assert.equal(reported.message, 'listener exploded');
	});

	test('reports a socket the peer reset as an error that is no refusal', async t => {
		const { peer, session } = await linked(t, { reconnect: false });
		const failed = once<Error>(resolve => { session.on('sessionError', resolve); });

		peer.sock.resetAndDestroy();

		const reported = await failed;

		assert.ok(!(reported instanceof PduRefusedError), 'a dead socket is not a refused PDU');
	});

	// Both, deliberately: the call is the only place the send's outcome fits, the event the only
	// place a peer that answers unreadably is visible at all.
	test('settles the awaiting call and reports the event when a response is refused', async t => {
		const { peer, session } = await linked(t, { responseTimeout: 60000 });
		const failed = once<Error>(resolve => { session.on('sessionError', resolve); });

		peer.on('incomingPduObj', pduObj => {
			if (pduObj.cmdName !== 'submit_sm') return;

			peer.sock.write(truncatedTlv({
				cmdName: 'submit_sm_resp',
				params: { message_id: '01a07342-a1d2-7ee9-a9a4-9489ef33f4c0' },
				seqNr: pduObj.seqNr,
			}));
		});

		const sending = session.sendSms({ from: '46701113311', message: 'hi', to: '46709771337' });
		const sent = await raceWithin(2000, sending);

		assert.ok(sent, 'the send settles on the refusal rather than on the response timeout');
		assert.ok(sent.err instanceof Error);
		assert.equal(sent.unanswered, 1);

		const reported = await failed;

		assert.ok(reported instanceof PduRefusedError, 'and the refusal reaches the event as well');
		assert.equal(reported.header.cmdName, 'submit_sm_resp');
	});
});
