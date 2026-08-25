import assert from 'node:assert/strict';
import test from 'node:test';
import type { Result } from '../src/result.ts';

function parse(input: string): Result<{ value: number }> {
	const value = Number(input);

	if (Number.isNaN(value)) return { err: new Error('not a number') };

	return { value };
}

test('destructuring a result narrows on err', () => {
	const { err, value } = parse('42');

	if (err) {
		assert.fail('should have parsed');
	}

	// Fails to compile if narrowing does not remove undefined from value.
	assert.equal(value.toFixed(0), '42');
});

test('a failed result carries err and nothing else', () => {
	const { err, value } = parse('nope');

	assert.ok(err instanceof Error);
	assert.equal(value, undefined);
});
