import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { PduRefusedError, isCommand, isResp, objToPdu, pduReturn, pduToObj, refusalAnswer } from '../src/pdu.ts';

function encode(...args: Parameters<typeof objToPdu>): Buffer {
	const { buffer, err } = objToPdu(...args);

	assert.equal(err, undefined);
	assert.ok(buffer);

	return buffer;
}

function decode(pdu: Buffer) {
	const { err, pduObj } = pduToObj(pdu);

	assert.equal(err, undefined);
	assert.ok(pduObj);

	return pduObj;
}

describe('header', () => {
	test('writes command length, id, status and sequence number', () => {
		const pdu = encode({ cmdName: 'bind_transceiver_resp', cmdStatus: 'ESME_RALYBND', seqNr: 1 });

		// A failure response is header-only, so 16 rather than 17 with an empty system_id.
		assert.equal(pdu.readUInt32BE(0), 16);
		assert.equal(pdu.readUInt32BE(4).toString(16), '80000009');
		assert.equal(pdu.readUInt32BE(8), 5);
		assert.equal(pdu.readUInt32BE(12), 1);
	});

	test('round-trips back to the same object', () => {
		const pduObj = decode(encode({
			cmdName: 'bind_transceiver_resp',
			cmdStatus: 'ESME_RALYBND',
			seqNr: 1,
		}));

		assert.equal(pduObj.cmdId.toString(16), '80000009');
		assert.equal(pduObj.cmdStatus, 'ESME_RALYBND');
		assert.equal(pduObj.seqNr, 1);
		assert.ok(isResp(pduObj));
	});

	// SMPP 3.4 4.7.1 stops the range at 0x7FFFFFFF, but peers write the field as a plain uint32.
	test('carries any 32-bit sequence number, and refuses one the field cannot hold', () => {
		assert.equal(decode(encode({ cmdName: 'enquire_link', seqNr: 0x80000001 })).seqNr, 0x80000001);
		assert.equal(decode(encode({ cmdName: 'enquire_link', seqNr: 0xFFFFFFFF })).seqNr, 0xFFFFFFFF);
		assert.ok(objToPdu({ cmdName: 'submit_sm', seqNr: 0x100000000 }).err instanceof Error);
	});
});

describe('parsing real PDUs', () => {
	test('parses a bind_transmitter captured from an SMSC', () => {
		const pduObj = decode(Buffer.from(
			'0000002F000000020000000000000001534D50503354455354007365637265743038005355424D4954310000010100',
			'hex',
		));

		assert.equal(pduObj.cmdId, 2);
		assert.equal(pduObj.cmdStatus, 'ESME_ROK');
		assert.equal(pduObj.cmdName, 'bind_transmitter');
		assert.equal(pduObj.params.system_id, 'SMPP3TEST');
		assert.equal(pduObj.params.interface_version, 0);
	});

	test('reads a submit_sm with a trailing NULL octet after short_message', () => {
		const pduObj = decode(Buffer.from(
			'0000003c0000000400000000000000020001003436373031313333313131000101343637303937373133333700000000000000000100047465737400',
			'hex',
		));

		assert.equal(pduObj.params.short_message, 'test');
		assert.equal(pduObj.cmdLength, 60);
	});

	test('reads a submit_sm without one', () => {
		const pduObj = decode(Buffer.from(
			'0000003b00000004000000000000000200010034363730313133333131310001013436373039373731333337000000000000000001000474657374',
			'hex',
		));

		assert.equal(pduObj.params.short_message, 'test');
		assert.equal(pduObj.cmdLength, 59);
	});
});

