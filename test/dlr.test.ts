import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { dlrFromPdu, parseReceipt, receiptCodes } from '../src/dlr.ts';
import { objToPdu, pduToObj } from '../src/pdu.ts';
import type { PduObject, TlvInput } from '../src/pdu.ts';

const receiptText = 'id:0195f0c7 sub:001 dlvrd:001 submit date:2508251430 done date:2508251431 stat:DELIVRD err:000 text:hello';

function deliverSm(message: string, tlvs?: Record<string, TlvInput>): PduObject {
	const { buffer } = objToPdu({
		cmdName: 'deliver_sm',
		params: {
			destination_addr: '46701113311',
			esm_class: 4,
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
		assert.equal(receipt.text, 'hello');
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

	test('maps every spec status code back to its message state', () => {
		for (const [code, expected] of [
			['DELIVRD', 'DELIVERED'],
			['UNDELIV', 'UNDELIVERABLE'],
			['EXPIRED', 'EXPIRED'],
			['DELETED', 'DELETED'],
			['ACCEPTD', 'ACCEPTED'],
			['REJECTD', 'REJECTED'],
			['ENROUTE', 'ENROUTE'],
			['UNKNOWN', 'UNKNOWN'],
		]) {
			const dlr = dlrFromPdu(deliverSm(`id:x stat:${String(code)} err:0`));

			assert.equal(dlr?.statusMsg, expected);
		}
	});

	test('returns nothing when the PDU identifies no message', () => {
		assert.equal(dlrFromPdu(deliverSm('just a normal sms')), undefined);
	});

	test('exposes the raw receipt alongside the resolved fields', () => {
		const dlr = dlrFromPdu(deliverSm(receiptText));

		assert.ok(dlr?.receipt);
		assert.equal(dlr.receipt.sub, 1);
		assert.equal(dlr.receipt.text, 'hello');
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
