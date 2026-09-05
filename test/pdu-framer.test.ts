import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { PduFramer } from '../src/pdu-framer.ts';
import { objToPdu } from '../src/pdu.ts';

function pdu(seqNr: number): Buffer {
	const { buffer } = objToPdu({ cmdName: 'enquire_link', seqNr });

	assert.ok(buffer);

	return buffer;
}

describe('PduFramer', () => {
	test('yields nothing until a whole PDU has arrived', () => {
		const framer = new PduFramer();
		const whole = pdu(1);

		framer.push(whole.subarray(0, 8));
		assert.deepEqual(framer.next(), { pdus: [] });

		framer.push(whole.subarray(8));
		assert.deepEqual(framer.next(), { pdus: [whole] });
	});

	test('splits several PDUs delivered in one chunk', () => {
		const framer = new PduFramer();

		framer.push(Buffer.concat([pdu(1), pdu(2), pdu(3)]));

		const { pdus } = framer.next();

		assert.ok(pdus);
		assert.equal(pdus.length, 3);
		assert.deepEqual(pdus[2], pdu(3));
	});

	test('reassembles a PDU dribbled one octet at a time', () => {
		const framer = new PduFramer();
		const whole = pdu(42);

		for (const octet of whole) {
			framer.push(Buffer.from([octet]));
		}

		assert.deepEqual(framer.next(), { pdus: [whole] });
		assert.equal(framer.buffered, 0);
	});

	test('keeps a trailing partial PDU buffered for the next chunk', () => {
		const framer = new PduFramer();
		const second = pdu(2);

		framer.push(Buffer.concat([pdu(1), second.subarray(0, 4)]));

		const first = framer.next();

		assert.ok(first.pdus);
		assert.equal(first.pdus.length, 1);
		assert.equal(framer.buffered, 4);

		framer.push(second.subarray(4));
		assert.deepEqual(framer.next(), { pdus: [second] });
	});

	// 0.4.0 read a command length of 0 as "discard the buffer" and looped; anything absurd was
	// simply trusted and allocated.
	test('reports an impossible command length instead of trusting it', () => {
		const zero = new PduFramer();
		const huge = new PduFramer();

		zero.push(Buffer.alloc(16));
		assert.ok(zero.next().err instanceof Error);

		huge.push(Buffer.from('ffffffff0000001500000000000000ff', 'hex'));
		assert.ok(huge.next().err instanceof Error);
	});

	test('ignores empty chunks', () => {
		const framer = new PduFramer();

		framer.push(Buffer.alloc(0));

		assert.equal(framer.buffered, 0);
		assert.deepEqual(framer.next(), { pdus: [] });
	});
});
