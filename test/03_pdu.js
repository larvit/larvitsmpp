'use strict';

var larvitsmpp = require('../larvitsmpp'),
    assert     = require('assert');

describe('PDU convertion', function() {
	this.slow(20);

	describe('No TLVs', function() {
		it('should build a PDU buffer for bind_transceiver_resp with error correctly', function(done) {
			larvitsmpp.utils.objToPdu({
				'cmdName': 'bind_transceiver_resp',
				'cmdStatus': 'ESME_RALYBND',
				'seqNr': 1
			}, function(err, pdu) {
				assert( ! err, 'Error should be negative');

				assert(pdu.readUInt32BE(0)               === 17,         'Command length should be 17, but is: "' + pdu.readUInt32BE(0) + '"');
				assert(pdu.readUInt32BE(4).toString(16)  === '80000009', 'Command ID should be 0x80000009');
				assert(pdu.readUInt32BE(8).toString(16)  === '5',        'Command status should be 0x00000005');
				assert(pdu.readUInt32BE(12).toString(10) === '1',        'Sequence number should be 1');

				done();
			});
		});

		it('should be able to do the above test and put it back to an object', function(done) {
			larvitsmpp.utils.objToPdu({
				'cmdName': 'bind_transceiver_resp',
				'cmdStatus': 'ESME_RALYBND',
				'seqNr': 1
			}, function(err, pdu) {
				assert( ! err, 'Error should be negative');

				larvitsmpp.utils.pduToObj(pdu, function(err, obj) {
					assert( ! err, 'Error should be negative');

					assert(obj.cmdId.toString(16) === '80000009',     'Command ID should be 0x80000009');
					assert(obj.cmdStatus          === 'ESME_RALYBND', 'Command status should be "ESME_RALYBND"');
					assert(obj.seqNr              === 1,              'Sequence number should be 1');

					done();
				});
			});
		});

		it('should parse a PDU to obj correctly', function(done) {
			var pdu = new Buffer('0000002F000000020000000000000001534D50503354455354007365637265743038005355424D4954310000010100', 'hex');

			larvitsmpp.utils.pduToObj(pdu, function(err, obj) {
				assert( ! err, 'Error should be negative');

				assert(obj.cmdId                    === 2,                  'Command ID should be 2');
				assert(obj.cmdStatus                === 'ESME_ROK',         'Command status should be "ESME_ROK"');
				assert(obj.cmdName                  === 'bind_transmitter', 'Command name should be "bind_transmitter"');
				assert(obj.params.system_id         === 'SMPP3TEST',        'system_id should be "SMPP3TEST"');
				assert(obj.params.interface_version === 0,                  'Interface version should be 0');

				done();
			});
		});

		it('should create a return PDU without error', function(done) {
			var pdu = new Buffer('0000002f000000020000000000000001534d50503354455354007365637265743038005355424d4954310000010100', 'hex');

			larvitsmpp.utils.pduReturn(pdu, function(err, retPdu) {
				assert( ! err, 'Error should be negative');

				larvitsmpp.utils.pduToObj(retPdu, function(err, retObj) {
					assert( ! err, 'Error should be negative');

					assert(retObj.cmdId                    === 2147483650,              'Command ID should be 2147483650');
					assert(retObj.cmdStatus                === 'ESME_ROK',              'Command status should be "ESME_ROK"');
					assert(retObj.cmdName                  === 'bind_transmitter_resp', 'Command name should be "bind_transmitter_resp"');
					assert(retObj.params.system_id         === 'SMPP3TEST',             'system_id should be "SMPP3TEST"');

					done();
				});
			});
		});

		it('should read a submit_sm with an ending NULL octet to the short_message', function(done) {
			var pdu = new Buffer('0000003c0000000400000000000000020001003436373031313333313131000101343637303937373133333700000000000000000100047465737400', 'hex');

			larvitsmpp.utils.pduToObj(pdu, function(err, obj) {
				assert( ! err, 'Error should be negative');

				assert(obj.params.short_message === 'test', 'Param short_message should read "test"');
				assert(obj.cmdLength            === 60,     'Command length should be 60, due to the trailing NULL octet');

				done();
			});
		});

		it('should read a submit_sm without an ending NULL octet to the short_message', function(done) {
			var pdu = new Buffer('0000003b00000004000000000000000200010034363730313133333131310001013436373039373731333337000000000000000001000474657374', 'hex');

			larvitsmpp.utils.pduToObj(pdu, function(err, obj) {
				assert( ! err, 'Error should be negative');

				assert(obj.params.short_message === 'test', 'Param short_message should read "test"');
				assert(obj.cmdLength            === 59,     'Command length should be 59');

				done();
			});
		});

		it('should create a very simple submit_sm PDU', function(done) {
			larvitsmpp.utils.objToPdu({
				'cmdName': 'submit_sm',
				'cmdStatus': 'ESME_ROK',
				'seqNr': 12,
				'params': {
					'source_addr': '46701113311',
					'destination_addr': '46709771337',
					'short_message': 'Hello world'
				}
			}, function(err, pdu) {
				assert( ! err, 'Error should be negative');

				assert(pdu.toString('hex') === '0000004200000004000000000000000c00000034363730313131333331310000003436373039373731333337000000000000000001000b48656c6c6f20776f726c64');

				done();
			});
		});

		it('should create a submit_sm PDU with UCS2 encoding', function(done) {
			larvitsmpp.utils.objToPdu({
				'cmdName': 'submit_sm',
				'cmdStatus': 'ESME_ROK',
				'seqNr': 12,
				'params': {
					'source_addr': '46701113311',
					'destination_addr': '46709771337',
					'short_message': 'Hello«»world'
				}
			}, function(err, pdu) {
				assert( ! err, 'Error should be negative');

				assert(pdu.toString('hex') === '0000004f00000004000000000000000c00000034363730313131333331310000003436373039373731333337000000000000000008001800480065006c006c006f00ab00bb0077006f0072006c0064');

				done();
			});
		});

		it('should create a submit_sm PDU with esm_class 0x40 and a short_message with UDH in it', function(done) {
			var msg      = 'hej världen',
			    msgBuf   = Buffer.concat([new Buffer('050003010101', 'hex'), new Buffer(msg)]),
			    encoding = larvitsmpp.defs.encodings.detect(msg);

			larvitsmpp.utils.objToPdu({
				'cmdName': 'submit_sm',
				'cmdStatus': 'ESME_ROK',
				'seqNr': 12,
				'params': {
					'esm_class': 0x40,
					'source_addr': '46701113311',
					'destination_addr': '46709771337',
					'sm_length': msgBuf.length,
					'data_coding': larvitsmpp.defs.consts.ENCODING[encoding],
					'short_message': msgBuf
				}
			}, function(err, pdu) {
				assert( ! err, 'Error should be negative');

				larvitsmpp.utils.pduToObj(pdu, function(err, retObj) {
					assert( ! err, 'Error should be negative');

					assert(retObj.params.short_message.toString('hex') === '05000301010168656a2076c3a4726c64656e', 'short_message should be correct');

					done();
				});

			});
		});


		it('should encode and decode integer cstring params correctly', function(done) {
			var pduObj = {
				'cmdName': 'submit_sm_resp',
				'cmdStatus': 'ESME_ROK',
				'seqNr': 2,
				'params': {
					'message_id': 450
				}
			};

			larvitsmpp.utils.objToPdu(pduObj, function(err, pduBuf) {
				assert( ! err, 'Error should be negative');

				larvitsmpp.utils.pduToObj(pduBuf, function(err, retPduObj) {
					assert( ! err, 'Error should be negative');

					assert(retPduObj.params.message_id === '450', 'message_id param should be 450, but as string');

					done();
				});
			});
		});
	});

	describe('TLVs', function() {
		it('should extract TLVs from a PDU', function(done) {
			var pdu = new Buffer('000000e9000000050000000002a82e8600010134363730393737313333370000003436373031313133333131000400000000000000007569643a313535303430363231323432313433353835207375623a30303120646c7672643a303031207375626d697420646174653a3135303430363233323420646f6e6520646174653a3135303430363233323420737461743a44454c49565244206572723a3030303020746578743a202062616666042300030300000427000102001e001331353530343036323132343231343335383500141800040000076c145400040000000114160006323430303800', 'hex');

			larvitsmpp.utils.pduToObj(pdu, function(err, obj) {
				assert( ! err, 'Error should be negative');

				assert(obj.cmdId.toString(16)                 === '5',                  'Command ID should be 0x00000005 (5)');
				assert(obj.cmdStatus                          === 'ESME_ROK',           'Command status should be "ESME_ROK"');
				assert(obj.seqNr                              === 44576390,             'Sequence number should be 44576390');
				assert(obj.params.destination_addr            === '46701113311',        'Param destination_addr should be "46701113311"');
				assert(obj.tlvs.receipted_message_id.tagValue === '155040621242143585', 'TLV receipted_message_id should be "155040621242143585", but is "' + obj.tlvs.receipted_message_id.tagValue + '"');

				done();
			});
		});

		it('should add TLVs to a PDU', function(done) {
			var pduObj = {
				'cmdName': 'deliver_sm',
				'seqNr': 393,
				'cmdStatus': 'ESME_ROK',
				'params': {
					'source_addr': '46701113311',
					'destination_addr': '46709771337',
					'esm_class': 4,
					'short_message': 'random stuff'
				},
				'tlvs': {
					'receipted_message_id': {
						'tagId': 0x001E,
						'tagName': 'receipted_message_id',
						'tagValue': '293f293'
					},
					'5142': {
						'tagId': 5142,
						'tagName': 'Nils',
						'tagValue': new Buffer('blajfoo', 'ascii')
					}
				}
			};

			larvitsmpp.utils.objToPdu(pduObj, function(err, pduBuf) {
				assert( ! err, 'Error should be negative');

				larvitsmpp.utils.pduToObj(pduBuf, function(err, pduObj2) {
					var unknownTlvBuf = new Buffer(pduObj2.tlvs['5142'].tagValue, 'hex');

					assert( ! err, 'Error should be negative');

					assert(pduObj2.tlvs.receipted_message_id !== undefined, 'TLV receipted_message_id should not be undefined');
					assert(pduObj2.tlvs.receipted_message_id.tagValue === '293f293', 'receipted_message_id should match the given one');
					assert(unknownTlvBuf.toString('ascii') === 'blajfoo', 'Unknown TLV 5142 should have a valid buffer');

					done();
				});
			});
		});

		it('should add some other TLVs to a PDU', function(done) {
			var pduObj = {
				'cmdName': 'deliver_sm',
				'params': {
					'source_addr': '46701113311',
					'destination_addr': '46709771337',
					'esm_class': 4,
					'short_message': 'id:450 sub:001 dlvrd:1 submit date:1504031342 done date:1504031342 stat:DELIVRD err:0 text:xxx'
				},
				'tlvs': {
					'receipted_message_id': {
						'tagId': 30,
						'tagName': 'receipted_message_id',
						'tagValue': 450
					},
					'message_state': {
						'tagId': 1063,
						'tagName': 'message_state',
						'tagValue': 2
					}
				},
				'seqNr': 323
			};

			larvitsmpp.utils.objToPdu(pduObj, function(err, pduBuf) {
				assert( ! err, 'Error should be negative');

				larvitsmpp.utils.pduToObj(pduBuf, function(err, retPduObj) {
					assert( ! err, 'Error should be negative');

					assert(retPduObj.params.short_message === 'id:450 sub:001 dlvrd:1 submit date:1504031342 done date:1504031342 stat:DELIVRD err:0 text:xxx', 'short_message should be preserved');
					assert(retPduObj.cmdName === 'deliver_sm', 'Command name should be "deliver_sm"');
					assert(retPduObj.tlvs.message_state !== undefined, 'TLV message_state should be set');
					assert(retPduObj.tlvs.message_state.tagValue === 2, 'TLV message_state tagValue should be 2');
					assert(retPduObj.tlvs.receipted_message_id !== undefined, 'TLV receipted_message_id should be set');
					assert(retPduObj.tlvs.receipted_message_id.tagValue === '450', 'TLV receipted_message_id tagValue should be "450"');
					assert(retPduObj.seqNr === 323, 'Sequence number should be 323');

					done();
				});
			});
		});
	});

	describe('Return PDUs', function() {
		it('should create a basic and valid return PDU', function(done) {
			var pduObj = {
				'cmdName': 'deliver_sm',
				'seqNr': 393,
				'cmdStatus': 'ESME_ROK',
				'params': {
					'source_addr': '46701113311',
					'destination_addr': '46709771337',
					'esm_class': 4,
					'short_message': 'random stuff',
					'message_id': 'od9s2'
				},
				'tlvs': {
					'receipted_message_id': {
						'tagId': 0x001E,
						'tagName': 'receipted_message_id',
						'tagValue': '293f293'
					},
					'5142': {
						'tagId': 5142,
						'tagName': 'Nils',
						'tagValue': new Buffer('blajfoo', 'ascii')
					}
				}
			};

			larvitsmpp.utils.pduReturn(pduObj, function(err, pduBuffer) {
				assert( ! err, 'Error should be negative');

				larvitsmpp.utils.pduToObj(pduBuffer, function(err, retPduObj) {
					assert( ! err, 'Error should be negative');

					assert(retPduObj.cmdName === 'deliver_sm_resp', 'Command name should be "deliver_sm_resp"');
					assert(retPduObj.cmdStatus === 'ESME_ROK', 'Command status should be ESME_ROK');
					assert(retPduObj.params.message_id === 'od9s2', 'message_id should be correct');

					done();
				});
			});
		});

		it('should create a valid return PDU with custom param', function(done) {
			var pduObj = {
				'cmdName': 'deliver_sm',
				'seqNr': 393,
				'cmdStatus': 'ESME_ROK',
				'params': {
					'source_addr': '46701113311',
					'destination_addr': '46709771337',
					'esm_class': 4,
					'short_message': 'random stuff',
					'message_id': 'od9s2'
				},
				'tlvs': {
					'receipted_message_id': {
						'tagId': 0x001E,
						'tagName': 'receipted_message_id',
						'tagValue': '293f293'
					},
					'5142': {
						'tagId': 5142,
						'tagName': 'Nils',
						'tagValue': new Buffer('blajfoo', 'ascii')
					}
				}
			};

			larvitsmpp.utils.pduReturn(pduObj, 'ESME_RINVMSGID', {'message_id': 'mep'}, function(err, pduBuffer) {
				assert( ! err, 'Error should be negative');

				larvitsmpp.utils.pduToObj(pduBuffer, function(err, retPduObj) {
					assert( ! err, 'Error should be negative');

					assert(retPduObj.cmdName === 'deliver_sm_resp', 'Command name should be "deliver_sm_resp"');
					assert(retPduObj.cmdStatus === 'ESME_RINVMSGID', 'Command status should be ESME_RINVMSGID');
					assert(retPduObj.params.message_id === 'mep', 'message_id should be the overriden one');

					done();
				});
			});
		});
	});

	describe('Message size and split', function() {
		it('should calculate sizes of msgs', function(done) {
			var a = 'abcd',
			    b = 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
			    c = 'Ledds med « df BLAH och därför är alla hjul runda fast bara några hihi',
			    d = 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdHIHIHIHI foobar',
			    e = 'Ledds med « df BLAH och därför är alla hjul runda fast bara några hihi Ledds med « df BLAH och därför är alla hjul runda fast bara några hihi Ledds med « df BLAH och därför är alla hjul runda fast bara några hihi Ledds med « df BLAH och därför är alla hjul runda fast bara några hihi',
			    f = 'abcd€abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
			    g = 'Ledds med « df BLAH och därför är alla hjul runda fast bara några hihi bara lite längre';

			assert(larvitsmpp.utils.bitCount(a) === 28,   'ASCII');
			assert(larvitsmpp.utils.bitCount(b) === 1120, 'ASCII');
			assert(larvitsmpp.utils.bitCount(b, 'UCS2') === 2560, 'ASCII, expected 2560 but got ' + larvitsmpp.utils.bitCount(b, 'UCS2'));
			assert(larvitsmpp.utils.bitCount(c) === 1120, 'UCS2');
			assert(larvitsmpp.utils.bitCount(d) === 1225, 'ASCII');
			assert(larvitsmpp.utils.bitCount(e) === 4528, 'UCS2');
			assert(larvitsmpp.utils.bitCount(f) === 1120, 'ASCII with special char');
			assert(larvitsmpp.utils.bitCount(g) === 1392, 'UCS2');

			assert(larvitsmpp.utils.splitMsg(a).length === 1);
			assert(larvitsmpp.utils.splitMsg(b).length === 1);
			assert(larvitsmpp.utils.splitMsg(b, 'UCS2').length === 3, 'Expected length 2, but got ' + larvitsmpp.utils.splitMsg(b, 'UCS2').length);
			assert(larvitsmpp.utils.splitMsg(c).length === 1);
			assert(larvitsmpp.utils.splitMsg(d).length === 2);
			assert(larvitsmpp.utils.splitMsg(e).length === 5);
			assert(larvitsmpp.utils.splitMsg(f).length === 1);
			assert(larvitsmpp.utils.splitMsg(g).length === 2);

			done();
		});

		it('should return an array with a buffer equalling the input msg', function(done) {
			var msg  = 'hello world',
			    msgs = larvitsmpp.utils.splitMsg(msg);

			assert(msgs[0].toString() === msg, 'Messages should equal');
			done();
		});
	});

});
