import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import type { DestAddress, UnsuccessSme } from '../src/defs/types.ts';
import { types } from '../src/defs/types.ts';

describe('integers', () => {
	test('int8 reads, sizes and writes one octet', () => {
		const source = Buffer.from([0, 0x65]);
		const target = Buffer.alloc(1);

		assert.deepEqual(types.int8.read(source, 1), { bytesRead: 1, value: 0x65 });
		assert.deepEqual(types.int8.size(0x65), { size: 1 });
		assert.deepEqual(types.int8.write(0x65, target, 0), {});
		assert.deepEqual(target, Buffer.from([0x65]));
	});

	test('int16 reads and writes two octets big-endian', () => {
		const source = Buffer.from([0, 0x05, 0x65]);
		const target = Buffer.alloc(2);

		assert.deepEqual(types.int16.read(source, 1), { bytesRead: 2, value: 0x0565 });
		types.int16.write(0x0565, target, 0);
		assert.deepEqual(target, Buffer.from([0x05, 0x65]));
	});

	test('int32 reads and writes four octets big-endian', () => {
		const source = Buffer.from([0, 0x10, 0x02, 0x40, 0x45]);
		const target = Buffer.alloc(4);

		assert.deepEqual(types.int32.read(source, 1), { bytesRead: 4, value: 0x10024045 });
		types.int32.write(0x10024045, target, 0);
		assert.deepEqual(target, Buffer.from([0x10, 0x02, 0x40, 0x45]));
	});

	// 0.4.0 let Node throw straight out of writeUInt8 for these.
	test('rejects values the field cannot hold', () => {
		assert.ok(types.int8.write(256, Buffer.alloc(1), 0).err instanceof Error);
		assert.ok(types.int8.write(-1, Buffer.alloc(1), 0).err instanceof Error);
		assert.ok(types.int16.write(1.5, Buffer.alloc(2), 0).err instanceof Error);
		assert.ok(types.int8.write('nope', Buffer.alloc(1), 0).err instanceof Error);
	});
});

describe('string (Octet String)', () => {
	const expected = 'abcd1234';
	const encoded = Buffer.concat([Buffer.from([8]), Buffer.from(expected)]);

	test('reads a length-prefixed string', () => {
		assert.deepEqual(types.string.read(encoded, 0), { bytesRead: 9, value: expected });
	});

	test('sizes as the string plus its length octet', () => {
		assert.deepEqual(types.string.size(expected), { size: 9 });
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
		assert.deepEqual(types.cstring.read(encoded, 0), { bytesRead: 9, value: expected });
	});

	test('sizes as the string plus its NULL terminator', () => {
		assert.deepEqual(types.cstring.size(expected), { size: 9 });
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
		assert.deepEqual(types.cstring.size(123), { size: 4 });
	});

	test('refuses a string with no terminator rather than running off the end', () => {
		assert.ok(types.cstring.read(Buffer.from('abcd'), 0).err instanceof Error);
	});
});

describe('buffer', () => {
	const expected = Buffer.from('abcd1234');

	test('reads a binary field of the given length', () => {
		assert.deepEqual(types.buffer.read(expected, 0, expected.length), {
			bytesRead: 8,
			value: expected,
		});
	});

	test('sizes a binary field in octets', () => {
		assert.deepEqual(types.buffer.size(expected), { size: 8 });
	});

	// 0.4.0 subtracted one whenever the last octet was 0x00, so a UCS2 message ending in a
	// character like U+4E00 was allocated one octet short while sm_length still reported the full
	// length — the PDU went out corrupt.
	test('counts a trailing NULL octet like any other', () => {
		assert.deepEqual(types.buffer.size(Buffer.from([0x4E, 0x00])), { size: 2 });
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
		assert.deepEqual(types.dest_address_array.read(encoded, 0), {
			bytesRead: 13,
			value: expected,
		});
	});

	test('sizes every dest_address structure', () => {
		assert.deepEqual(types.dest_address_array.size(expected), { size: 13 });
	});

	test('writes every dest_address structure', () => {
		const target = Buffer.alloc(13);

		types.dest_address_array.write(expected, target, 0);

		assert.deepEqual(target, encoded);
	});

	test('refuses a field value the wire cannot hold instead of throwing', () => {
		const badTon: DestAddress[] = [{ dest_addr_npi: 0, dest_addr_ton: 999, destination_addr: '123' }];
		const tooMany: DestAddress[] = Array.from({ length: 300 }, () => ({ dl_name: 'a' }));

		assert.ok(types.dest_address_array.write(badTon, Buffer.alloc(8), 0).err instanceof Error);
		assert.ok(types.dest_address_array.write(tooMany, Buffer.alloc(901), 0).err instanceof Error);
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
		assert.deepEqual(types.unsuccess_sme_array.read(encoded, 0), {
			bytesRead: 21,
			value: expected,
		});
	});

	test('sizes every unsuccess_sme structure', () => {
		assert.deepEqual(types.unsuccess_sme_array.size(expected), { size: 21 });
	});

	test('writes every unsuccess_sme structure', () => {
		const target = Buffer.alloc(21);

		types.unsuccess_sme_array.write(expected, target, 0);

		assert.deepEqual(target, encoded);
	});

	test('refuses a field value the wire cannot hold instead of throwing', () => {
		const badStatus: UnsuccessSme[] = [
			{ dest_addr_npi: 0, dest_addr_ton: 0, destination_addr: 'abc', error_status_code: 0x1FFFFFFFF },
		];
		const badTon: UnsuccessSme[] = [
			{ dest_addr_npi: 0, dest_addr_ton: 999, destination_addr: 'abc', error_status_code: 0 },
		];

		assert.ok(types.unsuccess_sme_array.write(badStatus, Buffer.alloc(11), 0).err instanceof Error);
		assert.ok(types.unsuccess_sme_array.write(badTon, Buffer.alloc(11), 0).err instanceof Error);
	});
});

describe('bounds checking', () => {
	// 0.4.0 let a short or malformed PDU throw straight out of the codec.
	test('reading past the end returns an error instead of throwing', () => {
		assert.ok(types.int32.read(Buffer.alloc(2), 0).err instanceof Error);
		assert.ok(types.int8.read(Buffer.alloc(1), 5).err instanceof Error);
		assert.ok(types.string.read(Buffer.from([10, 0x61]), 0).err instanceof Error);
		assert.ok(types.dest_address_array.read(Buffer.from([0x05, 0x01]), 0).err instanceof Error);
	});

	test('writing past the end returns an error instead of throwing', () => {
		assert.ok(types.int32.write(1, Buffer.alloc(2), 0).err instanceof Error);
		assert.ok(types.cstring.write('abcd', Buffer.alloc(2), 0).err instanceof Error);
	});
});
