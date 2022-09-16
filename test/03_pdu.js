"use strict";

const test = require("tape");
const larvitsmpp = require(__dirname + "/../index.js");

test("3. PDU", t => t.end());
test("3.1. PDU convertion", t => t.end());
test("3.1.1. No TLVs", t => t.end());

test("3.1.1.1. Should build a PDU buffer for bind_transceiver_resp with error correctly", t => {
	larvitsmpp.utils.objToPdu({
		cmdName: "bind_transceiver_resp",
		cmdStatus: "ESME_RALYBND",
		seqNr: 1,
	}, (err, pdu) => {
		if (err) throw err;

		t.strictEqual(pdu.readUInt32BE(0), 17, "readUInt32BE(0) -> 17");
		t.strictEqual(pdu.readUInt32BE(4).toString(16), "80000009", "readUInt32BE(4) -> 80000009");
		t.strictEqual(pdu.readUInt32BE(8).toString(16), "5", "readUInt32BE(8) -> 5");
		t.strictEqual(pdu.readUInt32BE(12).toString(10), "1", "readUInt32BE(12) -> 1");

		t.end();
	});
});

test("3.1.1.2. Should be able to do the above test and put it back to an object", t => {
	larvitsmpp.utils.objToPdu({
		cmdName: "bind_transceiver_resp",
		cmdStatus: "ESME_RALYBND",
		seqNr: 1,
	}, (err, pdu) => {
		if (err) throw err;

		larvitsmpp.utils.pduToObj(pdu, (err, obj) => {
			if (err) throw err;

			t.strictEqual(obj.cmdId.toString(16), "80000009", "obj.cmdId.toString(16) -> 80000009");
			t.strictEqual(obj.cmdStatus, "ESME_RALYBND", "obj.cmdStatus -> ESME_RALYBND");
			t.strictEqual(obj.seqNr, 1, "obj.seqNr -> 1");

			t.end();
		});
	});
});

test("3.1.1.3. Should parse a PDU to obj correctly", t => {
	const pdu = Buffer.from("0000002F000000020000000000000001534D50503354455354007365637265743038005355424D4954310000010100", "hex");

	larvitsmpp.utils.pduToObj(pdu, (err, obj) => {
		if (err) throw err;

		t.strictEqual(obj.cmdId, 2, "obj.cmdId -> 2");
		t.strictEqual(obj.cmdStatus, "ESME_ROK", "obj.cmdStatus -> ESME_ROK");
		t.strictEqual(obj.cmdName, "bind_transmitter", "obj.cmdName -> bind_transmitter");
		t.strictEqual(obj.params.system_id, "SMPP3TEST", "obj.params.system_id -> SMPP3TEST");
		t.strictEqual(obj.params.interface_version, 0, "obj.params.interface_version -> 0");

		t.end();
	});
});

test("3.1.1.4. Should create a return PDU without error", t => {
	const pdu = Buffer.from("0000002f000000020000000000000001534d50503354455354007365637265743038005355424d4954310000010100", "hex");

	larvitsmpp.utils.pduReturn(pdu, (err, retPdu) => {
		if (err) throw err;

		larvitsmpp.utils.pduToObj(retPdu, (err, retObj) => {
			if (err) throw err;

			t.strictEqual(retObj.cmdId, 2147483650, "retObj.cmdId -> 2147483650");
			t.strictEqual(retObj.cmdStatus, "ESME_ROK", "retObj.cmdStatus -> ESME_ROK");
			t.strictEqual(retObj.cmdName, "bind_transmitter_resp", "retObj.cmdName -> bind_transmitter_resp");
			t.strictEqual(retObj.params.system_id, "SMPP3TEST", "retObj.params.system_id -> SMPP3TEST");

			t.end();
		});
	});
});

test("3.1.1.5. Should read a submit_sm with an ending NULL octet to the short_message", t => {
	const pdu = Buffer.from("0000003c0000000400000000000000020001003436373031313333313131000101343637303937373133333700000000000000000100047465737400", "hex");

	larvitsmpp.utils.pduToObj(pdu, (err, obj) => {
		if (err) throw err;

		t.strictEqual(obj.params.short_message, "test", "obj.params.short_message -> test");
		t.strictEqual(obj.cmdLength, 60, "obj.cmdLength -> 60");

		t.end();
	});
});

test("3.1.1.6. Should read a submit_sm without an ending NULL octet to the short_message", t => {
	const pdu = Buffer.from("0000003b00000004000000000000000200010034363730313133333131310001013436373039373731333337000000000000000001000474657374", "hex");

	larvitsmpp.utils.pduToObj(pdu, (err, obj) => {
		if (err) throw err;

		t.strictEqual(obj.params.short_message, "test", "obj.params.short_message -> test");
		t.strictEqual(obj.cmdLength, 59, "obj.cmdLength -> 59");

		t.end();
	});
});

