import assert from 'node:assert/strict';
import net from 'node:net';
import test, { describe } from 'node:test';
import type { MessagingMode } from '../src/defs/constants.ts';
import type { Session } from '../src/session.ts';
import type { TestContext } from 'node:test';
import { PduFramer } from '../src/pdu-framer.ts';
import { checkMessagingMode } from '../src/send-sms.ts';
import { client } from '../src/client.ts';
import { closeAfter, closeListenerAfter } from './teardown.ts';
import { consts, messagingModes } from '../src/defs/constants.ts';
import { paramNumber } from '../src/defs/types.ts';
import { pduReturn, pduToObj } from '../src/pdu.ts';
import { uuidv7 } from '../src/uuid.ts';

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

/** An SMSC that answers a bind and every submit, keeping the octets each submit arrived as. */
async function boundToPeer(t: TestContext): Promise<BoundPeer> {
	const octets: Buffer[] = [];
	const sockets: net.Socket[] = [];
	const listener = net.createServer(sock => {
		const framer = new PduFramer();

		sockets.push(sock);
		sock.on('data', chunk => {
			framer.push(chunk);

			for (const pdu of framer.next().pdus ?? []) {
				const { pduObj } = pduToObj(pdu);

				if (!pduObj) continue;

				if (pduObj.cmdName === 'submit_sm') octets.push(pdu);

				const answered = pduReturn(pduObj, 'ESME_ROK', pduObj.cmdName === 'submit_sm'
					? { message_id: uuidv7() }
					: { system_id: 'byte-peer' });

				if (answered.buffer) sock.write(answered.buffer);
			}
		});
	});

	closeListenerAfter(t, listener, sockets);
	await new Promise<void>(resolve => { listener.listen(0, resolve); });

	const address = listener.address();
	const port = typeof address === 'object' && address !== null ? address.port : 0;
	const { err, session } = await client({ port, reconnect: false });

	assert.equal(err, undefined);
	assert.ok(session);
	closeAfter(t, session);

	return { octets, session };
}

function hexOf(octets: Buffer[]): string[] {
	return octets.map(pdu => pdu.toString('hex'));
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
	test('sends store and forward alone on a single-segment message', async t => {
		const peer = await boundToPeer(t);
		const sent = await peer.session.sendSms({
			from,
			message: 'Hello world',
			messagingMode: 'STORE_FORWARD',
			to,
		});

		assert.equal(sent.err, undefined);
		assert.deepEqual(esmClassesOf(peer.octets), [0x03]);
	});

	test('sends store and forward beside the UDH indicator on every segment of a long message', async t => {
		const peer = await boundToPeer(t);
		const sent = await peer.session.sendSms({
			from,
			message: longMessage,
			messagingMode: 'STORE_FORWARD',
			to,
		});

		assert.equal(sent.err, undefined);
		assert.deepEqual(esmClassesOf(peer.octets), [0x43, 0x43, 0x43]);
	});

	test('gives every named mode its own bits, and no mode clears the UDH indicator', async t => {
		const modes: MessagingMode[] = ['DATAGRAM', 'FORWARD', 'SMSC_DEFAULT', 'STORE_FORWARD'];

		assert.deepEqual(modes, messagingModes, 'every mode the constants name is covered here');

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
				messagingMode,
			);
		}
	});

	test('refuses a value naming no messaging mode, and names the four it takes', () => {
		const named = /messagingMode must be DATAGRAM, FORWARD, SMSC_DEFAULT, STORE_FORWARD/;

		// The bits themselves, and the whole esm_class an operator documents for concatenation.
		assert.match(checkMessagingMode(3)?.message ?? '', named);
		assert.match(checkMessagingMode(3)?.message ?? '', /got 3/);
		assert.match(checkMessagingMode(0x43)?.message ?? '', /got 67/);
		// UDH_INDICATOR is an esm_class name rather than a mode, so no spelling can clear that bit.
		assert.match(checkMessagingMode('UDH_INDICATOR')?.message ?? '', named);
		assert.match(checkMessagingMode('store_forward')?.message ?? '', named);
		assert.match(checkMessagingMode({})?.message ?? '', /got object/);
		assert.equal(checkMessagingMode(undefined), undefined);

		for (const mode of messagingModes) {
			assert.equal(checkMessagingMode(mode), undefined, mode);
		}
	});
});
