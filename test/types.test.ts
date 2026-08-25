import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import type { DestAddress, UnsuccessSme } from '../src/defs/types.ts';
import { types } from '../src/defs/types.ts';

describe('integers', () => {
	test('int8 reads, sizes and writes one octet', () => {
		const source = Buffer.from([0, 0x65]);
		const target = Buffer.alloc(1);

		assert.deepEqual(types.int8.read(source, 1), { value: 0x65 });
		assert.equal(types.int8.size(0x65), 1);
		assert.deepEqual(types.int8.write(0x65, target, 0), {});
		assert.deepEqual(target, Buffer.from([0x65]));
	});

	test('int16 reads, sizes and writes two octets big-endian', () => {
		const source = Buffer.from([0, 0x05, 0x65]);
		const target = Buffer.alloc(2);

		assert.deepEqual(types.int16.read(source, 1), { value: 0x0565 });
		assert.equal(types.int16.size(0x0565), 2);
		types.int16.write(0x0565, target, 0);
		assert.deepEqual(target, Buffer.from([0x05, 0x65]));
	});

	test('int32 reads, sizes and writes four octets big-endian', () => {
		const source = Buffer.from([0, 0x10, 0x02, 0x40, 0x45]);
		const target = Buffer.alloc(4);

		assert.deepEqual(types.int32.read(source, 1), { value: 0x10024045 });
		assert.equal(types.int32.size(0x10024045), 4);
		types.int32.write(0x10024045, target, 0);
		assert.deepEqual(target, Buffer.from([0x10, 0x02, 0x40, 0x45]));
	});
});

describe('string (Octet String)', () => {
	const expected = 'abcd1234';
	const encoded = Buffer.concat([Buffer.from([8]), Buffer.from(expected)]);

	test('reads a length-prefixed string', () => {
		assert.deepEqual(types.string.read(encoded, 0), { value: expected });
	});

	test('sizes as the string plus its length octet', () => {
		assert.equal(types.string.size(expected), 9);
	});

	test('writes a length-prefixed string', () => {
		const target = Buffer.alloc(9);

		types.string.write(expected, target, 0);

		assert.deepEqual(target, encoded);
	});
});

describe('cstring (C-Octet String)', () => {
	const expected = 'abcd1234';
	const encoded = Buffer.concat([Buffer.from(expected), Buffer.from([0])]);

	test('reads a NULL-terminated string', () => {
		assert.deepEqual(types.cstring.read(encoded, 0), { value: expected });
	});

	test('sizes as the string plus its NULL terminator', () => {
		assert.equal(types.cstring.size(expected), 9);
	});

	test('writes a NULL-terminated string', () => {
		const target = Buffer.alloc(9);

		types.cstring.write(expected, target, 0);

		assert.deepEqual(target, encoded);
	});

	test('coerces a numeric value to its decimal string', () => {
		const target = Buffer.alloc(4);

		types.cstring.write(123, target, 0);

		assert.deepEqual(target, Buffer.from([0x31, 0x32, 0x33, 0x00]));
		assert.equal(types.cstring.size(123), 4);
	});

	test('refuses a string with no terminator rather than running off the end', () => {
		const { err } = types.cstring.read(Buffer.from('abcd'), 0);

		assert.ok(err instanceof Error);
	});
});

describe('buffer', () => {
	const expected = Buffer.from('abcd1234');

	test('reads a binary field of the given length', () => {
		assert.deepEqual(types.buffer.read(expected, 0, expected.length), { value: expected });
	});

	test('sizes a binary field in octets', () => {
		assert.equal(types.buffer.size(expected), 8);
	});

	test('writes a binary field', () => {
		const target = Buffer.alloc(8);

		types.buffer.write(expected, target, 0);

		assert.deepEqual(target, expected);
	});
});

describe('dest_address_array', () => {
	const encoded = Buffer.from([
		0x02,
		0x01, 0x01, 0x02, 0x31, 0x32, 0x33, 0x00,
		0x02, 0x61, 0x62, 0x63, 0x00,
	]);
	const expected: DestAddress[] = [
		{ dest_addr_npi: 2, dest_addr_ton: 1, destination_addr: '123' },
		{ dl_name: 'abc' },
	];

	test('reads every dest_address structure', () => {
		assert.deepEqual(types.dest_address_array.read(encoded, 0), { value: expected });
	});

	test('sizes every dest_address structure', () => {
		assert.equal(types.dest_address_array.size(expected), 13);
	});

	test('writes every dest_address structure', () => {
		const target = Buffer.alloc(13);

		types.dest_address_array.write(expected, target, 0);

		assert.deepEqual(target, encoded);
	});
});

describe('unsuccess_sme_array', () => {
	const encoded = Buffer.from([
		0x02,
		0x03, 0x04, 0x61, 0x62, 0x63, 0x00, 0x00, 0x00, 0x00, 0x07,
		0x05, 0x06, 0x31, 0x32, 0x33, 0x00, 0x10, 0x00, 0x00, 0x08,
	]);
	const expected: UnsuccessSme[] = [
		{ dest_addr_npi: 4, dest_addr_ton: 3, destination_addr: 'abc', error_status_code: 0x00000007 },
		{ dest_addr_npi: 6, dest_addr_ton: 5, destination_addr: '123', error_status_code: 0x10000008 },
	];

	test('reads every unsuccess_sme structure', () => {
		assert.deepEqual(types.unsuccess_sme_array.read(encoded, 0), { value: expected });
	});

	test('sizes every unsuccess_sme structure', () => {
		assert.equal(types.unsuccess_sme_array.size(expected), 21);
	});

	test('writes every unsuccess_sme structure', () => {
		const target = Buffer.alloc(21);

		types.unsuccess_sme_array.write(expected, target, 0);

		assert.deepEqual(target, encoded);
	});
});

describe('bounds checking', () => {
	// 0.4.0 let a short or malformed PDU throw straight out of the codec.
	test('reading past the end returns an error instead of throwing', () => {
		assert.ok(types.int32.read(Buffer.alloc(2), 0).err instanceof Error);
		assert.ok(types.int8.read(Buffer.alloc(1), 5).err instanceof Error);
		assert.ok(types.string.read(Buffer.from([10, 0x61]), 0).err instanceof Error);
	});

	test('writing past the end returns an error instead of throwing', () => {
		assert.ok(types.int32.write(1, Buffer.alloc(2), 0).err instanceof Error);
		assert.ok(types.cstring.write('abcd', Buffer.alloc(2), 0).err instanceof Error);
	});
});