describe('encoding submit_sm', () => {
	test('produces the same bytes as 0.4.0 for a GSM message', () => {
		const pdu = encode({
			cmdName: 'submit_sm',
			cmdStatus: 'ESME_ROK',
			params: {
				destination_addr: '46709771337',
				short_message: 'Hello world',
				source_addr: '46701113311',
			},
			seqNr: 12,
		});

		assert.equal(
			pdu.toString('hex'),
			'0000004200000004000000000000000c00000034363730313131333331310000003436373039373731333337000000000000000001000b48656c6c6f20776f726c64',
		);
	});

	test('produces the same bytes as 0.4.0 for a UCS2 message', () => {
		const pdu = encode({
			cmdName: 'submit_sm',
			cmdStatus: 'ESME_ROK',
			params: {
				destination_addr: '46709771337',
				short_message: 'Hello«»world',
				source_addr: '46701113311',
			},
			seqNr: 12,
		});

		assert.equal(
			pdu.toString('hex'),
			'0000004f00000004000000000000000c00000034363730313131333331310000003436373039373731333337000000000000000008001800480065006c006c006f00ab00bb0077006f0072006c0064',
		);
	});

	test('encodes a string short_message with the given data_coding instead of a detected one', () => {
		const pdu = encode({
			cmdName: 'submit_sm',
			params: {
				data_coding: 0x08,
				destination_addr: '46709771337',
				short_message: 'hi',
				source_addr: '46701113311',
			},
			seqNr: 12,
		});

		assert.equal(pdu.subarray(-7).toString('hex'), '08000400680069');
	});

	test('keeps a UDH-carrying short_message as a buffer', () => {
		const message = Buffer.concat([
			Buffer.from('050003010101', 'hex'),
			Buffer.from('hej världen'),
		]);
		const pduObj = decode(encode({
			cmdName: 'submit_sm',
			params: {
				data_coding: 0x08,
				destination_addr: '46709771337',
				esm_class: 0x40,
				short_message: message,
				sm_length: message.length,
				source_addr: '46701113311',
			},
			seqNr: 12,
		}));

		assert.ok(Buffer.isBuffer(pduObj.params.short_message));
		assert.equal(pduObj.params.short_message.toString('hex'), '05000301010168656a2076c3a4726c64656e');
	});

	test('derives sm_length from a Buffer short_message the caller gave no length for', () => {
		const message = Buffer.concat([Buffer.from('050003010201', 'hex'), Buffer.from('hej')]);
		const pduObj = decode(encode({
			cmdName: 'submit_sm',
			params: {
				destination_addr: '46709771337',
				esm_class: 0x40,
				short_message: message,
				source_addr: '46701113311',
			},
			seqNr: 12,
		}));

		assert.equal(pduObj.params.sm_length, message.length);
		assert.deepEqual(pduObj.params.short_message, message);
	});

	test('accepts a number for a C-string parameter', () => {
		const pduObj = decode(encode({
			cmdName: 'submit_sm_resp',
			params: { message_id: 450 },
			seqNr: 2,
		}));

		assert.equal(pduObj.params.message_id, '450');
	});

	// 0.4.0 allocated one octet short whenever the message ended in 0x00 while still reporting the
	// full sm_length, so the PDU went out corrupt.
	test('encodes a UCS2 message ending in a zero low byte', () => {
		const pduObj = decode(encode({
			cmdName: 'submit_sm',
			params: {
				destination_addr: '46709771337',
				short_message: 'hej 一',
				source_addr: '46701113311',
			},
			seqNr: 3,
		}));

		assert.equal(pduObj.params.short_message, 'hej 一');
		assert.equal(pduObj.params.sm_length, 10);
	});
});

describe('encoding submit_multi', () => {
	const dest = { dest_addr_npi: 1, dest_addr_ton: 1, destination_addr: '46709771337' };

	test('reports a value the destination structures cannot hold instead of throwing', () => {
		const badTon = objToPdu({
			cmdName: 'submit_multi',
			params: {
				dest_address: [{ ...dest, dest_addr_ton: 999 }],
				short_message: 'hi',
				source_addr: '46701113311',
			},
		});
		const tooMany = objToPdu({
			cmdName: 'submit_multi',
			params: {
				dest_address: Array.from({ length: 300 }, () => dest),
				short_message: 'hi',
				source_addr: '46701113311',
			},
		});
		const badStatus = objToPdu({
			cmdName: 'submit_multi_resp',
			params: {
				message_id: '01a03ff4-737f-7c01-91db-cb14aa779bcf',
				unsuccess_sme: [{ ...dest, error_status_code: 0x1FFFFFFFF }],
			},
		});

		assert.ok(badTon.err instanceof Error);
		assert.ok(tooMany.err instanceof Error);
		assert.ok(badStatus.err instanceof Error);
	});
});

