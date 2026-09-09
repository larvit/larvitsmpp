import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import type { PduObjectInput } from '../src/pdu.ts';
import type { SendSmsDeps } from '../src/send-sms.ts';
import type { Session } from '../src/session.ts';
import type { Sms } from '../src/sms.ts';
import type { TestContext } from 'node:test';
import { bindToSmsc, dummySmsc } from './dummy-smsc.ts';
import { client } from '../src/client.ts';
import { closeAfter } from './teardown.ts';
import { messageClassOf } from '../src/defs/encodings.ts';
import { paramNumber } from '../src/defs/types.ts';
import { pduToObj } from '../src/pdu.ts';
import { server } from '../src/server.ts';
import { silentLog } from '../src/log.ts';
import { submitSms } from '../src/send-sms.ts';

const from = '46701113311';
const to = '46709771337';

type MessagePeer = {
	/** Every message the server session was handed, in arrival order. */
	received: Sms[];
	session: Session;
};

/** A server that answers every message, and a client to write raw submit_sm PDUs at it. */
async function messagesInto(t: TestContext): Promise<MessagePeer> {
	const received: Sms[] = [];
	const { err, server: smpp } = await server({ port: 0 });

	assert.equal(err, undefined);
	assert.ok(smpp);
	closeAfter(t, smpp);

	smpp.on('session', peer => peer.on('sms', sms => {
		received.push(sms);

		return sms.sendResp();
	}));

	const connected = await client({ port: smpp.port, reconnect: false });

	assert.equal(connected.err, undefined);
	assert.ok(connected.session);
	closeAfter(t, connected.session);

	return { received, session: connected.session };
}

function dataCodingsOf(octets: Buffer[]): number[] {
	return octets.map(pdu => {
		const { pduObj } = pduToObj(pdu);

		assert.ok(pduObj);

		return paramNumber(pduObj.params.data_coding, 0);
	});
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

describe('messageClassOf()', () => {
	test('reads the class out of both of the coding groups that carry one', () => {
		const classes: [number, number | undefined][] = [
			[0x10, 0], [0x11, 1], [0x12, 2], [0x13, 3],
			[0x14, 0], [0x18, 0], [0x1B, 3],
			[0xF0, 0], [0xF1, 1], [0xF2, 2], [0xF3, 3],
			[0xF4, 0], [0xF7, 3],
		];

		for (const [dataCoding, messageClass] of classes) {
			assert.equal(messageClassOf(dataCoding), messageClass, dataCoding.toString(16));
		}
	});

	// Bit 5 marks the text compressed and bits 7-6 mark it for automatic deletion; neither moves the
	// class bits, and 01xx is coded exactly as 00xx.
	test('reads the class of a compressed message and of the automatic-deletion group', () => {
		const classes: [number, number][] = [[0x30, 0], [0x33, 3], [0x50, 0], [0x53, 3], [0x70, 0], [0x78, 0]];

		for (const [dataCoding, messageClass] of classes) {
			assert.equal(messageClassOf(dataCoding), messageClass, dataCoding.toString(16));
		}
	});

	test('reports no class where the coding group defines none', () => {
		// Bit 4 clear below 0x80, then the reserved, message-waiting and reserved groups above it.
		for (const dataCoding of [0x00, 0x01, 0x03, 0x08, 0x0F, 0x20, 0x40, 0x4F, 0x80, 0xC0, 0xD0, 0xE0, 0xEF]) {
			assert.equal(messageClassOf(dataCoding), undefined, dataCoding.toString(16));
		}
	});
});

describe('an inbound message', () => {
	test('is flash for message class 0 alone, in either coding group', async t => {
		const peer = await messagesInto(t);
		// 0.4.0 read 0x10 and nothing else; this branch read 0x10-0x1F, so the three stored classes
		// arrived as flash and the whole 0xF0 group did not (interop-tests/findings/02-smppsim.md, C17).
		const codings: [number, boolean][] = [
			[0x00, false], [0x03, false], [0x08, false],
			[0x10, true], [0x11, false], [0x12, false], [0x13, false],
			[0x14, true], [0x18, true], [0x30, true], [0x50, true],
			[0xF0, true], [0xF1, false], [0xF2, false], [0xF3, false], [0xF4, true],
		];

		for (const [dataCoding] of codings) {
			const sent = await peer.session.send({
				cmdName: 'submit_sm',
				params: {
					data_coding: dataCoding,
					destination_addr: to,
					short_message: 'hi',
					source_addr: from,
				},
			});

			assert.equal(sent.err, undefined, dataCoding.toString(16));
		}

		assert.deepEqual(peer.received.map(sms => sms.flash), codings.map(([, flash]) => flash));
		assert.deepEqual(peer.received.map(sms => sms.message), codings.map(() => 'hi'));
	});

	test('keeps the alphabet its class group declares, so a flash UCS2 message still reads as UCS2', async t => {
		const peer = await messagesInto(t);
		const sent = await peer.session.send({
			cmdName: 'submit_sm',
			params: {
				data_coding: 0x18,
				destination_addr: to,
				short_message: 'تست',
				source_addr: from,
			},
		});

		const [sms] = peer.received;

		assert.equal(sent.err, undefined);
		assert.ok(sms);
		assert.equal(sms.message, 'تست');
		assert.equal(sms.flash, true);
	});
});

describe('sendSms() flash', () => {
	test('writes the message class into data_coding beside the alphabet, never over it', async t => {
		const smsc = await dummySmsc(t);
		const session = await bindToSmsc(t, smsc.port, { reconnect: false });
		const sends = [
			{ from, message: 'Hello world', to },
			{ flash: true, from, message: 'Hello world', to },
			{ from, message: 'تست', to },
			{ flash: true, from, message: 'تست', to },
			{ encoding: 'LATIN1', from, message: 'Hello world', to },
		] as const;

		for (const send of sends) {
			assert.equal((await session.sendSms(send)).err, undefined, send.message);
		}

		// 0.4.0 forced 0x10 whatever the alphabet was, which mangled every non-GSM flash message.
		assert.deepEqual(dataCodingsOf(smsc.octets), [0x01, 0x10, 0x08, 0x18, 0x03]);
	});

	test('refuses a flash Latin-1 message, which no coding group carrying a class can spell', async () => {
		const attempts: PduObjectInput[] = [];
		const deps = recordingDeps(attempts);
		const sent = await submitSms(deps, { encoding: 'LATIN1', flash: true, from, message: 'Hello world', to });

		assert.ok(sent.err instanceof Error);
		assert.match(sent.err.message, /flash/);
		assert.match(sent.err.message, /Latin-1/);
		assert.deepEqual(sent.pduObjs, []);
		assert.deepEqual(sent.smsIds, []);
		assert.equal(sent.unanswered, 0);
		assert.equal(attempts.length, 0, 'a refused flash message puts nothing on the wire');

		// Either half alone is fine; it is only the pair that has nowhere to go.
		const latin1 = await submitSms(deps, { encoding: 'LATIN1', from, message: 'Hello world', to });
		const flash = await submitSms(deps, { flash: true, from, message: 'Hello world', to });

		assert.equal(latin1.err?.message, 'the recording peer never answers');
		assert.equal(flash.err?.message, 'the recording peer never answers');
		assert.equal(attempts.length, 2);
	});
});
