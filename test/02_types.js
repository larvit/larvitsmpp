'use strict';

const test = require('tape');
const types = require(__dirname + '/../lib/defs.js').types;

test('2. Types', t => t.end());

test('2.1. int8', t => {
	const expected = 0x65;
	const b = Buffer.from([0, 0x65]);

	t.strictEqual(types.int8.read(b, 1), expected, '#read() Should read one byte as integer.');
	t.strictEqual(types.int8.size(expected), 1, '#size() Should return 1.');

	types.int8.write(expected, b, 0);
	t.strictEqual(
		Buffer.from([0x65]).toString('hex'),
		b.subarray(0, 1).toString('hex'),
		'#write() Should write one byte to the buffer.',
	);

	t.end();
});

test('2.2. int16', t => {
	const expected = 0x0565;
	const b = Buffer.from([0, 0x05, 0x65]);

	t.strictEqual(types.int16.read(b, 1), expected, '#read() Should read 2 bytes as integer.');
	t.strictEqual(types.int16.size(expected), 2, '#size() Should return 2.');

	types.int16.write(expected, b, 0);
	t.strictEqual(
		Buffer.from([0x05, 0x65]).toString('hex'),
		b.subarray(0, 2).toString('hex'),
		'#write() Should write 2 bytes to the buffer.',
	);

	t.end();
});

test('2.3. int32', t => {
	const expected = 0x10024045;
	const b = Buffer.from([0, 0x10, 0x02, 0x40, 0x45]);

	t.strictEqual(types.int32.read(b, 1), expected, '#read() Should read 4 bytes as integer.');
	t.strictEqual(types.int32.size(expected), 4, '#size() Should return 4.');

	types.int32.write(expected, b, 0);
	t.strictEqual(
		Buffer.from([0x10, 0x02, 0x40, 0x45]).toString('hex'),
		b.subarray(0, 4).toString('hex'),
		'#write() Should write 4 bytes to the buffer.',
	);

	t.end();
});

test('2.4. string', t => {
	const expected = 'abcd1234';
	const b = Buffer.alloc(9);

	b[0] = 8;
	b.write(expected, 1);

	t.strictEqual(types.string.read(b, 0), expected, '#read() Should read an Octet String from the buffer.');
	t.strictEqual(types.string.size(expected), 9, '#size() Should return the length of an Octet String from its first byte.');

	const b2 = Buffer.alloc(9);
	types.string.write(expected, b2, 0);
	t.strictEqual(b2.toString('hex'), b.toString('hex'), '#write() Should write an Octet String to the buffer.');

	t.end();
});

test('2.5. cstring', t => {
	const expected = 'abcd1234';
	const b = Buffer.alloc(9);

	b[8] = 0;
	b.write(expected, 0);

	t.strictEqual(
		types.cstring.read(b, 0),
		expected,
		'#read() Should read a C-Octet String (null-terminated string) from the buffer.',
	);

	t.strictEqual(
		types.cstring.size(expected),
		9,
		'#size() Should return the length of a C-Octet String (null-terminated string).',
	);

	const b2 = Buffer.alloc(9);
	types.cstring.write(expected, b2, 0);
	t.strictEqual(
		b.toString('hex'),
		b2.toString('hex'),
		'#write() Should write a C-Octet String (null-terminated string) to the buffer.',
	);

	t.end();
});

test('2.6. buffer', t => {
	const expected = Buffer.from('abcd1234');
	const b = Buffer.alloc(8);

	b.write(expected.toString());

	t.strictEqual(
		types.buffer.read(b, 0, b.length).toString('hex'),
		expected.toString('hex'),
		'#read() Should read a binary field from the buffer.',
	);

	t.strictEqual(types.buffer.size(expected), 8, '#size() Should return the size of a binary field in bytes.');

	const b2 = Buffer.alloc(8);
	types.buffer.write(expected, b2, 0);
	t.strictEqual(b.toString('hex'), b2.toString('hex'), '#write() Should write a binary field to the buffer.');

	t.end();
});

test('2.7. dest_address_array', t => {
	const expected = [];
	const b = Buffer.from([0x02, 0x01, 0x01, 0x02, 0x31, 0x32, 0x33, 0x00, 0x02, 0x61, 0x62, 0x63, 0x00]);

	expected.push({
		'dest_addr_ton':	1,
		'dest_addr_npi':	2,
		'destination_addr':	'123'
	});
	expected.push({'dl_name': 'abc'});

	t.strictEqual(
		JSON.stringify(types.dest_address_array.read(b, 0)),
		JSON.stringify(expected),
		'#read() Should read all dest_address structures from the buffer.',
	);

	t.strictEqual(
		types.dest_address_array.size(expected),
		13,
		'#size() Should return the size of all dest_address structures in bytes.',
	);

	const b2 = Buffer.alloc(13);
	types.dest_address_array.write(expected, b2, 0);
	t.strictEqual(
		b.toString('hex'),
		b2.toString('hex'),
		'#write() Should write an array of dest_address structures to the buffer.',
	);

	t.end();
});

test('2.8. unsuccess_sme_array', t => {
	const expected = [];
	const b = Buffer.from([0x02, 0x03, 0x04, 0x61, 0x62, 0x63, 0x00, 0x00, 0x00, 0x00, 0x07, 0x05, 0x06, 0x31, 0x32, 0x33, 0x00, 0x10, 0x00, 0x00, 0x08]);

	expected.push({
		'dest_addr_ton':	3,
		'dest_addr_npi':	4,
		'destination_addr':	'abc',
		'error_status_code':	0x00000007
	});
	expected.push({
		'dest_addr_ton':	5,
		'dest_addr_npi':	6,
		'destination_addr':	'123',
		'error_status_code':	0x10000008
	});

	t.strictEqual(
		JSON.stringify(types.unsuccess_sme_array.read(b, 0)),
		JSON.stringify(expected),
		'#read() Should read all unsuccess_sme structures from the buffer.',
	);

	t.strictEqual(
		types.unsuccess_sme_array.size(expected),
		21,
		'#size() Should return the size of all unsuccess_sme structures in bytes.',
	);

	const b2 = Buffer.alloc(21);
	types.unsuccess_sme_array.write(expected, b2, 0);
	t.strictEqual(
		b.toString('hex'), b2.toString('hex'),
		'#write() Should write an array of unsuccess_sme structures to the buffer.',
	);

	t.end();
});