describe('TLVs', () => {
	test('extracts TLVs from a delivery receipt captured from an SMSC', () => {
		const pduObj = decode(Buffer.from(
			'000000e9000000050000000002a82e8600010134363730393737313333370000003436373031313133333131000400000000000000007569643a313535303430363231323432313433353835207375623a30303120646c7672643a303031207375626d697420646174653a3135303430363233323420646f6e6520646174653a3135303430363233323420737461743a44454c49565244206572723a3030303020746578743a202062616666042300030300000427000102001e001331353530343036323132343231343335383500141800040000076c145400040000000114160006323430303800',
			'hex',
		));

		assert.equal(pduObj.cmdId.toString(16), '5');
		assert.equal(pduObj.cmdStatus, 'ESME_ROK');
		assert.equal(pduObj.seqNr, 44576390);
		assert.equal(pduObj.params.destination_addr, '46701113311');
		assert.equal(pduObj.tlvs.receipted_message_id?.tagValue, '155040621242143585');
	});

	test('round-trips known and unknown TLVs', () => {
		const pduObj = decode(encode({
			cmdName: 'deliver_sm',
			params: {
				destination_addr: '46709771337',
				esm_class: 4,
				short_message: 'random stuff',
				source_addr: '46701113311',
			},
			seqNr: 393,
			tlvs: {
				5142: { tagId: 5142, tagValue: Buffer.from('blajfoo', 'ascii') },
				receipted_message_id: { tagValue: '293f293' },
			},
		}));

		assert.equal(pduObj.tlvs.receipted_message_id?.tagValue, '293f293');

		const unknown = pduObj.tlvs['5142'];

		assert.ok(unknown);
		assert.equal(unknown.tagName, undefined);
		assert.deepEqual(unknown.tagValue, Buffer.from('blajfoo', 'ascii'));
	});

	test('keeps a binary TLV byte for byte through pduToObj and back', () => {
		const payload = Buffer.from('deadbeef00ff', 'hex');
		const params = {
			destination_addr: '46709771337',
			esm_class: 4,
			short_message: 'binary payload follows',
			source_addr: '46701113311',
		};
		const parsed = decode(encode({
			cmdName: 'deliver_sm',
			params,
			seqNr: 7,
			tlvs: { message_payload: { tagValue: payload } },
		}));
		const carried = parsed.tlvs.message_payload;

		assert.ok(carried);
		assert.deepEqual(carried.tagValue, payload);

		const rebuilt = decode(encode({
			cmdName: 'deliver_sm',
			params,
			seqNr: 7,
			tlvs: { message_payload: { tagValue: carried.tagValue } },
		}));

		assert.deepEqual(rebuilt.tlvs.message_payload?.tagValue, payload);
	});

	test('takes the tag id from the record key when the caller gives none', () => {
		const pduObj = decode(encode({
			cmdName: 'deliver_sm',
			params: { destination_addr: '46709771337', short_message: 'hi', source_addr: '46701113311' },
			seqNr: 11,
			tlvs: { message_state: { tagValue: 6 }, source_port: { tagValue: 1234 } },
		}));

		assert.deepEqual(pduObj.tlvs.message_state, { tagId: 0x0427, tagName: 'message_state', tagValue: 6 });
		assert.deepEqual(pduObj.tlvs.source_port, { tagId: 0x020A, tagName: 'source_port', tagValue: 1234 });
	});

	test('refuses an unknown tag name rather than putting a wrong tag on the wire', () => {
		const { buffer, err } = objToPdu({
			cmdName: 'deliver_sm',
			params: { destination_addr: '46709771337', short_message: 'hi', source_addr: '46701113311' },
			tlvs: { nils: { tagValue: 'blajfoo' } },
		});

		assert.equal(buffer, undefined);
		assert.ok(err instanceof Error);
	});

	test('refuses a tag id that does not fit the two octet field', () => {
		const { err } = objToPdu({
			cmdName: 'deliver_sm',
			params: { destination_addr: '46709771337', short_message: 'hi', source_addr: '46701113311' },
			tlvs: { nils: { tagId: 0x10000, tagValue: 'blajfoo' } },
		});

		assert.ok(err instanceof Error);
	});

	test('refuses a TLV too long for the two octet length field', () => {
		const { err } = objToPdu({
			cmdName: 'deliver_sm',
			params: { destination_addr: '46709771337', short_message: 'hi', source_addr: '46701113311' },
			tlvs: { message_payload: { tagValue: Buffer.alloc(0x10000) } },
		});

		assert.ok(err instanceof Error);
	});

	test('round-trips a receipt with message_state and receipted_message_id', () => {
		const receipt = 'id:450 sub:001 dlvrd:1 submit date:1504031342 done date:1504031342 stat:DELIVRD err:0 text:xxx';
		const pduObj = decode(encode({
			cmdName: 'deliver_sm',
			params: {
				destination_addr: '46709771337',
				esm_class: 4,
				short_message: receipt,
				source_addr: '46701113311',
			},
			seqNr: 323,
			tlvs: {
				message_state: { tagId: 1063, tagValue: 2 },
				receipted_message_id: { tagId: 30, tagValue: 450 },
			},
		}));

		assert.equal(pduObj.params.short_message, receipt);
		assert.equal(pduObj.cmdName, 'deliver_sm');
		assert.equal(pduObj.tlvs.message_state?.tagValue, 2);
		assert.equal(pduObj.tlvs.receipted_message_id?.tagValue, '450');
		assert.equal(pduObj.seqNr, 323);
	});
});