test("3.1.1.7. Should create a very simple submit_sm PDU", t => {
	larvitsmpp.utils.objToPdu({
		cmdName: "submit_sm",
		cmdStatus: "ESME_ROK",
		params: {
			destination_addr: "46709771337",
			short_message: "Hello world",
			source_addr: "46701113311",
		},
		seqNr: 12,
	}, (err, pdu) => {
		if (err) throw err;

		t.strictEqual(
			pdu.toString("hex"),
			"0000004200000004000000000000000c00000034363730313131333331310000003436373039373731333337000000000000000001000b48656c6c6f20776f726c64",
			"PDU hex should match as expected.",
		);

		t.end();
	});
});

test("3.1.1.8. Should create a submit_sm PDU with UCS2 encoding", t => {
	larvitsmpp.utils.objToPdu({
		cmdName: "submit_sm",
		cmdStatus: "ESME_ROK",
		params: {
			destination_addr: "46709771337",
			short_message: "Hello«»world",
			source_addr: "46701113311",
		},
		seqNr: 12,
	}, (err, pdu) => {
		if (err) throw err;

		t.strictEqual(
			pdu.toString("hex"),
			"0000004f00000004000000000000000c00000034363730313131333331310000003436373039373731333337000000000000000008001800480065006c006c006f00ab00bb0077006f0072006c0064",
			"PDU hex should match as expected.",
		);

		t.end();
	});
});

test("3.1.1.9. Should create a submit_sm PDU with esm_class 0x40 and a short_message with UDH in it", t => {
	const msg = "hej världen";
	const msgBuf = Buffer.concat([Buffer.from("050003010101", "hex"), Buffer.from(msg)]);
	const encoding = larvitsmpp.defs.encodings.detect(msg);

	larvitsmpp.utils.objToPdu({
		cmdName: "submit_sm",
		cmdStatus: "ESME_ROK",
		params: {
			data_coding: larvitsmpp.defs.consts.ENCODING[encoding],
			destination_addr: "46709771337",
			esm_class: 0x40,
			short_message: msgBuf,
			sm_length: msgBuf.length,
			source_addr: "46701113311",
		},
		seqNr: 12,
	}, (err, pdu) => {
		if (err) throw err;

		larvitsmpp.utils.pduToObj(pdu, (err, retObj) => {
			if (err) throw err;

			t.strictEqual(
				retObj.params.short_message.toString("hex"),
				"05000301010168656a2076c3a4726c64656e",
				"PDU hex should match as expected.",
			);

			t.end();
		});
	});
});

test("3.1.1.10. Should encode and decode integer cstring params correctly", t => {
	const pduObj = {
		cmdName: "submit_sm_resp",
		cmdStatus: "ESME_ROK",
		params: {
			message_id: 450,
		},
		seqNr: 2,
	};

	larvitsmpp.utils.objToPdu(pduObj, (err, pduBuf) => {
		if (err) throw err;

		larvitsmpp.utils.pduToObj(pduBuf, (err, retPduObj) => {
			if (err) throw err;

			t.strictEqual(retPduObj.params.message_id, "450", "message_id -> 450");

			t.end();
		});
	});
});

test("3.1.2. TLVs", t => t.end());

test("3.1.2.1. Should extract TLVs from a PDU", t => {
	const pdu = Buffer.from("000000e9000000050000000002a82e8600010134363730393737313333370000003436373031313133333131000400000000000000007569643a313535303430363231323432313433353835207375623a30303120646c7672643a303031207375626d697420646174653a3135303430363233323420646f6e6520646174653a3135303430363233323420737461743a44454c49565244206572723a3030303020746578743a202062616666042300030300000427000102001e001331353530343036323132343231343335383500141800040000076c145400040000000114160006323430303800", "hex");

	larvitsmpp.utils.pduToObj(pdu, (err, obj) => {
		if (err) throw err;

		t.strictEqual(obj.cmdId.toString(16), "5", "obj.cmdId.toString(16) -> 5");
		t.strictEqual(obj.cmdStatus, "ESME_ROK", "obj.cmdStatus -> ESME_ROK");
		t.strictEqual(obj.seqNr, 44576390, "obj.seqNr -> 44576390");
		t.strictEqual(obj.params.destination_addr, "46701113311", "obj.params.destination_addr -> 46701113311");
		t.strictEqual(
			obj.tlvs.receipted_message_id.tagValue,
			"155040621242143585",
			"obj.tlvs.receipted_message_id.tagValue -> 155040621242143585",
		);

		t.end();
	});
});

