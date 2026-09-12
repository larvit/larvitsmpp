import assert from 'node:assert/strict';
import type { PduObjectInput } from '../src/pdu.ts';
import { objToPdu } from '../src/pdu.ts';

/** The octets a test writes straight to a socket, which objToPdu builds for every valid PDU. */
export function pduBytes(input: PduObjectInput): Buffer {
	const { buffer } = objToPdu(input);

	assert.ok(buffer);

	return buffer;
}

/** The same, wearing a command id the command table defines nothing for. */
export function withUnknownCmdId(input: PduObjectInput): Buffer {
	const buffer = pduBytes(input);

	buffer.writeUInt32BE(0x00010001, 4);

	return buffer;
}

/** command_length honoured, so the stream stays in sync, with the declared body cut short. */
export function shortened(input: PduObjectInput, octets: number): Buffer {
	const buffer = pduBytes(input);
	const cut = buffer.subarray(0, buffer.length - octets);

	cut.writeUInt32BE(cut.length, 0);

	return cut;
}

/** The same, with a message_state TLV declaring four octets of value and carrying one. */
export function truncatedTlv(input: PduObjectInput): Buffer {
	const appended = Buffer.concat([pduBytes(input), Buffer.from('0427000401', 'hex')]);

	appended.writeUInt32BE(appended.length, 0);

	return appended;
}

/** The same, ending in a bare TLV header: a tag, a declared length, and no value octets at all. */
export function bareTlvHeader(input: PduObjectInput): Buffer {
	const appended = Buffer.concat([pduBytes(input), Buffer.from('001d00c8', 'hex')]);

	appended.writeUInt32BE(appended.length, 0);

	return appended;
}