describe('pduReturn()', () => {
	test('builds the matching response and echoes shared parameters', () => {
		const request = Buffer.from(
			'0000002f000000020000000000000001534d50503354455354007365637265743038005355424d4954310000010100',
			'hex',
		);
		const { buffer, err } = pduReturn(request);

		assert.equal(err, undefined);
		assert.ok(buffer);

		const pduObj = decode(buffer);

		assert.equal(pduObj.cmdId, 2147483650);
		assert.equal(pduObj.cmdStatus, 'ESME_ROK');
		assert.equal(pduObj.cmdName, 'bind_transmitter_resp');
		assert.equal(pduObj.params.system_id, 'SMPP3TEST');
	});

	test('lets a caller override a parameter and set a status', () => {
		const request = decode(encode({
			cmdName: 'submit_sm',
			params: { destination_addr: '46709771337', short_message: 'hi', source_addr: 'foo' },
			seqNr: 9,
		}));
		const { buffer, err } = pduReturn(request, 'ESME_ROK', { message_id: 'abc123' });

		assert.equal(err, undefined);
		assert.ok(buffer);

		const pduObj = decode(buffer);

		assert.equal(pduObj.cmdName, 'submit_sm_resp');
		assert.equal(pduObj.cmdStatus, 'ESME_ROK');
		assert.equal(pduObj.params.message_id, 'abc123');
		assert.equal(pduObj.seqNr, 9);

		// The spec drops the body of a failure response, so the id a caller passes is not sent.
		const refused = pduReturn(request, 'ESME_RINVDSTADR', { message_id: 'abc123' });

		assert.ok(refused.buffer);
		assert.equal(refused.buffer.length, 16);
		assert.equal(decode(refused.buffer).params.message_id, undefined);
	});

	test('refuses a command that has no response', () => {
		const request = decode(encode({ cmdName: 'submit_sm_resp', seqNr: 1 }));

		assert.ok(pduReturn(request).err instanceof Error);
	});
});