test("3.1.2.2. Should add TLVs to a PDU", t => {
	const pduObj = {
		cmdName: "deliver_sm",
		cmdStatus: "ESME_ROK",
		params: {
			destination_addr: "46709771337",
			esm_class: 4,
			short_message: "random stuff",
			source_addr: "46701113311",
		},
		seqNr: 393,
		tlvs: {
			5142: {
				tagId: 5142,
				tagName: "Nils",
				tagValue: Buffer.from("blajfoo", "ascii"),
			},
			receipted_message_id: {
				tagId: 0x001E,
				tagName: "receipted_message_id",
				tagValue: "293f293",
			},
		},
	};

	larvitsmpp.utils.objToPdu(pduObj, (err, pduBuf) => {
		if (err) throw err;

		larvitsmpp.utils.pduToObj(pduBuf, (err, pduObj2) => {
			const unknownTlvBuf = Buffer.from(pduObj2.tlvs["5142"].tagValue, "hex");

			if (err) throw err;

			t.notStrictEqual(pduObj2.tlvs.receipted_message_id, undefined, "pduObj2.tlvs.receipted_message_id should be set.");
			t.strictEqual(pduObj2.tlvs.receipted_message_id.tagValue, "293f293", "pduObj2.tlvs.receipted_message_id.tagValue -> 293f293");
			t.strictEqual(unknownTlvBuf.toString("ascii"), "blajfoo", "unknownTlvBuf.toString('ascii') -> blajfoo");

			t.end();
		});
	});
});

test("3.1.2.3. Should add some other TLVs to a PDU", t => {
	const pduObj = {
		cmdName: "deliver_sm",
		params: {
			destination_addr: "46709771337",
			esm_class: 4,
			short_message: "id:450 sub:001 dlvrd:1 submit date:1504031342 done date:1504031342 stat:DELIVRD err:0 text:xxx",
			source_addr: "46701113311",
		},
		seqNr: 323,
		tlvs: {
			message_state: {
				tagId: 1063,
				tagName: "message_state",
				tagValue: 2,
			},
			receipted_message_id: {
				tagId: 30,
				tagName: "receipted_message_id",
				tagValue: 450,
			},
		},
	};

	larvitsmpp.utils.objToPdu(pduObj, (err, pduBuf) => {
		if (err) throw err;

		larvitsmpp.utils.pduToObj(pduBuf, (err, retPduObj) => {
			if (err) throw err;

			t.strictEqual(
				retPduObj.params.short_message,
				"id:450 sub:001 dlvrd:1 submit date:1504031342 done date:1504031342 stat:DELIVRD err:0 text:xxx",
				"short_message should match",
			);
			t.strictEqual(retPduObj.cmdName, "deliver_sm", "cmdName -> deliver_sm");
			t.notStrictEqual(retPduObj.tlvs.message_state, undefined, "retPduObj.tlvs.message_state should be set.");
			t.strictEqual(retPduObj.tlvs.message_state.tagValue, 2, "tlvs.message_state.tagValue -> 2");
			t.notStrictEqual(retPduObj.tlvs.receipted_message_id, undefined, "retPduObj.tlvs.receipted_message_id should be set.");
			t.strictEqual(retPduObj.tlvs.receipted_message_id.tagValue, "450", "tlvs.receipted_message_id.tagValue -> 450");
			t.strictEqual(retPduObj.seqNr, 323, "seqNr -> 323");

			t.end();
		});
	});
});

test("3.1.3. Return PDUs", t => t.end());

test("3.1.3.1. Should create a basic and valid return PDU", t => {
	const pduObj = {
		cmdName: "deliver_sm",
		cmdStatus: "ESME_ROK",
		params: {
			destination_addr: "46709771337",
			esm_class: 4,
			message_id: "od9s2",
			short_message: "random stuff",
			source_addr: "46701113311",
		},
		seqNr: 393,
		tlvs: {
			5142: {
				tagId: 5142,
				tagName: "Nils",
				tagValue: Buffer.from("blajfoo", "ascii"),
			},
			receipted_message_id: {
				tagId: 0x001E,
				tagName: "receipted_message_id",
				tagValue: "293f293",
			},
		},
	};

	larvitsmpp.utils.pduReturn(pduObj, (err, pduBuffer) => {
		if (err) throw err;

		larvitsmpp.utils.pduToObj(pduBuffer, (err, retPduObj) => {
			if (err) throw err;

			t.strictEqual(retPduObj.cmdName, "deliver_sm_resp", "cmdName -> deliver_sm_resp");
			t.strictEqual(retPduObj.cmdStatus, "ESME_ROK", "cmdStatus -> ESME_ROK");
			t.strictEqual(retPduObj.params.message_id, "od9s2", "params.message_id -> od9s2");

			t.end();
		});
	});
});

