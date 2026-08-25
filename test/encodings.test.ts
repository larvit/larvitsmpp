import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { detect, encodingByDataCoding, encodings } from '../src/defs/encodings.ts';

describe('ASCII (GSM 03.38)', () => {
	const samples: [string, number[]][] = [
		['@£$¥', [0, 1, 2, 3]],
		[' 1a=', [0x20, 0x31, 0x61, 0x3D]],
		['~^€', [0x1B, 0x3D, 0x1B, 0x14, 0x1B, 0x65]],
	];

	test('matches strings encodable in the GSM 03.38 charset', () => {
		assert.ok(encodings.ASCII.match(''));
		assert.ok(encodings.ASCII.match('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1BÆæßÉ !"#¤%&\''));
		assert.ok(encodings.ASCII.match('()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZ'));
		assert.ok(encodings.ASCII.match('ÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'));
		assert.ok(encodings.ASCII.match('\f^{}\\[~]|€'));
	});

	test('rejects strings outside the GSM 03.38 charset', () => {
		assert.ok(!encodings.ASCII.match('`'));
		assert.ok(!encodings.ASCII.match('ÁáçÚUÓO'));
		assert.ok(!encodings.ASCII.match('تست'));
	});

	test('round-trips the sample strings', () => {
		for (const [str, bytes] of samples) {
			assert.deepEqual(encodings.ASCII.encode(str), Buffer.from(bytes));
			assert.equal(encodings.ASCII.decode(Buffer.from(bytes)), str);
		}
	});
});

describe('LATIN1', () => {
	const samples: [string, number[]][] = [
		['@$`Á', [0x40, 0x24, 0x60, 0xC1]],
		['áçÚ', [0xE1, 0xE7, 0xDA]],
		['UÓO', [0x55, 0xD3, 0x4F]],
	];

	test('never matches, so it is never auto-selected for new messages', () => {
		assert.ok(!encodings.LATIN1.match('`ÁáçÚUÓO'));
		assert.ok(!encodings.LATIN1.match('تست'));
		assert.ok(!encodings.LATIN1.match('۱۲۳۴۵۶۷۸۹۰'));
	});

	test('round-trips the sample strings', () => {
		for (const [str, bytes] of samples) {
			assert.deepEqual(encodings.LATIN1.encode(str), Buffer.from(bytes));
			assert.equal(encodings.LATIN1.decode(Buffer.from(bytes)), str);
		}
	});
});

describe('UCS2', () => {
	const samples: [string, number[]][] = [
		[' 1a', [0x00, 0x20, 0x00, 0x31, 0x00, 0x61]],
		['۱۲۳', [0x06, 0xF1, 0x06, 0xF2, 0x06, 0xF3]],
	];

	test('always matches', () => {
		assert.ok(encodings.UCS2.match(''));
		assert.ok(encodings.UCS2.match('`ÁáçÚUÓO'));
		assert.ok(encodings.UCS2.match('تست'));
	});

	test('round-trips the sample strings', () => {
		for (const [str, bytes] of samples) {
			assert.deepEqual(encodings.UCS2.encode(str), Buffer.from(bytes));
			assert.equal(encodings.UCS2.decode(Buffer.from(bytes)), str);
		}
	});

	test('decoding does not mutate the caller\'s buffer', () => {
		const buffer = Buffer.from([0x00, 0x20]);

		encodings.UCS2.decode(buffer);

		assert.deepEqual(buffer, Buffer.from([0x00, 0x20]));
	});
});

describe('detect()', () => {
	test('picks the narrowest encoding that fits the string', () => {
		assert.equal(detect(''), 'ASCII');
		assert.equal(detect('ÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà(){}[]'), 'ASCII');
		assert.equal(detect('`ÁáçÚUÓO'), 'UCS2');
		assert.equal(detect('«©®µ¶±»'), 'UCS2');
		assert.equal(detect('ʹʺʻʼʽ`'), 'UCS2');
		assert.equal(detect('تست'), 'UCS2');
		assert.equal(detect('۱۲۳۴۵۶۷۸۹۰'), 'UCS2');
	});
});

describe('encodingByDataCoding()', () => {
	test('resolves the flat SMPP data_coding table', () => {
		assert.equal(encodingByDataCoding(0x00), 'ASCII');
		assert.equal(encodingByDataCoding(0x01), 'ASCII');
		assert.equal(encodingByDataCoding(0x08), 'UCS2');
	});

	// 0.4.0 resolved 0x03 to the alias ISO_8859_1, which has no decoder, and silently fell back to
	// ASCII — every Latin-1 message came out corrupted.
	test('resolves 0x03 to LATIN1 rather than falling back to ASCII', () => {
		assert.equal(encodingByDataCoding(0x03), 'LATIN1');
	});

	test('reads the alphabet bits when a message class is present', () => {
		assert.equal(encodingByDataCoding(0x10), 'ASCII');
		assert.equal(encodingByDataCoding(0x18), 'UCS2');
		assert.equal(encodingByDataCoding(0xF0), 'ASCII');
	});

	test('falls back to ASCII for alphabets it has no codec for', () => {
		assert.equal(encodingByDataCoding(0x05), 'ASCII');
		assert.equal(encodingByDataCoding(0x0E), 'ASCII');
	});
});
