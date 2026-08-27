import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
	bitCount,
	decodeMessage,
	encodeMessage,
	smppDate,
	smppTime,
	splitMessage,
} from '../src/message.ts';

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

	test('prefixes each segment with a concatenation UDH', () => {
		const segments = splitMessage('a'.repeat(306), { reference: 0x2A });

		assert.deepEqual(segments[0]?.subarray(0, 6), Buffer.from([0x05, 0x00, 0x03, 0x2A, 2, 1]));
		assert.deepEqual(segments[1]?.subarray(0, 6), Buffer.from([0x05, 0x00, 0x03, 0x2A, 2, 2]));
	});

	test('produces no segments at all for a message no UDH can number', () => {
		assert.equal(splitMessage('a'.repeat(153 * 255), { reference: 1 }).length, 255);
		assert.equal(splitMessage('a'.repeat(153 * 255 + 1), { reference: 1 }).length, 0);
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
