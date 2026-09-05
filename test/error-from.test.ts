import assert from 'node:assert/strict';
import test from 'node:test';
import { errorFrom } from '../src/error-from.ts';

test('carries an Error through and describes anything else, including what String() refuses', () => {
	const original = new Error('the original');
	const undescribable: unknown = Object.create(null);

	assert.equal(errorFrom(original), original);
	assert.equal(errorFrom('a string').message, 'a string');
	assert.equal(errorFrom(null).message, 'null');
	assert.equal(errorFrom(undefined).message, 'undefined');
	assert.equal(
		errorFrom(undescribable).message,
		'A thrown value that cannot be converted to a string',
	);
});