describe('malformed input', () => {
	// 0.4.0 threw out of the codec for all of these.
	test('reports rather than throws', () => {
		assert.ok(pduToObj(Buffer.alloc(4)).err instanceof Error);
		assert.ok(pduToObj(Buffer.from('0000000f0000000400000000000000ff', 'hex')).err instanceof Error);
		assert.ok(pduToObj(Buffer.from('000000ff0000000400000000000000ff', 'hex')).err instanceof Error);
		assert.ok(pduToObj(Buffer.from('000000100badf00d0000000000000001', 'hex')).err instanceof Error);
	});

	test('refuses an absurd command length instead of allocating for it', () => {
		assert.ok(pduToObj(Buffer.from('ffffffff0000000400000000000000ff', 'hex')).err instanceof Error);
	});

	test('reads the header of a PDU it cannot parse, and names which part it choked on', () => {
		const unknown = encode({ cmdName: 'enquire_link', seqNr: 9 });

		unknown.writeUInt32BE(0x00010001, 4);

		const refusedCommand = pduToObj(unknown).err;

		assert.ok(refusedCommand instanceof PduRefusedError);
		assert.equal(refusedCommand.reason, 'command');
		assert.equal(refusedCommand.header.cmdName, undefined);
		assert.equal(refusedCommand.header.cmdId, 0x00010001);
		assert.equal(refusedCommand.header.seqNr, 9);
		assert.deepEqual(refusalAnswer(refusedCommand), {
			cmdName: 'generic_nack',
			cmdStatus: 'ESME_RINVCMDID',
		});

		const whole = encode({
			cmdName: 'deliver_sm',
			params: { destination_addr: '46709771337', short_message: 'hello', source_addr: '46701113311' },
			seqNr: 10,
		});
		// sm_length still declares five octets of short_message; three of them never arrived.
		const short = whole.subarray(0, whole.length - 3);

		short.writeUInt32BE(short.length, 0);

		const refusedBody = pduToObj(short).err;

		assert.ok(refusedBody instanceof PduRefusedError);
		assert.equal(refusedBody.reason, 'body');
		assert.equal(refusedBody.header.cmdName, 'deliver_sm');
		assert.deepEqual(refusalAnswer(refusedBody), {
			cmdName: 'deliver_sm_resp',
			cmdStatus: 'ESME_RINVCMDLEN',
		});

		// message_state, declaring four octets of value with one of them on the wire.
		const truncatedTlv = Buffer.concat([
			encode({ cmdName: 'deliver_sm', params: { short_message: 'hello' }, seqNr: 11 }),
			Buffer.from('0427000401', 'hex'),
		]);

		truncatedTlv.writeUInt32BE(truncatedTlv.length, 0);

		const refusedTlvs = pduToObj(truncatedTlv).err;

		assert.ok(refusedTlvs instanceof PduRefusedError);
		assert.equal(refusedTlvs.reason, 'tlvs');
		assert.deepEqual(refusalAnswer(refusedTlvs), {
			cmdName: 'deliver_sm_resp',
			cmdStatus: 'ESME_RINVTLVSTREAM',
		});
	});

	test('answers a command with no response of its own with generic_nack', () => {
		const outbind = encode({ cmdName: 'outbind', params: { system_id: 'smsc' }, seqNr: 12 });
		// Both C-Octet Strings lose their terminator, so system_id runs off the end of the PDU.
		const short = outbind.subarray(0, outbind.length - 2);

		short.writeUInt32BE(short.length, 0);

		const refused = pduToObj(short).err;

		assert.ok(refused instanceof PduRefusedError);
		assert.equal(refusalAnswer(refused).cmdName, 'generic_nack');
	});
});

describe('isCommand()', () => {
	test('narrows parameters to the command that was parsed', () => {
		const pduObj = decode(encode({
			cmdName: 'submit_sm',
			params: { destination_addr: '46709771337', short_message: 'hi', source_addr: 'foo' },
			seqNr: 1,
		}));

		assert.ok(isCommand(pduObj, 'submit_sm'));
		// Fails to compile if destination_addr is not known to be a string here.
		assert.equal(pduObj.params.destination_addr.length, 11);
		assert.ok(!isCommand(pduObj, 'deliver_sm'));
	});
});
