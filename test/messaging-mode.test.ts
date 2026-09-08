import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import type { PduObjectInput } from '../src/pdu.ts';
import type { SendSmsDeps } from '../src/send-sms.ts';
import type { Session } from '../src/session.ts';
import type { SubmitMessagingMode } from '../src/defs/constants.ts';
import type { TestContext } from 'node:test';
import { bindToSmsc, dummySmsc } from './dummy-smsc.ts';
import { consts, submitMessagingModes } from '../src/defs/constants.ts';
import { paramNumber } from '../src/defs/types.ts';
import { pduToObj } from '../src/pdu.ts';
import { silentLog } from '../src/log.ts';
import { submitSms } from '../src/send-sms.ts';

const from = '46701113311';
const to = '46709771337';

/** Seven copies fill three GSM segments, the last of them short. */
const longMessage = 'Segments of a long message, counted in a user data header. '.repeat(7);

/** A freshly bound session's first submit_sm for `Hello world`: sequence number 2. */
const singleSegmentOctets = '0000004200000004000000000000000200010034363730313131333331310001003436373039373731333337000000000000000001000b48656c6c6f20776f726c64';

/** The same for `longMessage`: concatenation reference 1, sequence numbers 2 to 4. */
const threeSegmentOctets = [
	'000000d600000004000000000000000200010034363730313131333331310001003436373039373731333337004000000000000001009f0500030103015365676d656e7473206f662061206c6f6e67206d6573736167652c20636f756e74656420696e206120757365722064617461206865616465722e205365676d656e7473206f662061206c6f6e67206d6573736167652c20636f756e74656420696e206120757365722064617461206865616465722e205365676d656e7473206f662061206c6f6e67206d6573736167652c20636f756e746564',
	'000000d600000004000000000000000300010034363730313131333331310001003436373039373731333337004000000000000001009f05000301030220696e206120757365722064617461206865616465722e205365676d656e7473206f662061206c6f6e67206d6573736167652c20636f756e74656420696e206120757365722064617461206865616465722e205365676d656e7473206f662061206c6f6e67206d6573736167652c20636f756e74656420696e206120757365722064617461206865616465722e205365676d656e7473206f66',
	'000000a80000000400000000000000040001003436373031313133333131000100343637303937373133333700400000000000000100710500030103032061206c6f6e67206d6573736167652c20636f756e74656420696e206120757365722064617461206865616465722e205365676d656e7473206f662061206c6f6e67206d6573736167652c20636f756e74656420696e206120757365722064617461206865616465722e20',
];

type BoundPeer = {
	/** Every submit_sm the ESME wrote, exactly as it arrived on the socket. */
	octets: Buffer[];
	session: Session;
};

async function boundToPeer(t: TestContext): Promise<BoundPeer> {
	const smsc = await dummySmsc(t);
	const session = await bindToSmsc(t, smsc.port, { reconnect: false });

	return { octets: smsc.octets, session };
}

function hexOf(octets: Buffer[]): string[] {
	return octets.map(pdu => pdu.toString('hex'));
}

/** A send that records what it is handed, so a refusal shows up as an empty attempt log. */
function recordingDeps(attempts: PduObjectInput[]): SendSmsDeps {
	return {
		log: silentLog,
		reference: 1,
		send: input => {
			attempts.push(input);

			return Promise.resolve({ err: new Error('the recording peer never answers') });
		},
	};
}

function esmClassesOf(octets: Buffer[]): number[] {
	return octets.map(pdu => {
		const { pduObj } = pduToObj(pdu);

		assert.ok(pduObj);

		return paramNumber(pduObj.params.esm_class, 0);
	});
}

describe('sendSms() with no messagingMode', () => {
	test('writes a single-segment message as the octets it has always written', async t => {
		const peer = await boundToPeer(t);
		const sent = await peer.session.sendSms({ from, message: 'Hello world', to });

		assert.equal(sent.err, undefined);
		assert.deepEqual(hexOf(peer.octets), [singleSegmentOctets]);
	});

	test('writes every segment of a three-segment message as the octets it has always written', async t => {
		const peer = await boundToPeer(t);
		const sent = await peer.session.sendSms({ from, message: longMessage, to });

		assert.equal(sent.err, undefined);
		assert.equal(sent.smsIds.length, 3);
		assert.deepEqual(hexOf(peer.octets), threeSegmentOctets);
	});

	test('writes what SMSC_DEFAULT writes, octet for octet, single-segment and multipart alike', async t => {
		const one = await boundToPeer(t);
		const single = await one.session.sendSms({ from, message: 'Hello world', messagingMode: 'SMSC_DEFAULT', to });

		assert.equal(single.err, undefined);
		assert.deepEqual(hexOf(one.octets), [singleSegmentOctets]);

		const many = await boundToPeer(t);
		const long = await many.session.sendSms({ from, message: longMessage, messagingMode: 'SMSC_DEFAULT', to });

		assert.equal(long.err, undefined);
		assert.deepEqual(hexOf(many.octets), threeSegmentOctets);
	});
});

