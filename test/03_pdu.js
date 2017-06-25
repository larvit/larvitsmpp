'use strict';

const	larvitsmpp	= require(__dirname + '/../index.js'),
	assert	= require('assert');

describe('PDU convertion', function () {
	this.slow(20);

	describe('No TLVs', function () {
		it('should build a PDU buffer for bind_transceiver_resp with error correctly', function (done) {
			larvitsmpp.utils.objToPdu({
				'cmdName':	'bind_transceiver_resp',
				'cmdStatus':	'ESME_RALYBND',
				'seqNr':	1
			}, function (err, pdu) {
				if (err) throw err;

				assert.strictEqual(pdu.readUInt32BE(0),	17);
				assert.strictEqual(pdu.readUInt32BE(4).toString(16),	'80000009');
				assert.strictEqual(pdu.readUInt32BE(8).toString(16),	'5');
				assert.strictEqual(pdu.readUInt32BE(12).toString(10),	'1');

				done();
			});
		});

		it('should be able to do the above test and put it back to an object', function (done) {
			larvitsmpp.utils.objToPdu({
				'cmdName':	'bind_transceiver_resp',
				'cmdStatus':	'ESME_RALYBND',
				'seqNr':	1
			}, function (err, pdu) {
				if (err) throw err;

				larvitsmpp.utils.pduToObj(pdu, function (err, obj) {
					if (err) throw err;

					assert.strictEqual(obj.cmdId.toString(16),	'80000009');
					assert.strictEqual(obj.cmdStatus,	'ESME_RALYBND');
					assert.strictEqual(obj.seqNr,	1);

					done();
				});
			});
		});

		it('should parse a PDU to obj correctly', function (done) {
			const	pdu	= new Buffer('0000002F000000020000000000000001534D50503354455354007365637265743038005355424D4954310000010100', 'hex');

			larvitsmpp.utils.pduToObj(pdu, function (err, obj) {
				if (err) throw err;

				assert.strictEqual(obj.cmdId,	2);
				assert.strictEqual(obj.cmdStatus,	'ESME_ROK');
				assert.strictEqual(obj.cmdName,	'bind_transmitter');
				assert.strictEqual(obj.params.system_id,	'SMPP3TEST');
				assert.strictEqual(obj.params.interface_version,	0);

				done();
			});
		});

		it('should create a return PDU without error', function (done) {
			const	pdu	= new Buffer('0000002f000000020000000000000001534d50503354455354007365637265743038005355424d4954310000010100', 'hex');

			larvitsmpp.utils.pduReturn(pdu, function (err, retPdu) {
				if (err) throw err;

				larvitsmpp.utils.pduToObj(retPdu, function (err, retObj) {
					if (err) throw err;

					assert.strictEqual(retObj.cmdId,	2147483650);
					assert.strictEqual(retObj.cmdStatus,	'ESME_ROK');
					assert.strictEqual(retObj.cmdName,	'bind_transmitter_resp');
					assert.strictEqual(retObj.params.system_id,	'SMPP3TEST');

					done();
				});
			});
		});

		it('should read a submit_sm with an ending NULL octet to the short_message', function (done) {
			const	pdu	= new Buffer('0000003c0000000400000000000000020001003436373031313333313131000101343637303937373133333700000000000000000100047465737400', 'hex');

			larvitsmpp.utils.pduToObj(pdu, function (err, obj) {
				if (err) throw err;

				assert.strictEqual(obj.params.short_message,	'test');
				assert.strictEqual(obj.cmdLength,	60);

				done();
			});
		});

		it('should read a submit_sm without an ending NULL octet to the short_message', function (done) {
			const	pdu	= new Buffer('0000003b00000004000000000000000200010034363730313133333131310001013436373039373731333337000000000000000001000474657374', 'hex');

			larvitsmpp.utils.pduToObj(pdu, function (err, obj) {
				if (err) throw err;

				assert.strictEqual(obj.params.short_message,	'test');
				assert.strictEqual(obj.cmdLength,	59);

				done();
			});
		});

		it('should create a very simple submit_sm PDU', function (done) {
			larvitsmpp.utils.objToPdu({
				'cmdName':	'submit_sm',
				'cmdStatus':	'ESME_ROK',
				'seqNr':	12,
				'params': {
					'source_addr':	'46701113311',
					'destination_addr':	'46709771337',
					'short_message':	'Hello world'
				}
			}, function (err, pdu) {
				if (err) throw err;

				assert.strictEqual(pdu.toString('hex'),	'0000004200000004000000000000000c00000034363730313131333331310000003436373039373731333337000000000000000001000b48656c6c6f20776f726c64');

				done();
			});
		});

		it('should create a submit_sm PDU with UCS2 encoding', function (done) {
			larvitsmpp.utils.objToPdu({
				'cmdName':	'submit_sm',
				'cmdStatus':	'ESME_ROK',
				'seqNr':	12,
				'params': {
					'source_addr':	'46701113311',
					'destination_addr':	'46709771337',
					'short_message':	'Hello«»world'
				}
			}, function (err, pdu) {
				if (err) throw err;

				assert.strictEqual(pdu.toString('hex'),	'0000004f00000004000000000000000c00000034363730313131333331310000003436373039373731333337000000000000000008001800480065006c006c006f00ab00bb0077006f0072006c0064');

				done();
			});
		});

		it('should create a submit_sm PDU with esm_class 0x40 and a short_message with UDH in it', function (done) {
			const	msg	= 'hej världen',
				msgBuf	= Buffer.concat([new Buffer('050003010101', 'hex'), new Buffer(msg)]),
				encoding	= larvitsmpp.defs.encodings.detect(msg);

			larvitsmpp.utils.objToPdu({
				'cmdName':	'submit_sm',
				'cmdStatus':	'ESME_ROK',
				'seqNr':	12,
				'params': {
					'esm_class':	0x40,
					'source_addr':	'46701113311',
					'destination_addr':	'46709771337',
					'sm_length':	msgBuf.length,
					'data_coding':	larvitsmpp.defs.consts.ENCODING[encoding],
					'short_message':	msgBuf
				}
			}, function (err, pdu) {
				if (err) throw err;

				larvitsmpp.utils.pduToObj(pdu, function (err, retObj) {
					if (err) throw err;

					assert.strictEqual(retObj.params.short_message.toString('hex'), '05000301010168656a2076c3a4726c64656e');

					done();
				});
			});
		});


		it('should encode and decode integer cstring params correctly', function (done) {
			const pduObj = {
				'cmdName':	'submit_sm_resp',
				'cmdStatus':	'ESME_ROK',
				'seqNr':	2,
				'params': {
					'message_id':	450
				}
			};

			larvitsmpp.utils.objToPdu(pduObj, function (err, pduBuf) {
				if (err) throw err;

				larvitsmpp.utils.pduToObj(pduBuf, function (err, retPduObj) {
					if (err) throw err;

					assert.strictEqual(retPduObj.params.message_id,	'450');

					done();
				});
			});
		});
	});

	describe('TLVs', function () {
		it('should extract TLVs from a PDU', function (done) {
			const	pdu	= new Buffer('000000e9000000050000000002a82e8600010134363730393737313333370000003436373031313133333131000400000000000000007569643a313535303430363231323432313433353835207375623a30303120646c7672643a303031207375626d697420646174653a3135303430363233323420646f6e6520646174653a3135303430363233323420737461743a44454c49565244206572723a3030303020746578743a202062616666042300030300000427000102001e001331353530343036323132343231343335383500141800040000076c145400040000000114160006323430303800', 'hex');

			larvitsmpp.utils.pduToObj(pdu, function (err, obj) {
				if (err) throw err;

				assert.strictEqual(obj.cmdId.toString(16),	'5');
				assert.strictEqual(obj.cmdStatus,	'ESME_ROK');
				assert.strictEqual(obj.seqNr,	44576390);
				assert.strictEqual(obj.params.destination_addr,	'46701113311');
				assert.strictEqual(obj.tlvs.receipted_message_id.tagValue,	'155040621242143585');

				done();
			});
		});

		it('should add TLVs to a PDU', function (done) {
			const pduObj = {
				'cmdName':	'deliver_sm',
				'seqNr':	393,
				'cmdStatus':	'ESME_ROK',
				'params': {
					'source_addr':	'46701113311',
					'destination_addr':	'46709771337',
					'esm_class':	4,
					'short_message':	'random stuff'
				},
				'tlvs': {
					'receipted_message_id': {
						'tagId':	0x001E,
						'tagName':	'receipted_message_id',
						'tagValue':	'293f293'
					},
					'5142': {
						'tagId':	5142,
						'tagName':	'Nils',
						'tagValue':	new Buffer('blajfoo', 'ascii')
					}
				}
			};

			larvitsmpp.utils.objToPdu(pduObj, function (err, pduBuf) {
				if (err) throw err;

				larvitsmpp.utils.pduToObj(pduBuf, function (err, pduObj2) {
					const	unknownTlvBuf	= new Buffer(pduObj2.tlvs['5142'].tagValue, 'hex');

					if (err) throw err;

					assert.notStrictEqual(pduObj2.tlvs.receipted_message_id,	undefined);
					assert.strictEqual(pduObj2.tlvs.receipted_message_id.tagValue,	'293f293');
					assert.strictEqual(unknownTlvBuf.toString('ascii'),	'blajfoo');

					done();
				});
			});
		});

		it('should add some other TLVs to a PDU', function (done) {
			const pduObj = {
				'cmdName':	'deliver_sm',
				'params': {
					'source_addr':	'46701113311',
					'destination_addr':	'46709771337',
					'esm_class':	4,
					'short_message':	'id:450 sub:001 dlvrd:1 submit date:1504031342 done date:1504031342 stat:DELIVRD err:0 text:xxx'
				},
				'tlvs': {
					'receipted_message_id': {
						'tagId':	30,
						'tagName':	'receipted_message_id',
						'tagValue':	450
					},
					'message_state': {
						'tagId':	1063,
						'tagName':	'message_state',
						'tagValue':	2
					}
				},
				'seqNr':	323
			};

			larvitsmpp.utils.objToPdu(pduObj, function (err, pduBuf) {
				if (err) throw err;

				larvitsmpp.utils.pduToObj(pduBuf, function (err, retPduObj) {
					if (err) throw err;

					assert.strictEqual(retPduObj.params.short_message,	'id:450 sub:001 dlvrd:1 submit date:1504031342 done date:1504031342 stat:DELIVRD err:0 text:xxx');
					assert.strictEqual(retPduObj.cmdName,	'deliver_sm');
					assert.notStrictEqual(retPduObj.tlvs.message_state,	undefined);
					assert.strictEqual(retPduObj.tlvs.message_state.tagValue,	2);
					assert.notStrictEqual(retPduObj.tlvs.receipted_message_id,	undefined);
					assert.strictEqual(retPduObj.tlvs.receipted_message_id.tagValue,	'450');
					assert.strictEqual(retPduObj.seqNr,	323);

					done();
				});
			});
		});
	});

	describe('Return PDUs', function () {
		it('should create a basic and valid return PDU', function (done) {
			const pduObj = {
				'cmdName':	'deliver_sm',
				'seqNr':	393,
				'cmdStatus':	'ESME_ROK',
				'params': {
					'source_addr':	'46701113311',
					'destination_addr':	'46709771337',
					'esm_class':	4,
					'short_message':	'random stuff',
					'message_id':	'od9s2'
				},
				'tlvs': {
					'receipted_message_id': {
						'tagId':	0x001E,
						'tagName':	'receipted_message_id',
						'tagValue':	'293f293'
					},
					'5142': {
						'tagId':	5142,
						'tagName':	'Nils',
						'tagValue':	new Buffer('blajfoo', 'ascii')
					}
				}
			};

			larvitsmpp.utils.pduReturn(pduObj, function (err, pduBuffer) {
				if (err) throw err;

				larvitsmpp.utils.pduToObj(pduBuffer, function (err, retPduObj) {
					if (err) throw err;

					assert.strictEqual(retPduObj.cmdName,	'deliver_sm_resp');
					assert.strictEqual(retPduObj.cmdStatus,	'ESME_ROK');
					assert.strictEqual(retPduObj.params.message_id,	'od9s2');

					done();
				});
			});
		});

		it('should create a valid return PDU with custom param', function (done) {
			const pduObj = {
				'cmdName':	'deliver_sm',
				'seqNr':	393,
				'cmdStatus':	'ESME_ROK',
				'params': {
					'source_addr':	'46701113311',
					'destination_addr':	'46709771337',
					'esm_class':	4,
					'short_message':	'random stuff',
					'message_id':	'od9s2'
				},
				'tlvs': {
					'receipted_message_id': {
						'tagId':	0x001E,
						'tagName':	'receipted_message_id',
						'tagValue':	'293f293'
					},
					'5142': {
						'tagId':	5142,
						'tagName':	'Nils',
						'tagValue':	new Buffer('blajfoo', 'ascii')
					}
				}
			};

			larvitsmpp.utils.pduReturn(pduObj, 'ESME_RINVMSGID', {'message_id': 'mep'}, function (err, pduBuffer) {
				if (err) throw err;

				larvitsmpp.utils.pduToObj(pduBuffer, function (err, retPduObj) {
					if (err) throw err;

					assert.strictEqual(retPduObj.cmdName,	'deliver_sm_resp');
					assert.strictEqual(retPduObj.cmdStatus,	'ESME_RINVMSGID');
					assert.strictEqual(retPduObj.params.message_id,	'mep');

					done();
				});
			});
		});
	});

	describe('Message size and split', function () {
		it('should calculate sizes of msgs', function (done) {
			const	a	= 'abcd',
				b	= 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
				c	= 'Ledds med « df BLAH och därför är alla hjul runda fast bara några hihi',
				d	= 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdHIHIHIHI foobar',
				e	= 'Ledds med « df BLAH och därför är alla hjul runda fast bara några hihi Ledds med « df BLAH och därför är alla hjul runda fast bara några hihi Ledds med « df BLAH och därför är alla hjul runda fast bara några hihi Ledds med « df BLAH och därför är alla hjul runda fast bara några hihi',
				f	= 'abcd€abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
				g	= 'Ledds med « df BLAH och därför är alla hjul runda fast bara några hihi bara lite längre';

			assert.strictEqual(larvitsmpp.utils.bitCount(a),	28);
			assert.strictEqual(larvitsmpp.utils.bitCount(b),	1120);
			assert.strictEqual(larvitsmpp.utils.bitCount(b, 'UCS2'),	2560);
			assert.strictEqual(larvitsmpp.utils.bitCount(c),	1120);
			assert.strictEqual(larvitsmpp.utils.bitCount(d),	1225);
			assert.strictEqual(larvitsmpp.utils.bitCount(e),	4528);
			assert.strictEqual(larvitsmpp.utils.bitCount(f),	1120);
			assert.strictEqual(larvitsmpp.utils.bitCount(g),	1392);
			assert.strictEqual(larvitsmpp.utils.splitMsg(a).length,	1);
			assert.strictEqual(larvitsmpp.utils.splitMsg(b).length,	1);
			assert.strictEqual(larvitsmpp.utils.splitMsg(b, 'UCS2').length,	3);
			assert.strictEqual(larvitsmpp.utils.splitMsg(c).length,	1);
			assert.strictEqual(larvitsmpp.utils.splitMsg(d).length,	2);
			assert.strictEqual(larvitsmpp.utils.splitMsg(e).length,	5);
			assert.strictEqual(larvitsmpp.utils.splitMsg(f).length,	1);
			assert.strictEqual(larvitsmpp.utils.splitMsg(g).length,	2);

			done();
		});

		it('should return an array with a buffer equalling the input msg', function (done) {
			const	msg	= 'hello world',
				msgs	= larvitsmpp.utils.splitMsg(msg);

			assert.strictEqual(msgs[0].toString(),	msg);
			done();
		});
	});
});
