import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import type { PduObjectInput } from '../src/pdu.ts';
import type { SendSmsDeps, SendSmsInput } from '../src/send-sms.ts';
import { bindToSmsc, dummySmsc } from './dummy-smsc.ts';
import { decodeMessage } from '../src/message.ts';
import { messageOctets } from '../src/message-body.ts';
import { objToPdu, pduToObj } from '../src/pdu.ts';
import { paramNumber, paramText } from '../src/defs/types.ts';
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

describe('a body the PDU\'s own data_coding cannot carry', () => {
	/** The octets a built PDU carries as its body, wherever the caller put them. */
	function bodyOf(built: ReturnType<typeof objToPdu>): Buffer | undefined {
		assert.equal(built.err, undefined);
		assert.ok(built.buffer);

		const { pduObj } = pduToObj(built.buffer);

		assert.ok(pduObj);

		return messageOctets(pduObj);
	}

	// Latin-1 takes the low octet of every code point, so あ (U+3042) went out as 0x42 — the letter B.
	test('refuses a string short_message the named alphabet cannot carry, naming the character', () => {
		const built = objToPdu({
			cmdName: 'submit_sm',
			params: { data_coding: 0x03, destination_addr: to, short_message: 'あいう', source_addr: from },
		});

		assert.ok(built.err instanceof Error);
		assert.equal(built.buffer, undefined);
		assert.match(built.err.message, /short_message/);
		assert.match(built.err.message, /LATIN1/);
		assert.match(built.err.message, /"あ"/);
		assert.match(built.err.message, /U\+3042/);
		assert.match(built.err.message, /index 0/);
	});

	// Å is in the GSM table at 0x0E; ï is the one the encoder flattened to a space.
	test('refuses a string short_message GSM 03.38 has no code for, naming that one', () => {
		for (const dataCoding of [0x00, 0x01]) {
			const built = objToPdu({
				cmdName: 'submit_sm',
				params: { data_coding: dataCoding, destination_addr: to, short_message: 'Åsa naïve', source_addr: from },
			});

			assert.ok(built.err instanceof Error, String(dataCoding));
			assert.match(built.err.message, /ASCII/);
			assert.match(built.err.message, /"ï"/);
			assert.match(built.err.message, /U\+00EF/);
			assert.match(built.err.message, /index 6/);
		}
	});

	test('refuses a string message_payload on the same terms as short_message', () => {
		const built = objToPdu({
			cmdName: 'data_sm',
			params: { data_coding: 0x03, destination_addr: to, source_addr: from },
			tlvs: { message_payload: { tagValue: 'あいう' } },
		});

		assert.ok(built.err instanceof Error);
		assert.equal(built.buffer, undefined);
		assert.match(built.err.message, /message_payload/);
		assert.match(built.err.message, /LATIN1/);
		assert.match(built.err.message, /"あ"/);
		assert.match(built.err.message, /U\+3042/);
	});

	test('refuses the body TLV under whatever name the caller keyed its tagId to', () => {
		const built = objToPdu({
			cmdName: 'data_sm',
			params: { data_coding: 0x03, destination_addr: to, source_addr: from },
			tlvs: { body: { tagId: 0x0424, tagValue: 'あいう' } },
		});

		assert.ok(built.err instanceof Error);
		assert.equal(built.buffer, undefined);
		assert.match(built.err.message, /"body"/);
		assert.match(built.err.message, /LATIN1/);
		assert.match(built.err.message, /U\+3042/);
	});

	test('leaves data_coding to short_message wherever it carries octets, as messageOctets() reads it', () => {
		const short = Buffer.from([0xDE, 0xAD]);
		const built = objToPdu({
			cmdName: 'deliver_sm',
			params: { destination_addr: to, short_message: short, source_addr: from },
			tlvs: { message_payload: { tagValue: 'あいう' } },
		});

		assert.equal(built.err, undefined);
		assert.ok(built.buffer);

		const { pduObj } = pduToObj(built.buffer);

		assert.ok(pduObj);
		assert.equal(pduObj.params.data_coding, 0, 'the TLV must not name an alphabet for octets nothing reads it as');
		assert.deepEqual(messageOctets(pduObj), short);
	});

	test('never refuses a Buffer body, whatever the coding, because that is how binary is sent', () => {
		const payload = Buffer.from([0x30, 0x42, 0xC3, 0x28, 0xFF, 0x00]);

		for (const dataCoding of [0x00, 0x01, 0x03, 0x04, 0x08, 0xF0]) {
			const params = { data_coding: dataCoding, destination_addr: to, source_addr: from };
			const short = objToPdu({ cmdName: 'submit_sm', params: { ...params, short_message: payload } });
			const carried = objToPdu({
				cmdName: 'data_sm',
				params,
				tlvs: { message_payload: { tagValue: payload } },
			});

			assert.deepEqual(bodyOf(short), payload, `short_message under data_coding ${String(dataCoding)}`);
			assert.deepEqual(bodyOf(carried), payload, `message_payload under data_coding ${String(dataCoding)}`);
		}
	});

	test('never refuses a string the caller named no data_coding for, since detection always fits', () => {
		for (const message of ['Hello world', 'Åsa naïve', 'あいう', '😀 beyond the basic plane']) {
			const built = objToPdu({
				cmdName: 'submit_sm',
				params: { destination_addr: to, short_message: message, source_addr: from },
			});

			assert.equal(built.err, undefined, message);
		}
	});

	test('writes a body the coding does carry as the octets that alphabet spells it in', () => {
		const bodies: [number, string, string][] = [
			[0x00, 'Hello world', '48656c6c6f20776f726c64'],
			[0x03, 'Räksmörgås', '52e46b736df67267e573'],
			[0x08, 'あいう', '304230443046'],
		];

		for (const [dataCoding, message, hex] of bodies) {
			const params = { data_coding: dataCoding, destination_addr: to, source_addr: from };
			const short = objToPdu({ cmdName: 'submit_sm', params: { ...params, short_message: message } });
			const carried = objToPdu({
				cmdName: 'data_sm',
				params,
				tlvs: { message_payload: { tagValue: message } },
			});

			assert.equal(bodyOf(short)?.toString('hex'), hex, `short_message: ${message}`);
			assert.equal(bodyOf(carried)?.toString('hex'), hex, `message_payload: ${message}`);
		}
	});

	test('refuses the same body through session.send(), with nothing reaching the socket', async t => {
		const smsc = await dummySmsc(t, { messageIds: ['01a086fc-1ae8-7910-ac2c-34c2bd8bea19'] });
		const session = await bindToSmsc(t, smsc.port, { reconnect: false });
		const sent = await session.send({
			cmdName: 'submit_sm',
			params: { data_coding: 0x03, destination_addr: to, short_message: 'あいう', source_addr: from },
		});

		assert.ok(sent.err instanceof Error);
		assert.match(sent.err.message, /LATIN1/);
		assert.deepEqual(smsc.octets, [], 'a body the named alphabet cannot carry never reaches the socket');
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
