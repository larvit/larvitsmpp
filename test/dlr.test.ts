import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { consts } from '../src/defs/constants.ts';
import { dlrFromPdu, parseReceipt, receiptCodes } from '../src/dlr.ts';
import { objToPdu, pduToObj } from '../src/pdu.ts';
import type { PduObject, TlvInput } from '../src/pdu.ts';

const receiptText = 'id:0195f0c7 sub:001 dlvrd:001 submit date:2508251430 done date:2508251431 stat:DELIVRD err:000 text:hello there';

function deliverSm(
	message: Buffer | string,
	tlvs?: Record<string, TlvInput>,
	esmClass: number = consts.ESM_CLASS.MC_DELIVERY_RECEIPT,
): PduObject {
	const { buffer } = objToPdu({
		cmdName: 'deliver_sm',
		params: {
			destination_addr: '46701113311',
			esm_class: esmClass,
			short_message: message,
			source_addr: '46709771337',
		},
		seqNr: 1,
		tlvs,
	});

	assert.ok(buffer);

	const { pduObj } = pduToObj(buffer);

	assert.ok(pduObj);

	return pduObj;
}

describe('parseReceipt()', () => {
	test('pulls every standard field out of the receipt body', () => {
		const receipt = parseReceipt(receiptText);

		assert.equal(receipt.id, '0195f0c7');
		assert.equal(receipt.sub, 1);
		assert.equal(receipt.dlvrd, 1);
		assert.equal(receipt.submitDate, '2508251430');
		assert.equal(receipt.doneDate, '2508251431');
		assert.equal(receipt.stat, 'DELIVRD');
		assert.equal(receipt.err, '000');
		assert.equal(receipt.text, 'hello there');
	});

	test('takes any whitespace between the fields, not only a space', () => {
		const wrapped = 'id:0195f0c7\r\nsub:001\ndlvrd:001\tsubmit date:2508251430\r\ndone date:2508251431'
			+ '\r\nstat:DELIVRD\r\nerr:000\r\ntext:hello there\r\n';

		assert.deepEqual(parseReceipt(wrapped), parseReceipt(receiptText));
	});

	test('does not confuse "done date" with "submit date"', () => {
		const receipt = parseReceipt(receiptText);

		assert.notEqual(receipt.submitDate, receipt.doneDate);
	});

	test('leaves absent fields undefined rather than guessing', () => {
		const receipt = parseReceipt('id:abc stat:UNDELIV');

		assert.equal(receipt.id, 'abc');
		assert.equal(receipt.stat, 'UNDELIV');
		assert.equal(receipt.sub, undefined);
		assert.equal(receipt.doneDate, undefined);
	});
});

