import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import type { PduObjectInput } from '../src/pdu.ts';
import type { SendSmsDeps, SendSmsInput } from '../src/send-sms.ts';
import { bindToSmsc, dummySmsc } from './dummy-smsc.ts';
import { decodeMessage } from '../src/message.ts';
import { paramNumber, paramText } from '../src/defs/types.ts';
import { pduToObj } from '../src/pdu.ts';
import { silentLog } from '../src/log.ts';
import { submitSms } from '../src/send-sms.ts';

const from = '46701113311';
const to = '46709771337';

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

/** The alphabet each submit_sm declared, beside the text those octets read back as. */
function sentAs(octets: Buffer[]): [number, string][] {
	return octets.map(pdu => {
		const { pduObj } = pduToObj(pdu);

		assert.ok(pduObj);

		const dataCoding = paramNumber(pduObj.params.data_coding, 0);

		return [dataCoding, decodeMessage(pduObj.shortMessageOctets ?? Buffer.alloc(0), dataCoding).message];
	});
}

describe('an alphabet the caller named that cannot carry the message', () => {
	// Latin-1 takes the low octet of every code point, so あ (U+3042) went out as 0x42 — the letter B.
	test('refuses a Latin-1 send of a character above 0xFF, naming the character', async () => {
		const attempts: PduObjectInput[] = [];
		const sent = await submitSms(recordingDeps(attempts), { encoding: 'LATIN1', from, message: 'あいう', to });

		assert.ok(sent.err instanceof Error);
		assert.match(sent.err.message, /LATIN1/);
		assert.match(sent.err.message, /"あ"/);
		assert.match(sent.err.message, /U\+3042/);
		assert.deepEqual(sent.pduObjs, []);
		assert.deepEqual(sent.smsIds, []);
		assert.equal(sent.unanswered, 0);
		assert.equal(attempts.length, 0, 'a message the named alphabet cannot carry puts nothing on the wire');
	});

	// Å is in the GSM table at 0x0E; ï is the one the encoder flattened to a space.
	test('refuses an ASCII send of a character GSM 03.38 has no code for, naming that one', async () => {
		const attempts: PduObjectInput[] = [];
		const sent = await submitSms(recordingDeps(attempts), { encoding: 'ASCII', from, message: 'Åsa naïve', to });

		assert.ok(sent.err instanceof Error);
		assert.match(sent.err.message, /ASCII/);
		assert.match(sent.err.message, /"ï"/);
		assert.match(sent.err.message, /U\+00EF/);
		assert.match(sent.err.message, /index 6/);
		assert.equal(attempts.length, 0);
	});

	test('never refuses UCS2, which carries every character there is', async () => {
		const attempts: PduObjectInput[] = [];
		const deps = recordingDeps(attempts);

		for (const message of ['あいう', 'Åsa naïve', '😀 beyond the basic plane', '�']) {
			const sent = await submitSms(deps, { encoding: 'UCS2', from, message, to });

			assert.equal(sent.err?.message, 'the recording peer never answers', message);
		}

		assert.equal(attempts.length, 4);
	});

	test('sends 8-bit binary named as Latin-1 unchanged, the case that codec is named for', async t => {
		const messageId = '01a086cc-5ee9-759d-ba4c-96a9afd9aed9';
		const smsc = await dummySmsc(t, { messageIds: [messageId] });
		const session = await bindToSmsc(t, smsc.port, { reconnect: false });
		const payload = Buffer.from(Array.from({ length: 140 }, (_, at) => (at * 7 + 3) % 256));
		const sent = await session.sendSms({ encoding: 'LATIN1', from, message: payload.toString('latin1'), to });
		const first = smsc.octets[0];

		assert.equal(sent.err, undefined);
		assert.deepEqual(sent.smsIds, [messageId]);
		assert.equal(smsc.octets.length, 1);
		assert.ok(first);

		const { pduObj } = pduToObj(first);

		assert.ok(pduObj);
		assert.equal(paramNumber(pduObj.params.data_coding, 0), 0x03);
		assert.deepEqual(pduObj.shortMessageOctets, payload);
	});

	test('picks an alphabet that fits where the caller named none, so nothing is ever refused for one', async t => {
		const smsc = await dummySmsc(t);
		const session = await bindToSmsc(t, smsc.port, { reconnect: false });

		for (const message of ['Hello world', 'Åsa naïve', 'あいう']) {
			assert.equal((await session.sendSms({ from, message, to })).err, undefined, message);
		}

		assert.deepEqual(sentAs(smsc.octets), [[0x01, 'Hello world'], [0x08, 'Åsa naïve'], [0x08, 'あいう']]);
	});
});

describe('a time no peer can read', () => {
	const invalid = new Date('nope');

	test('refuses an invalid Date rather than writing NaN into the PDU, naming the option', async () => {
		const attempts: PduObjectInput[] = [];
		const deps = recordingDeps(attempts);
		const sends: [string, SendSmsInput][] = [
			['scheduleDeliveryTime', { from, message: 'Hello world', scheduleDeliveryTime: invalid, to }],
			['validityPeriod', { from, message: 'Hello world', to, validityPeriod: invalid }],
		];

		for (const [option, send] of sends) {
			const sent = await submitSms(deps, send);

			assert.ok(sent.err instanceof Error, option);
			assert.match(sent.err.message, new RegExp(option));
			assert.match(sent.err.message, /invalid Date/);
			assert.deepEqual(sent.smsIds, []);
		}

		assert.equal(attempts.length, 0, 'a time nobody can read puts nothing on the wire');
	});

	test('refuses a relative period naming no number of seconds', async () => {
		const attempts: PduObjectInput[] = [];
		const deps = recordingDeps(attempts);

		for (const validityPeriod of [NaN, Infinity, -Infinity]) {
			const sent = await submitSms(deps, { from, message: 'Hello world', to, validityPeriod });

			assert.ok(sent.err instanceof Error, String(validityPeriod));
			assert.match(sent.err.message, /validityPeriod/);
		}

		assert.equal(attempts.length, 0);
	});

	test('refuses a time that is no kind of time rather than throwing out of the send', async () => {
		const attempts: PduObjectInput[] = [];
		const deps = recordingDeps(attempts);

		for (const validityPeriod of [null, {}, true, []]) {
			const sent = await submitSms(deps, { from, message: 'Hello world', to, validityPeriod });

			assert.ok(sent.err instanceof Error, JSON.stringify(validityPeriod));
			assert.match(sent.err.message, /validityPeriod must be a Date/);
		}

		assert.equal(attempts.length, 0);
	});

	test('writes the times it can express into every segment it built them for', async t => {
		const smsc = await dummySmsc(t);
		const session = await bindToSmsc(t, smsc.port, { reconnect: false });
		const sent = await session.sendSms({
			from,
			message: 'A message long enough to need a header numbering its segments. '.repeat(4),
			scheduleDeliveryTime: new Date(Date.UTC(2026, 8, 9, 14, 30, 0)),
			to,
			validityPeriod: 3600,
		});

		assert.equal(sent.err, undefined);
		assert.equal(smsc.octets.length, 2, 'the fixture must need more than one segment');

		for (const octets of smsc.octets) {
			const { pduObj } = pduToObj(octets);

			assert.ok(pduObj);
			assert.equal(paramText(pduObj.params.schedule_delivery_time), '260909143000000+');
			assert.equal(paramText(pduObj.params.validity_period), '000000010000000R');
		}
	});
});