test("3.1.3.2. Should create a valid return PDU with custom param", t => {
	const pduObj = {
		cmdName: "deliver_sm",
		cmdStatus: "ESME_ROK",
		params: {
			destination_addr: "46709771337",
			esm_class: 4,
			message_id: "od9s2",
			short_message: "random stuff",
			source_addr: "46701113311",
		},
		seqNr: 393,
		tlvs: {
			5142: {
				tagId: 5142,
				tagName: "Nils",
				tagValue: Buffer.from("blajfoo", "ascii"),
			},
			receipted_message_id: {
				tagId: 0x001E,
				tagName: "receipted_message_id",
				tagValue: "293f293",
			},
		},
	};

	larvitsmpp.utils.pduReturn(pduObj, "ESME_RINVMSGID", { message_id: "mep" }, (err, pduBuffer) => {
		if (err) throw err;

		larvitsmpp.utils.pduToObj(pduBuffer, (err, retPduObj) => {
			if (err) throw err;

			t.strictEqual(retPduObj.cmdName, "deliver_sm_resp", "cmdName -> deliver_sm_resp");
			t.strictEqual(retPduObj.cmdStatus, "ESME_RINVMSGID", "cmdStatus -> ESME_RINVMSGID");
			t.strictEqual(retPduObj.params.message_id, "mep", "params.message_id -> mep");

			t.end();
		});
	});
});

test("3.1.4. Message size and split", t => t.end());

test("3.1.4.1. Should calculate sizes of msgs", t => {
	/* eslint-disable id-length */
	const a = "abcd";
	const b = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";
	const c = "Ledds med « df BLAH och därför är alla hjul runda fast bara några hihi";
	const d = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdHIHIHIHI foobar";
	const e = "Ledds med « df BLAH och därför är alla hjul runda fast bara några hihi Ledds med « df BLAH och därför är alla hjul runda fast bara några hihi Ledds med « df BLAH och därför är alla hjul runda fast bara några hihi Ledds med « df BLAH och därför är alla hjul runda fast bara några hihi";
	const f = "abcd€abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";
	const g = "Ledds med « df BLAH och därför är alla hjul runda fast bara några hihi bara lite längre";

	t.strictEqual(larvitsmpp.utils.bitCount(a), 28, "bitCount(a) -> 28");
	t.strictEqual(larvitsmpp.utils.bitCount(b), 1120, "bitCount(b) -> 1120");
	t.strictEqual(larvitsmpp.utils.bitCount(b, "UCS2"), 2560, "bitCount(b, UCS2) -> 2560");
	t.strictEqual(larvitsmpp.utils.bitCount(c), 1120, "bitCount(c) -> 1120");
	t.strictEqual(larvitsmpp.utils.bitCount(d), 1225, "bitCount(d) -> 1225");
	t.strictEqual(larvitsmpp.utils.bitCount(e), 4528, "bitCount(e) -> 4528");
	t.strictEqual(larvitsmpp.utils.bitCount(f), 1120, "bitCount(f) -> 1120");
	t.strictEqual(larvitsmpp.utils.bitCount(g), 1392, "bitCount(g) -> 1392");
	t.strictEqual(larvitsmpp.utils.splitMsg(a).length, 1, "splitMsg(a).length -> 1");
	t.strictEqual(larvitsmpp.utils.splitMsg(b).length, 1, "splitMsg(b).length -> 1");
	t.strictEqual(larvitsmpp.utils.splitMsg(b, "UCS2").length, 3, "splitMsg(b, UCS2).length -> 3");
	t.strictEqual(larvitsmpp.utils.splitMsg(c).length, 1, "splitMsg(c).length -> 1");
	t.strictEqual(larvitsmpp.utils.splitMsg(d).length, 2, "splitMsg(d).length -> 2");
	t.strictEqual(larvitsmpp.utils.splitMsg(e).length, 5, "splitMsg(e).length -> 5");
	t.strictEqual(larvitsmpp.utils.splitMsg(f).length, 1, "splitMsg(f).length -> 1");
	t.strictEqual(larvitsmpp.utils.splitMsg(g).length, 2, "splitMsg(g).length -> 2");
	/* eslint-enable */

	t.end();
});

test("3.1.4.2. Should return an array with a buffer equalling the input msg", t => {
	const msg = "hello world";
	const msgs = larvitsmpp.utils.splitMsg(msg);

	t.strictEqual(msgs[0].toString(), msg, "First splitted message part should be same as full message.");

	t.end();
});