describe('dlrFromPdu()', () => {
	test('prefers the TLVs when the peer sends them', () => {
		const dlr = dlrFromPdu(deliverSm(receiptText, {
			message_state: { tagValue: 5 },
			receipted_message_id: { tagValue: 'from-the-tlv' },
		}));

		assert.ok(dlr);
		assert.equal(dlr.smsId, 'from-the-tlv');
		assert.equal(dlr.statusId, 5);
		assert.equal(dlr.statusMsg, 'UNDELIVERABLE');
	});

	// 0.4.0 answered ESME_RINVTLVSTREAM unless both TLVs were present, so Kannel-style receipts —
	// text only, no TLVs — were unusable.
	test('falls back to the receipt text when there are no TLVs', () => {
		const dlr = dlrFromPdu(deliverSm(receiptText));

		assert.ok(dlr);
		assert.equal(dlr.smsId, '0195f0c7');
		assert.equal(dlr.statusMsg, 'DELIVERED');
		assert.equal(dlr.statusId, 2);
		assert.equal(dlr.errorCode, '000');
		assert.equal(dlr.doneDate?.toISOString(), '2025-08-25T14:31:00.000Z');
	});

	test('maps every spec status code back to its message state and id', () => {
		for (const [code, expected, statusId] of [
			['DELIVRD', 'DELIVERED', 2],
			['UNDELIV', 'UNDELIVERABLE', 5],
			['EXPIRED', 'EXPIRED', 3],
			['DELETED', 'DELETED', 4],
			['ACCEPTD', 'ACCEPTED', 6],
			['REJECTD', 'REJECTED', 8],
			['ENROUTE', 'ENROUTE', 1],
			['UNKNOWN', 'UNKNOWN', 7],
			['delivrd', 'DELIVERED', 2],
		] as const) {
			const dlr = dlrFromPdu(deliverSm(`id:x stat:${code} err:0`));

			assert.ok(dlr);
			assert.equal(dlr.statusMsg, expected);
			assert.equal(dlr.statusId, statusId);
		}
	});

	test('leaves an impossible receipt date undefined rather than rolling it over', () => {
		const rolled = dlrFromPdu(deliverSm('id:x stat:DELIVRD done date:9902310000'));

		assert.ok(rolled);
		assert.equal(rolled.doneDate, undefined);
		assert.equal(dlrFromPdu(deliverSm('id:x stat:DELIVRD done date:2501012560'))?.doneDate, undefined);
	});

	test('returns nothing when an unmarked deliver_sm yields no id or no status', () => {
		assert.equal(dlrFromPdu(deliverSm('just a normal sms', undefined, 0)), undefined);
		assert.equal(dlrFromPdu(deliverSm('id:0195f0c7 stat:WEIRDXX', undefined, 0)), undefined);
	});

	test('still reads the body when the peer marks no message type', () => {
		const dlr = dlrFromPdu(deliverSm(receiptText, undefined, 0));

		assert.ok(dlr);
		assert.equal(dlr.smsId, '0195f0c7');
		assert.equal(dlr.statusMsg, 'DELIVERED');
	});

	test('reports a marked receipt whose body it cannot read, rather than an inbound message', () => {
		const dlr = dlrFromPdu(deliverSm('a receipt in a format nobody documented'));

		assert.ok(dlr);
		assert.equal(dlr.smsId, undefined);
		assert.equal(dlr.statusMsg, 'UNKNOWN');
		assert.equal(dlr.statusId, 7);
	});

	// pduToObj leaves a UDH-carrying short_message a buffer, so the body needs decoding before it
	// can be read at all — and the message type sits under the UDH indicator in the same octet.
	test('reads the body of a receipt that carries a UDH', () => {
		const udh = Buffer.from([0x05, 0x00, 0x03, 0x2a, 0x01, 0x01]);
		const body = Buffer.concat([udh, Buffer.from(receiptText, 'ascii')]);
		const dlr = dlrFromPdu(deliverSm(
			body,
			undefined,
			consts.ESM_CLASS.MC_DELIVERY_RECEIPT | consts.ESM_CLASS.UDH_INDICATOR,
		));

		assert.ok(dlr);
		assert.equal(dlr.smsId, '0195f0c7');
		assert.equal(dlr.statusMsg, 'DELIVERED');
	});

	// message_state 0x80-0xFF is reserved for MC-vendor-specific values, which we cannot name.
	test('falls back to the body when the state TLV carries a value it cannot name', () => {
		const dlr = dlrFromPdu(deliverSm(receiptText, { message_state: { tagValue: 0x84 } }));

		assert.ok(dlr);
		assert.equal(dlr.statusId, 0x84);
		assert.equal(dlr.statusMsg, 'DELIVERED');
	});

	test('takes a receipted_message_id TLV as a receipt marker of its own', () => {
		const dlr = dlrFromPdu(deliverSm('nothing scrapable here', {
			receipted_message_id: { tagValue: 'from-the-tlv' },
		}, 0));

		assert.ok(dlr);
		assert.equal(dlr.smsId, 'from-the-tlv');
		assert.equal(dlr.statusMsg, 'UNKNOWN');

		const empty = dlrFromPdu(deliverSm('an ordinary inbound message', {
			receipted_message_id: { tagValue: '' },
		}, 0));

		assert.equal(empty, undefined, 'an empty id marks nothing');
	});

	test('keeps the body scrape for a message type the spec reserves', () => {
		const dlr = dlrFromPdu(deliverSm(receiptText, undefined, 0x0c));

		assert.ok(dlr);
		assert.equal(dlr.smsId, '0195f0c7');
		assert.equal(dlr.statusMsg, 'DELIVERED');
	});

	test('leaves a message the peer marked as another type to arrive as an SMS', () => {
		for (const esmClass of [
			consts.ESM_CLASS.CONVERSATION_ABORT,
			consts.ESM_CLASS.DELIVERY_ACKNOWLEDGEMENT,
			consts.ESM_CLASS.INTERMEDIATE_DELIVERY,
			consts.ESM_CLASS.USER_ACKNOWLEDGEMENT,
		]) {
			assert.equal(dlrFromPdu(deliverSm(receiptText, undefined, esmClass)), undefined);
		}
	});

	test('exposes the raw receipt alongside the resolved fields', () => {
		const dlr = dlrFromPdu(deliverSm(receiptText));

		assert.ok(dlr?.receipt);
		assert.equal(dlr.receipt.sub, 1);
		assert.equal(dlr.receipt.text, 'hello there');
	});

	test('reads the id in the notation the peer writes receipts in', () => {
		const hex = dlrFromPdu(deliverSm('id:1a2B stat:DELIVRD err:000 text:'), { receipt: 'hex' });

		assert.ok(hex);
		assert.equal(hex.smsId, '6699');
		assert.equal(hex.receipt?.id, '1a2B', 'the receipt itself keeps the id as it arrived');

		assert.equal(dlrFromPdu(deliverSm('id:0000123 stat:DELIVRD'), { receipt: 'decimal' })?.smsId, '123');
	});

	// SMPP 3.4 5.3.2.26 makes the TLV the id the submit_sm_resp carried, not the body's rendering.
	test('reads the receipted_message_id TLV in the notation the peer answers a submit in', () => {
		const marked = deliverSm('nothing scrapable here', {
			receipted_message_id: { tagValue: 'FF' },
		}, 0);

		assert.equal(dlrFromPdu(marked, { submitResp: 'hex' })?.smsId, '255');
		assert.equal(dlrFromPdu(marked, { receipt: 'hex' })?.smsId, 'FF');
	});

	test('leaves an id the notation cannot read as it arrived', () => {
		assert.equal(dlrFromPdu(deliverSm('id:beef-1 stat:DELIVRD'), { receipt: 'hex' })?.smsId, 'beef-1');
		assert.equal(dlrFromPdu(deliverSm('id:1a2b stat:DELIVRD'), { receipt: 'decimal' })?.smsId, '1a2b');
		assert.equal(dlrFromPdu(deliverSm('id:0195f0c7 stat:DELIVRD'))?.smsId, '0195f0c7');
	});

	// Number() reads 9007199254740993 as ...92, which correlates a receipt to the wrong send.
	test('reads an id past the safe integer range without losing a digit', () => {
		assert.equal(
			dlrFromPdu(deliverSm('id:9007199254740993 stat:DELIVRD'), { receipt: 'decimal' })?.smsId,
			'9007199254740993',
		);
	});
});

describe('receiptCodes', () => {
	// 0.4.0 wrote stat:UNDELIVERABLE, which is not the spec's seven-character field.
	test('are the seven-character codes the spec defines', () => {
		assert.equal(receiptCodes.DELIVERED, 'DELIVRD');
		assert.equal(receiptCodes.UNDELIVERABLE, 'UNDELIV');

		for (const code of Object.values(receiptCodes)) {
			assert.equal(code.length, 7);
		}
	});
});
