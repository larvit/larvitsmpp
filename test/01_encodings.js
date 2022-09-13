'use strict';

const encodings = require(__dirname + '/../lib/defs.js').encodings;
const test = require('tape');

test('1. Encodings', t => t.end());

test('1.1. ASCII', t => {
	const { ASCII } = encodings;
	const samples = {
		'@£$¥': [0, 1, 2, 3],
		' 1a=': [0x20, 0x31, 0x61, 0x3D],
		'~^€': [0x1B, 0x3D, 0x1B, 0x14, 0x1B, 0x65],
	};

	t.comment('1.1.1. #match()');

	t.comment('1.1.1.1. Should return true for strings that can be encoded using GSM 03.38 ASCII charset');
	t.true(ASCII.match(''), '""');
	t.true(ASCII.match('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1BÆæßÉ !"#¤%&\''), '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1BÆæßÉ !"#¤%&\'');
	t.true(ASCII.match('()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZ'), '()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZ');
	t.true(ASCII.match('ÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'), 'ÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà');
	t.true(ASCII.match('\f^{}\\[~]|€'), '\f^{}\\[~]|€');


	t.comment('1.1.1.2. Should return false for strings that can not be encoded using GSM 03.38 ASCII charset');
	t.false(ASCII.match('`'), '`');
	t.false(ASCII.match('ÁáçÚUÓO'), 'ÁáçÚUÓO');
	t.false(ASCII.match('تست'), 'تست');

	t.comment('1.1.2. #encode() Should properly encode the given string using GSM 03.38 ASCII charset');
	for (const str in samples) {
		t.strictEqual(ASCII.encode(str).toString("hex"), Buffer.from(samples[str]).toString("hex"), str);
	}

	t.comment('1.1.3. #decode() Should properly decode the given buffer using GSM 03.38 ASCII charset');
	for (const str in samples) {
		t.strictEqual(ASCII.decode(samples[str]), str, str);
	}

	t.end();
});

test('1.2. LATIN1', t => {
	const { LATIN1 } = encodings;
	const samples = {
		'@$`Á': [0x40, 0x24, 0x60, 0xC1],
		'áçÚ': [0xE1, 0xE7, 0xDA],
		'UÓO': [0x55, 0xD3, 0x4F],
	}

	t.comment('1.2.1. #match()');

	t.comment('1.2.1.1. Should return false for strings that can be encoded using LATIN1 charset');
	t.false(LATIN1.match('`ÁáçÚUÓO'), '`ÁáçÚUÓO');

	t.comment('1.2.1.2. Should return false for strings that can not be encoded using LATIN1 charset');
	t.false(LATIN1.match('تست'), 'تست');
	t.false(LATIN1.match('۱۲۳۴۵۶۷۸۹۰'), '۱۲۳۴۵۶۷۸۹۰');
	t.false(LATIN1.match('ʹʺʻʼʽ`'), 'ʹʺʻʼʽ`');

	t.comment('1.2.2. #encode() Should properly encode the given string using LATIN1 charset');
	for (const str in samples) {
		t.strictEqual(LATIN1.encode(str).toString('hex'), Buffer.from(samples[str]).toString('hex'), str);
	}

	t.comment('1.2.3. #decode() Should properly decode the given buffer using LATIN1 charset');
	for (const str in samples) {
		t.strictEqual(LATIN1.decode(Buffer.from(samples[str])), str, str);
	}

	t.end();
});

test('1.3. UCS2', t => {
	const { UCS2 } = encodings;
	const samples = {
 		' 1a': [0x00, 0x20, 0x00, 0x31, 0x00, 0x61],
 		'۱۲۳': [0x06, 0xF1, 0x06, 0xF2, 0x06, 0xF3],
	};

	t.comment('1.3.1. #match() Should always return true');
	t.true(UCS2.match(''), '""');
	t.true(UCS2.match('`ÁáçÚUÓO'), '`ÁáçÚUÓO');
	t.true(UCS2.match('تست'), 'تست');
	t.true(UCS2.match('۱۲۳۴۵۶۷۸۹۰'), '۱۲۳۴۵۶۷۸۹۰');
	t.true(UCS2.match('ʹʺʻʼʽ`'), 'ʹʺʻʼʽ`');

	t.comment('1.3.2. #encode() Should properly encode the given string using UCS2 charset');
	for (const str in samples) {
		t.strictEqual(UCS2.encode(str).toString('hex'), Buffer.from(samples[str]).toString('hex'), str);
	}

	t.comment('1.3.3. #decode() Should properly decode the given buffer using UCS2 charset');
	for (const str in samples) {
		t.strictEqual(UCS2.decode(samples[str]), str, str);
	}
	t.end();
});

test('1.4. #detect() Should return proper encoding for the given string', t => {
	t.strictEqual(encodings.detect(''), 'ASCII', '"" -> ASCII');
	t.strictEqual(encodings.detect('ÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà(){}[]'), 'ASCII', 'ÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà(){}[] -> ASCII');
	t.strictEqual(encodings.detect('`ÁáçÚUÓO'), 'UCS2', '`ÁáçÚUÓO -> UCS2');
	t.strictEqual(encodings.detect('«©®µ¶±»'), 'UCS2', '«©®µ¶±» -> UCS2');
	t.strictEqual(encodings.detect('ʹʺʻʼʽ`'), 'UCS2', 'ʹʺʻʼʽ` -> UCS2');
	t.strictEqual(encodings.detect('تست'), 'UCS2', 'تست -> UCS2');
	t.strictEqual(encodings.detect('۱۲۳۴۵۶۷۸۹۰'), 'UCS2', '۱۲۳۴۵۶۷۸۹۰ -> UCS2');

	t.end();
});
