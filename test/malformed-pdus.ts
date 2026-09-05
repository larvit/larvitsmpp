import assert from 'node:assert/strict';
import type { PduObjectInput } from '../src/pdu.ts';
import { objToPdu } from '../src/pdu.ts';

function built(input: PduObjectInput): Buffer {
	const { buffer } = objToPdu(input);

	assert.ok(buffer);

	return buffer;
}

/** The octets objToPdu built, wearing a different sequence number, above its own range or not. */
export function withSeqNr(input: PduObjectInput, seqNr: number): Buffer {
	const buffer = built(input);

	buffer.writeUInt32BE(seqNr, 12);

	return buffer;
}

/** The same, wearing a command id the command table defines nothing for. */
export function withUnknownCmdId(input: PduObjectInput): Buffer {
	const buffer = built(input);

	buffer.writeUInt32BE(0x00010001, 4);

	return buffer;
}

/** command_length honoured, so the stream stays in sync, with the declared body cut short. */
export function shortened(input: PduObjectInput, octets: number): Buffer {
	const buffer = built(input);
	const cut = buffer.subarray(0, buffer.length - octets);

	cut.writeUInt32BE(cut.length, 0);

	return cut;
}

/** The same, with a message_state TLV declaring four octets of value and carrying one. */
export function truncatedTlv(input: PduObjectInput): Buffer {
	const appended = Buffer.concat([built(input), Buffer.from('0427000401', 'hex')]);

	appended.writeUInt32BE(appended.length, 0);

	return appended;
}