describe('sendSms() messagingMode', () => {
	test('gives each mode its own bits — store and forward alone is 0x03, and 0x43 per segment', async t => {
		const modes: SubmitMessagingMode[] = ['DATAGRAM', 'SMSC_DEFAULT', 'STORE_FORWARD'];

		assert.deepEqual(modes, submitMessagingModes, 'every mode submit_sm carries is covered here');
		assert.equal(consts.MESSAGING_MODE.FORWARD, 0x02, 'the spec table still names the fourth mode');

		for (const messagingMode of modes) {
			const peer = await boundToPeer(t);
			const bits = consts.MESSAGING_MODE[messagingMode];
			const single = await peer.session.sendSms({ from, message: 'Hello world', messagingMode, to });
			const long = await peer.session.sendSms({ from, message: longMessage, messagingMode, to });

			assert.equal(single.err, undefined);
			assert.equal(long.err, undefined);
			assert.deepEqual(
				esmClassesOf(peer.octets),
				[bits, bits | 0x40, bits | 0x40, bits | 0x40],
				`${messagingMode} keeps the UDH indicator on every segment carrying one`,
			);
		}
	});

	test('refuses a value naming no messaging mode before a segment reaches the wire', async () => {
		const attempts: PduObjectInput[] = [];
		const deps = recordingDeps(attempts);
		const named = /messagingMode must be DATAGRAM, SMSC_DEFAULT, STORE_FORWARD/;
		// The bits themselves, the whole esm_class an operator documents, and an esm_class name that
		// is no mode at all — the one that would clear the UDH indicator if a number were taken.
		const refused = [3, 0x43, 'UDH_INDICATOR', 'store_forward', {}];

		for (const messagingMode of refused) {
			const sent = await submitSms(deps, { from, message: 'Hello world', messagingMode, to });

			assert.ok(sent.err instanceof Error, JSON.stringify(messagingMode));
			assert.match(sent.err.message, named);
			assert.deepEqual(sent.smsIds, []);
			assert.equal(sent.unanswered, 0);
		}

		assert.match((await submitSms(deps, { from, message: 'x', messagingMode: 3, to })).err?.message ?? '', /got 3/);
		assert.match((await submitSms(deps, { from, message: 'x', messagingMode: {}, to })).err?.message ?? '', /got object/);
		assert.equal(attempts.length, 0, 'a refused mode puts nothing on the wire');
	});

	test('refuses transaction mode, which SMPP carries on data_sm and this never sends', async () => {
		const attempts: PduObjectInput[] = [];
		const sent = await submitSms(recordingDeps(attempts), {
			from,
			message: 'Hello world',
			messagingMode: 'FORWARD',
			to,
		});

		assert.ok(sent.err instanceof Error);
		assert.match(sent.err.message, /FORWARD is data_sm only/);
		assert.match(sent.err.message, /name DATAGRAM, SMSC_DEFAULT, STORE_FORWARD/);
		assert.equal(attempts.length, 0);
	});

	test('refuses a delivery report under datagram mode, which defines one away', async () => {
		const attempts: PduObjectInput[] = [];
		const deps = recordingDeps(attempts);
		const sent = await submitSms(deps, {
			dlr: true,
			from,
			message: 'Hello world',
			messagingMode: 'DATAGRAM',
			to,
		});

		assert.ok(sent.err instanceof Error);
		assert.match(sent.err.message, /DATAGRAM has no delivery report/);
		assert.equal(attempts.length, 0);

		// The mode alone is fine, and so is a report under any mode that has one.
		const datagram = await submitSms(deps, { from, message: 'Hello world', messagingMode: 'DATAGRAM', to });
		const reported = await submitSms(deps, { dlr: true, from, message: 'Hello world', to });

		assert.equal(datagram.err?.message, 'the recording peer never answers');
		assert.equal(reported.err?.message, 'the recording peer never answers');
		assert.equal(attempts.length, 2);
	});
});
