import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { normaliseSmsId } from '../src/sms-id.ts';

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
