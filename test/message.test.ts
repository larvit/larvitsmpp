import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import type { EncodingName } from '../src/defs/encodings.ts';
import {
	bitCount,
	decodeMessage,
	encodeMessage,
	smppDate,
	smppTime,
	splitMessage,
} from '../src/message.ts';
// Through the public surface: an application handed a PduObject needs this same answer.
import { encodings, isEncodingName, messageOctets, objToPdu, pduToObj } from '../src/index.ts';

/** An SMS carries 140 octets on the air, whatever the alphabet. */
const singleSmsOctets = 140;

describe('bitCount()', () => {
	test('counts GSM characters as seven bits each', () => {
		assert.equal(bitCount('hello'), 35);
		assert.equal(bitCount(''), 0);
		assert.equal(bitCount('a'.repeat(160)), 1120);
	});

	test('counts UCS2 characters as sixteen bits each', () => {
		assert.equal(bitCount('تست'), 48);
		assert.equal(bitCount('a'.repeat(70), 'UCS2'), 1120);
	});

	test('counts an escaped GSM character as two', () => {
		assert.equal(bitCount('€'), 14);
	});
});

describe('splitMessage()', () => {
	test('returns a single unwrapped segment when the message fits', () => {
		const segments = splitMessage('Hello world', { reference: 1 });

		assert.equal(segments.length, 1);
		assert.deepEqual(segments[0], encodeMessage('Hello world').buffer);
	});

	test('fits exactly 160 GSM characters into one segment', () => {
		assert.equal(splitMessage('a'.repeat(160), { reference: 1 }).length, 1);
		assert.equal(splitMessage('a'.repeat(161), { reference: 1 }).length, 2);
	});

	test('fits exactly 70 UCS2 characters into one segment', () => {
		assert.equal(splitMessage('ت'.repeat(70), { reference: 1 }).length, 1);
		assert.equal(splitMessage('ت'.repeat(71), { reference: 1 }).length, 2);
	});

	// 0.4.0 pushed msgPart.slice(0, -1), so every segment was one character short and long
	// messages were split into more segments — and therefore more billed messages — than needed.
	test('carries 153 GSM characters per segment', () => {
		const segments = splitMessage('a'.repeat(306), { reference: 7 });

		assert.equal(segments.length, 2);

		for (const segment of segments) {
			assert.equal(segment.length, 6 + 153);
		}
	});

	test('carries 67 UCS2 characters per segment', () => {
		const segments = splitMessage('ت'.repeat(134), { reference: 7 });

		assert.equal(segments.length, 2);

		for (const segment of segments) {
			assert.equal(segment.length, 6 + 134);
		}
	});

	// 153 is the septet count the SMSC packs into 134 octets. Latin-1 is never packed, so budgeting
	// 153 characters for it put 159 octets on the air against the 140 an SMS carries.
	test('fits a concatenated Latin-1 segment into the 140 octets an SMS carries', () => {
		const message = 'å'.repeat(300);
		const segments = splitMessage(message, { encoding: 'LATIN1', reference: 0x4B });

		assert.equal(segments.length, 3);

		for (const segment of segments) {
			assert.ok(segment.length <= singleSmsOctets, `segment of ${String(segment.length)} octets`);
		}

		assert.equal(segments[0]?.length, 6 + 134);
		assert.equal(segments.map(segment => segment.subarray(6).toString('latin1')).join(''), message);
	});

	test('fits a concatenated 8-bit binary segment into the same 140 octets', () => {
		const payload = Buffer.from(Array.from({ length: 400 }, (_, at) => (at * 7 + 3) % 256));
		const segments = splitMessage(payload.toString('latin1'), { encoding: 'LATIN1', reference: 0x4C });

		assert.equal(segments.length, 3);

		for (const segment of segments) {
			assert.ok(segment.length <= singleSmsOctets, `segment of ${String(segment.length)} octets`);
		}

		assert.deepEqual(Buffer.concat(segments.map(segment => segment.subarray(6))), payload);
	});

	test('prefixes each segment with a concatenation UDH', () => {
		const segments = splitMessage('a'.repeat(306), { reference: 0x2A });

		assert.deepEqual(segments[0]?.subarray(0, 6), Buffer.from([0x05, 0x00, 0x03, 0x2A, 2, 1]));
		assert.deepEqual(segments[1]?.subarray(0, 6), Buffer.from([0x05, 0x00, 0x03, 0x2A, 2, 2]));
	});

	test('produces no segments at all for a message no UDH can number', () => {
		assert.equal(splitMessage('a'.repeat(153 * 255), { reference: 1 }).length, 255);
		assert.equal(splitMessage('a'.repeat(153 * 255 + 1), { reference: 1 }).length, 0);
		assert.equal(splitMessage('å'.repeat(134 * 255), { encoding: 'LATIN1', reference: 1 }).length, 255);
		assert.equal(splitMessage('å'.repeat(134 * 255 + 1), { encoding: 'LATIN1', reference: 1 }).length, 0);
	});

	test('splits on characters, never inside an escape sequence', () => {
		const segments = splitMessage('€'.repeat(100), { reference: 1 });
		const rejoined = segments
			.map(segment => decodeMessage(segment.subarray(6), 0x00).message)
			.join('');

		assert.equal(rejoined, '€'.repeat(100));
	});
});

