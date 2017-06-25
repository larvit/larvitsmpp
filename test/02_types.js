'use strict';

const	assert	= require('assert'),
	types	= require(__dirname + '/../lib/defs.js').types;

describe('int8', function () {
	const	expected	= 0x65,
		b	= new Buffer([0, 0x65]);

	describe('#read()', function () {
		it('should read one byte as integer', function () {
			const	result	= types.int8.read(b, 1);
			assert.equal(result, expected);
		});
	});

	describe('#size()', function () {
		it('should return 1', function () {
			assert.equal(types.int8.size(expected),	1);
		});
	});

	describe('#write()', function () {
		it('should write one byte to the buffer', function () {
			types.int8.write(expected, b, 0);
			assert.deepEqual(new Buffer([0x65]), b.slice(0, 1));
		});
	});
});

describe('int16', function () {
	const	expected	= 0x0565,
		b	= new Buffer([0, 0x05, 0x65]);

	describe('#read()', function () {
		it('should read 2 bytes as integer', function () {
			const	result	= types.int16.read(b, 1);
			assert.equal(result, expected);
		});
	});

	describe('#size()', function () {
		it('should return 2', function () {
			assert.equal(types.int16.size(expected),	2);
		});
	});

	describe('#write()', function () {
		it('should write 2 bytes to the buffer', function () {
			types.int16.write(expected, b, 0);
			assert.deepEqual(new Buffer([0x05, 0x65]),	b.slice(0, 2));
		});
	});
});

describe('int32', function () {
	const	expected	= 0x10024045,
		b	= new Buffer([0, 0x10, 0x02, 0x40, 0x45]);

	describe('#read()', function () {
		it('should read 4 bytes as integer', function () {
			const	result	= types.int32.read(b, 1);
			assert.equal(result, expected);
		});
	});

	describe('#size()', function () {
		it('should return 4', function () {
			assert.equal(types.int32.size(expected), 4);
		});
	});

	describe('#write()', function () {
		it('should write 4 bytes to the buffer', function () {
			types.int32.write(expected, b, 0);
			assert.deepEqual(new Buffer([0x10, 0x02, 0x40, 0x45]), b.slice(0, 4));
		});
	});
});

describe('string', function () {
	const	expected	= 'abcd1234',
		b	= new Buffer(9);

	b[0]	= 8;
	b.write(expected, 1);

	describe('#read()', function () {
		it('should read an Octet String from the buffer', function () {
			const	result	= types.string.read(b, 0);
			assert.equal(result, expected);
		});
	});

	describe('#size()', function () {
		it('should return the length of an Octet String from its first byte', function () {
			assert.equal(9, types.string.size(expected));
		});
	});

	describe('#write()', function () {
		it('should write an Octet String to the buffer', function () {
			const	b2	= new Buffer(9);
			types.string.write(expected, b2, 0);
			assert.deepEqual(b, b2);
		});
	});
});

describe('cstring', function () {
	const	expected	= 'abcd1234',
		b	= new Buffer(9);

	b[8]	= 0;
	b.write(expected, 0);

	describe('#read()', function () {
		it('should read a C-Octet String (null-terminated string) from the buffer', function () {
			const	result	= types.cstring.read(b, 0);
			assert.equal(result, expected);
		});
	});

	describe('#size()', function () {
		it('should return the length of a C-Octet String (null-terminated string)', function () {
			assert.equal(9, types.cstring.size(expected));
		});
	});

	describe('#write()', function () {
		it('should write a C-Octet String (null-terminated string) to the buffer', function () {
			const	b2	= new Buffer(9);
			types.cstring.write(expected, b2, 0);
			assert.deepEqual(b,	b2);
		});
	});
});

describe('buffer', function () {
	const	expected	= new Buffer('abcd1234'),
		b	= new Buffer(8);

	b.write(expected.toString());

	describe('#read()', function () {
		it('should read a binary field from the buffer', function () {
			const	result	= types.buffer.read(b, 0, b.length);
			assert.deepEqual(result, expected);
		});
	});

	describe('#size()', function () {
		it('should return the size of a binary field in bytes', function () {
			assert.equal(8, types.buffer.size(expected));
		});
	});

	describe('#write()', function () {
		it('should write a binary field to the buffer', function () {
			const	b2	= new Buffer(8);
			types.buffer.write(expected, b2, 0);
			assert.deepEqual(b, b2);
		});
	});
});

describe('dest_address_array', function () {
	const	expected	= [],
		b	= new Buffer([0x02, 0x01, 0x01, 0x02, 0x31, 0x32, 0x33, 0x00, 0x02, 0x61, 0x62, 0x63, 0x00]);

	expected.push({
		'dest_addr_ton':	1,
		'dest_addr_npi':	2,
		'destination_addr':	'123'
	});
	expected.push({'dl_name': 'abc'});

	describe('#read()', function () {
		it('should read all dest_address structures from the buffer', function () {
			const	result	= types.dest_address_array.read(b, 0);
			assert.deepEqual(result, expected);
		});
	});

	describe('#size()', function () {
		it('should return the size of all dest_address structures in bytes', function () {
			assert.equal(types.dest_address_array.size(expected), 13);
		});
	});

	describe('#write()', function () {
		it('should write an array of dest_address structures to the buffer', function () {
			const	b2	= new Buffer(13);
			types.dest_address_array.write(expected, b2, 0);
			assert.deepEqual(b, b2);
		});
	});
});

describe('unsuccess_sme_array', function () {
	const	expected	= [],
		b	= new Buffer([0x02, 0x03, 0x04, 0x61, 0x62, 0x63, 0x00, 0x00, 0x00, 0x00, 0x07, 0x05, 0x06, 0x31, 0x32, 0x33, 0x00, 0x10, 0x00, 0x00, 0x08]);

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

	describe('#read()', function () {
		it('should read all unsuccess_sme structures from the buffer', function () {
			const	result	= types.unsuccess_sme_array.read(b, 0);
			assert.deepEqual(result, expected);
		});
	});

	describe('#size()', function () {
		it('should return the size of all unsuccess_sme structures in bytes', function () {
			assert.equal(types.unsuccess_sme_array.size(expected), 21);
		});
	});

	describe('#write()', function () {
		it('should write an array of unsuccess_sme structures to the buffer', function () {
			const	b2	= new Buffer(21);
			types.unsuccess_sme_array.write(expected, b2, 0);
			assert.deepEqual(b, b2);
		});
	});
});
