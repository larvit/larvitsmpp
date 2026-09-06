import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { normaliseSmsId, parseSegmentId, respIdParams, segmentId } from '../src/sms-id.ts';

describe('normaliseSmsId()', () => {
	test('reads an id the length a message_id may be, and leaves a longer one alone', () => {
		const padded = `0${'1'.repeat(63)}`;
		const tooLong = `0${'1'.repeat(64)}`;

		assert.equal(normaliseSmsId(padded, 'decimal'), '1'.repeat(63));
		assert.equal(normaliseSmsId(tooLong, 'decimal'), tooLong);
	});

	test('leaves an id the notation cannot read as it arrived', () => {
		assert.equal(normaliseSmsId('', 'hex'), '');
		assert.equal(normaliseSmsId('0x1f', 'hex'), '0x1f');
		assert.equal(normaliseSmsId('beef-1', 'hex'), 'beef-1', 'the segment convention stays whole');
	});

	test('reads either case of a hexadecimal id', () => {
		assert.equal(normaliseSmsId('1a2B', 'hex'), normaliseSmsId('1A2b', 'hex'));
	});
});

describe('the <base>-<n> a segment is answered with', () => {
	const base = '0199e0ed-3a55-7e91-9c04-6b7f2d81a5e2';

	// One writer, two readers: DlrMerger has to read back exactly what a segment was answered with.
	test('reads back the base and the part it was written from', () => {
		assert.equal(segmentId(base, 0, 1), base, 'a lone segment is the base itself');
		assert.equal(segmentId(base, 2, 3), `${base}-3`);
		assert.deepEqual(parseSegmentId(`${base}-3`), { base, part: 3 });
	});

	test('reads nothing out of an id no segment convention wrote', () => {
		assert.equal(parseSegmentId(base), undefined);
		assert.equal(parseSegmentId(`${base}-x`), undefined);
		assert.equal(parseSegmentId(''), undefined);
	});
});

describe('the id a response carries', () => {
	// SMPP 3.4 4.6.2 makes deliver_sm_resp's message_id unused; Jasmin FINs the link over one.
	test('leaves a deliver_sm_resp without one, and gives submit_sm_resp its own', () => {
		assert.deepEqual(respIdParams('deliver_sm', 'x'), {});
		assert.deepEqual(respIdParams('submit_sm', 'x'), { message_id: 'x' });
	});
});