describe('encodeMessage() and decodeMessage()', () => {
	test('picks GSM for GSM-safe text and UCS2 otherwise', () => {
		assert.equal(encodeMessage('Hello').encoding, 'ASCII');
		assert.equal(encodeMessage('تست').encoding, 'UCS2');
	});

	test('honours a forced encoding', () => {
		assert.equal(encodeMessage('Hello', 'UCS2').encoding, 'UCS2');
	});

	// 0.4.0 resolved data_coding 0x03 to the alias ISO_8859_1, which has no decoder, so every
	// Latin-1 message was silently decoded as ASCII.
	test('decodes Latin-1 rather than falling back to ASCII', () => {
		assert.equal(decodeMessage(Buffer.from([0xE1, 0xE7, 0xDA]), 0x03).message, 'áçÚ');
	});

	test('round-trips a UCS2 message ending in a zero low byte', () => {
		const { buffer } = encodeMessage('hej 一');

		assert.equal(decodeMessage(buffer, 0x08).message, 'hej 一');
	});

	test('keeps a binary payload octet for octet instead of running it through GSM 03.38', () => {
		const payload = Buffer.from([0x00, 0x1B, 0x60, 0x80, 0xFF]);

		assert.deepEqual(Buffer.from(decodeMessage(payload, 0x04).message, 'latin1'), payload);
	});

	test('decodes the whole characters of a UCS2 payload cut in half by sm_length', () => {
		assert.equal(decodeMessage(Buffer.from([0x00, 0x68, 0x00, 0x65, 0x00]), 0x08).message, 'he');
	});

	test('strips a UDH when the esm_class says one is present', () => {
		const withUdh = Buffer.concat([
			Buffer.from([0x05, 0x00, 0x03, 0x01, 0x02, 0x01]),
			encodeMessage('part one').buffer,
		]);

		assert.equal(decodeMessage(withUdh, 0x00, 0x40).message, 'part one');
	});
});

describe('the alphabet the encoding helpers are asked for', () => {
	const everyName: EncodingName[] = ['ASCII', 'LATIN1', 'UCS2'];

	test('is one of three, each with a codec, so none of the three helpers can reach an absent one', () => {
		assert.deepEqual(Object.keys(encodings).sort(), [...everyName].sort());

		for (const encoding of everyName) {
			assert.equal(encodeMessage('Hello', encoding).encoding, encoding);
			assert.ok(bitCount('Hello', encoding) > 0);
			assert.equal(splitMessage('Hello', { encoding, reference: 1 }).length, 1);
		}
	});

	test('is narrowed by isEncodingName(), the door a caller holding a name at runtime takes', () => {
		for (const encoding of everyName) {
			assert.equal(isEncodingName(encoding), true, encoding);
		}

		for (const value of ['FLASH', 'BINARY', 'utf8', 'ascii', 'toString', '', 8, {}, null, undefined]) {
			assert.equal(isEncodingName(value), false, JSON.stringify(value));
		}
	});
});

describe('messageOctets()', () => {
	/** A data_sm has no short_message field at all, which is the case that has neither. */
	function parsed(short: Buffer | undefined, payload?: Buffer) {
		const { buffer } = short === undefined
			? objToPdu({
				cmdName: 'data_sm',
				params: { destination_addr: '46709771337', source_addr: '46701113311' },
			})
			: objToPdu({
				cmdName: 'deliver_sm',
				params: { destination_addr: '46709771337', short_message: short, source_addr: '46701113311' },
				...(payload ? { tlvs: { message_payload: { tagValue: payload } } } : {}),
			});

		assert.ok(buffer);

		const { pduObj } = pduToObj(buffer);

		assert.ok(pduObj);

		return pduObj;
	}

	test('reads the TLV only where short_message carries nothing', () => {
		const short = Buffer.from('in the field');
		const payload = Buffer.from('in the TLV');

		assert.deepEqual(messageOctets(parsed(Buffer.alloc(0), payload)), payload);
		assert.deepEqual(messageOctets(parsed(short, payload)), short);
		assert.deepEqual(messageOctets(parsed(short)), short);
		assert.deepEqual(messageOctets(parsed(Buffer.alloc(0))), Buffer.alloc(0));
		assert.equal(messageOctets(parsed(undefined)), undefined, 'a PDU with neither carries no body');
	});
});

describe('smppDate()', () => {
	// 0.4.0 used getMonth() without adding one, so January rendered as 00 and every delivery
	// receipt carried a date a month in the past.
	test('renders the month one-based', () => {
		assert.equal(smppDate(new Date(Date.UTC(2026, 0, 9, 5, 4))), '2601090504');
		assert.equal(smppDate(new Date(Date.UTC(2026, 11, 31, 23, 59))), '2612312359');
	});
});

describe('smppTime', () => {
	test('encodes an absolute time', () => {
		assert.equal(smppTime.encode(new Date(Date.UTC(2026, 7, 25, 14, 30, 0))), '260825143000000+');
	});

	test('encodes a relative time given in seconds', () => {
		assert.equal(smppTime.encode(3600), '000000010000000R');
	});

	test('passes an already-formatted string through', () => {
		assert.equal(smppTime.encode('260825143000000+'), '260825143000000+');
	});

	test('decodes an absolute time back to the same instant', () => {
		const when = new Date(Date.UTC(2026, 7, 25, 14, 30, 0));
		const { err, date } = smppTime.decode(smppTime.encode(when));

		assert.equal(err, undefined);
		assert.equal(date.toISOString(), when.toISOString());
	});

	test('reports malformed input rather than returning an invalid date', () => {
		assert.ok(smppTime.decode('nonsense').err instanceof Error);
		assert.ok(smppTime.decode('').err instanceof Error);
	});
});
