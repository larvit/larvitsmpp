import type { Result, VoidResult } from '../result.ts';

export type DestAddress =
	| { dest_addr_npi: number; dest_addr_ton: number; destination_addr: string }
	| { dl_name: string };

export type UnsuccessSme = {
	dest_addr_npi: number;
	dest_addr_ton: number;
	destination_addr: string;
	error_status_code: number;
};

export type ParamValue = Buffer | DestAddress[] | UnsuccessSme[] | number | string;

/**
 * One field on the wire. `read` reports how many octets it consumed so callers never have to
 * re-derive a length that could disagree with what was actually written.
 */
export type WireType<T extends ParamValue = ParamValue> = {
	default: T;
	read: (buffer: Buffer, offset: number, length?: number) => Result<{ bytesRead: number; value: T }>;
	size: (value: ParamValue) => Result<{ size: number }>;
	write: (value: ParamValue, buffer: Buffer, offset: number) => VoidResult;
};

/** Renders a parameter as text without ever falling back to "[object Object]". */
export function paramText(value: ParamValue | undefined): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'number') return value.toString();
	if (Buffer.isBuffer(value)) return value.toString('ascii');

	return '';
}

function outOfRange(buffer: Buffer, offset: number, needed: number): Error | undefined {
	if (offset < 0 || needed < 0 || offset + needed > buffer.length) {
		return new Error(
			`Out of range: need ${String(needed)} octets at offset ${String(offset)} of a ${String(buffer.length)} octet buffer`,
		);
	}

	return undefined;
}

function wantInt(value: ParamValue, max: number): Result<{ int: number }> {
	if (typeof value !== 'number' || !Number.isInteger(value)) {
		return { err: new Error(`Expected an integer, got ${JSON.stringify(value)}`) };
	}

	if (value < 0 || value > max) {
		return { err: new Error(`Integer ${String(value)} out of range 0-${String(max)}`) };
	}

	return { int: value };
}

function writeInt8(value: ParamValue, buf: Buffer, offset: number): VoidResult {
	const { err, int } = wantInt(value, 0xFF);

	if (err) return { err };

	buf.writeUInt8(int, offset);

	return {};
}

function writeInt32(value: ParamValue, buf: Buffer, offset: number): VoidResult {
	const { err, int } = wantInt(value, 0xFFFFFFFF);

	if (err) return { err };

	buf.writeUInt32BE(int, offset);

	return {};
}

function wantText(value: ParamValue): Result<{ text: string }> {
	if (typeof value === 'string') return { text: value };
	if (typeof value === 'number') return { text: value.toString() };

	return { err: new Error(`Expected a string, got ${typeof value}`) };
}

function wantBytes(value: ParamValue): Result<{ bytes: Buffer }> {
	if (Buffer.isBuffer(value)) return { bytes: value };

	const { err, text } = wantText(value);

	return err ? { err } : { bytes: Buffer.from(text, 'ascii') };
}

function isDestAddress(value: unknown): value is DestAddress {
	if (typeof value !== 'object' || value === null) return false;

	if ('dl_name' in value) return typeof value.dl_name === 'string';

	return 'destination_addr' in value && typeof value.destination_addr === 'string';
}

function isUnsuccessSme(value: unknown): value is UnsuccessSme {
	return typeof value === 'object'
		&& value !== null
		&& 'destination_addr' in value && typeof value.destination_addr === 'string'
		&& 'error_status_code' in value && typeof value.error_status_code === 'number';
}

function wantDestAddresses(value: ParamValue): Result<{ addresses: DestAddress[] }> {
	if (!Array.isArray(value)) {
		return { err: new Error('Expected an array of dest_address structures') };
	}

	const addresses: DestAddress[] = [];

	for (const entry of value) {
		if (!isDestAddress(entry)) {
			return { err: new Error('Expected an array of dest_address structures') };
		}

		addresses.push(entry);
	}

	return { addresses };
}

function wantUnsuccessSmes(value: ParamValue): Result<{ smes: UnsuccessSme[] }> {
	if (!Array.isArray(value)) {
		return { err: new Error('Expected an array of unsuccess_sme structures') };
	}

	const smes: UnsuccessSme[] = [];

	for (const entry of value) {
		if (!isUnsuccessSme(entry)) {
			return { err: new Error('Expected an array of unsuccess_sme structures') };
		}

		smes.push(entry);
	}

	return { smes };
}

function readCstring(buffer: Buffer, offset: number): Result<{ bytesRead: number; value: string }> {
	// An offset at the end exactly is an absent trailing field, which real peers do send.
	if (outOfRange(buffer, offset, 0)) {
		return {
			err: new Error(
				`C-Octet String starts at offset ${String(offset)}, past a ${String(buffer.length)} octet buffer`,
			),
		};
	}

	let length = 0;

	while (buffer[offset + length]) {
		length++;

		if (offset + length >= buffer.length) {
			return { err: new Error('Unterminated C-Octet String') };
		}
	}

	return { bytesRead: length + 1, value: buffer.toString('ascii', offset, offset + length) };
}

function writeCstring(text: string, buffer: Buffer, offset: number): VoidResult {
	const err = outOfRange(buffer, offset, text.length + 1);

	if (err) return { err };

	buffer.write(text, offset, 'ascii');
	buffer[offset + text.length] = 0;

	return {};
}

function intType(octets: number, max: number, readAt: (b: Buffer, o: number) => number, writeAt: (b: Buffer, v: number, o: number) => void): WireType<number> {
	return {
		default: 0,
		read(buffer, offset) {
			const err = outOfRange(buffer, offset, octets);

			return err ? { err } : { bytesRead: octets, value: readAt(buffer, offset) };
		},
		size() {
			return { size: octets };
		},
		write(value, buffer, offset) {
			const rangeErr = outOfRange(buffer, offset, octets);

			if (rangeErr) return { err: rangeErr };

			const { err, int } = wantInt(value, max);

			if (err) return { err };

			writeAt(buffer, int, offset);

			return {};
		},
	};
}

export const int8 = intType(1, 0xFF, (b, o) => b.readUInt8(o), (b, v, o) => b.writeUInt8(v, o));
export const int16 = intType(2, 0xFFFF, (b, o) => b.readUInt16BE(o), (b, v, o) => b.writeUInt16BE(v, o));
export const int32 = intType(4, 0xFFFFFFFF, (b, o) => b.readUInt32BE(o), (b, v, o) => b.writeUInt32BE(v, o));

const intByOctets: Record<number, WireType<number>> = { 1: int8, 2: int16, 4: int32 };

/**
 * The TLV header's length is what the parser skips past, so it is also the width the value is read
 * at — a peer that types a tag one octet wider than the table says still gets the value it meant.
 */
function tlvInt(declared: WireType<number>): WireType<number> {
	return {
		...declared,
		read(buffer, offset, length) {
			if (length === undefined) return declared.read(buffer, offset);

			const width = intByOctets[length];

			if (!width) {
				return { err: new Error(`Integer TLV declares ${String(length)} octets, expected 1, 2 or 4`) };
			}

			return width.read(buffer, offset);
		},
	};
}

/** Octet String: a length octet followed by that many octets. */
export const string: WireType<string> = {
	default: '',
	read(buffer, offset) {
		const lengthErr = outOfRange(buffer, offset, 1);

		if (lengthErr) return { err: lengthErr };

		const length = buffer.readUInt8(offset);
		const err = outOfRange(buffer, offset + 1, length);

		if (err) return { err };

		return { bytesRead: length + 1, value: buffer.toString('ascii', offset + 1, offset + 1 + length) };
	},
	size(value) {
		const { err, text } = wantText(value);

		if (err) return { err };

		return tooLongForLengthOctet(text) ?? { size: text.length + 1 };
	},
	write(value, buffer, offset) {
		const { err, text } = wantText(value);

		if (err) return { err };

		const lengthErr = tooLongForLengthOctet(text);

		if (lengthErr) return lengthErr;

		const rangeErr = outOfRange(buffer, offset, text.length + 1);

		if (rangeErr) return { err: rangeErr };

		buffer.writeUInt8(text.length, offset);
		buffer.write(text, offset + 1, 'ascii');

		return {};
	},
};

function tooLongForLengthOctet(text: string): { err: Error } | undefined {
	if (text.length <= 0xFF) return undefined;

	return { err: new Error(`Octet String is ${String(text.length)} octets, the length octet holds 255`) };
}

/** C-Octet String: NULL-terminated. */
export const cstring: WireType<string> = {
	default: '',
	read: readCstring,
	size(value) {
		const { err, text } = wantText(value);

		return err ? { err } : { size: text.length + 1 };
	},
	write(value, buffer, offset) {
		const { err, text } = wantText(value);

		return err ? { err } : writeCstring(text, buffer, offset);
	},
};

export const buffer: WireType<Buffer> = {
	default: Buffer.alloc(0),
	read(buf, offset, length = 0) {
		const err = outOfRange(buf, offset, length);

		return err ? { err } : { bytesRead: length, value: buf.subarray(offset, offset + length) };
	},
	size(value) {
		const { bytes, err } = wantBytes(value);

		return err ? { err } : { size: bytes.length };
	},
	write(value, buf, offset) {
		const { bytes, err } = wantBytes(value);

		if (err) return { err };

		const rangeErr = outOfRange(buf, offset, bytes.length);

		if (rangeErr) return { err: rangeErr };

		bytes.copy(buf, offset);

		return {};
	},
};

function sizeDestAddresses(addresses: DestAddress[]): number {
	let size = 1;

	for (const dest of addresses) {
		size += 'dl_name' in dest ? dest.dl_name.length + 2 : dest.destination_addr.length + 4;
	}

	return size;
}

export const dest_address_array: WireType<DestAddress[]> = {
	default: [],
	read(buf, offset) {
		const countErr = outOfRange(buf, offset, 1);

		if (countErr) return { err: countErr };

		const start = offset;
		const value: DestAddress[] = [];
		let remaining = buf.readUInt8(offset++);

		while (remaining-- > 0) {
			const flagErr = outOfRange(buf, offset, 1);

			if (flagErr) return { err: flagErr };

			const destFlag = buf.readUInt8(offset++);

			if (destFlag === 1) {
				const headerErr = outOfRange(buf, offset, 2);

				if (headerErr) return { err: headerErr };

				const dest_addr_ton = buf.readUInt8(offset++);
				const dest_addr_npi = buf.readUInt8(offset++);
				const address = readCstring(buf, offset);

				if (address.err) return { err: address.err };

				offset += address.bytesRead;
				value.push({ dest_addr_npi, dest_addr_ton, destination_addr: address.value });
			} else {
				const name = readCstring(buf, offset);

				if (name.err) return { err: name.err };

				offset += name.bytesRead;
				value.push({ dl_name: name.value });
			}
		}

		return { bytesRead: offset - start, value };
	},
	size(value) {
		const { addresses, err } = wantDestAddresses(value);

		return err ? { err } : { size: sizeDestAddresses(addresses) };
	},
	write(value, buf, offset) {
		const { addresses, err } = wantDestAddresses(value);

		if (err) return { err };

		const rangeErr = outOfRange(buf, offset, sizeDestAddresses(addresses));

		if (rangeErr) return { err: rangeErr };

		const count = writeInt8(addresses.length, buf, offset++);

		if (count.err) return { err: count.err };

		for (const dest of addresses) {
			if ('dl_name' in dest) {
				buf.writeUInt8(2, offset++);

				const name = writeCstring(dest.dl_name, buf, offset);

				if (name.err) return { err: name.err };

				offset += dest.dl_name.length + 1;
			} else {
				buf.writeUInt8(1, offset++);

				const ton = writeInt8(dest.dest_addr_ton, buf, offset++);

				if (ton.err) return { err: ton.err };

				const npi = writeInt8(dest.dest_addr_npi, buf, offset++);

				if (npi.err) return { err: npi.err };

				const addr = writeCstring(dest.destination_addr, buf, offset);

				if (addr.err) return { err: addr.err };

				offset += dest.destination_addr.length + 1;
			}
		}

		return {};
	},
};

function sizeUnsuccessSmes(smes: UnsuccessSme[]): number {
	let size = 1;

	for (const sme of smes) {
		size += sme.destination_addr.length + 7;
	}

	return size;
}

export const unsuccess_sme_array: WireType<UnsuccessSme[]> = {
	default: [],
	read(buf, offset) {
		const countErr = outOfRange(buf, offset, 1);

		if (countErr) return { err: countErr };

		const start = offset;
		const value: UnsuccessSme[] = [];
		let remaining = buf.readUInt8(offset++);

		while (remaining-- > 0) {
			const headerErr = outOfRange(buf, offset, 2);

			if (headerErr) return { err: headerErr };

			const dest_addr_ton = buf.readUInt8(offset++);
			const dest_addr_npi = buf.readUInt8(offset++);
			const address = readCstring(buf, offset);

			if (address.err) return { err: address.err };

			offset += address.bytesRead;

			const statusErr = outOfRange(buf, offset, 4);

			if (statusErr) return { err: statusErr };

			value.push({
				dest_addr_npi,
				dest_addr_ton,
				destination_addr: address.value,
				error_status_code: buf.readUInt32BE(offset),
			});
			offset += 4;
		}

		return { bytesRead: offset - start, value };
	},
	size(value) {
		const { err, smes } = wantUnsuccessSmes(value);

		return err ? { err } : { size: sizeUnsuccessSmes(smes) };
	},
	write(value, buf, offset) {
		const { err, smes } = wantUnsuccessSmes(value);

		if (err) return { err };

		const rangeErr = outOfRange(buf, offset, sizeUnsuccessSmes(smes));

		if (rangeErr) return { err: rangeErr };

		const count = writeInt8(smes.length, buf, offset++);

		if (count.err) return { err: count.err };

		for (const sme of smes) {
			const ton = writeInt8(sme.dest_addr_ton, buf, offset++);

			if (ton.err) return { err: ton.err };

			const npi = writeInt8(sme.dest_addr_npi, buf, offset++);

			if (npi.err) return { err: npi.err };

			const addr = writeCstring(sme.destination_addr, buf, offset);

			if (addr.err) return { err: addr.err };

			offset += sme.destination_addr.length + 1;

			const status = writeInt32(sme.error_status_code, buf, offset);

			if (status.err) return { err: status.err };

			offset += 4;
		}

		return {};
	},
};

/** TLV variants carry no length of their own; the TLV header supplies it. */
export const tlv = {
	buffer,
	// Bounded by the TLV header length, and tolerant of peers that omit the NULL terminator.
	cstring: {
		default: '',
		read(buf: Buffer, offset: number, length = 0) {
			const err = outOfRange(buf, offset, length);

			if (err) return { err };

			const terminator = buf.indexOf(0, offset);
			const end = terminator === -1 || terminator > offset + length
				? offset + length
				: terminator;

			return { bytesRead: length, value: buf.toString('ascii', offset, end) };
		},
		size(value: ParamValue) {
			const { err, text } = wantText(value);

			return err ? { err } : { size: text.length + 1 };
		},
		write(value: ParamValue, buf: Buffer, offset: number) {
			const { err, text } = wantText(value);

			return err ? { err } : writeCstring(text, buf, offset);
		},
	} satisfies WireType<string>,
	int8: tlvInt(int8),
	int16: tlvInt(int16),
	int32: tlvInt(int32),
	string: {
		default: '',
		read(buf: Buffer, offset: number, length = 0) {
			const err = outOfRange(buf, offset, length);

			return err ? { err } : { bytesRead: length, value: buf.toString('ascii', offset, offset + length) };
		},
		size(value: ParamValue) {
			const { err, text } = wantText(value);

			return err ? { err } : { size: text.length };
		},
		write(value: ParamValue, buf: Buffer, offset: number) {
			const { err, text } = wantText(value);

			if (err) return { err };

			const rangeErr = outOfRange(buf, offset, text.length);

			if (rangeErr) return { err: rangeErr };

			buf.write(text, offset, 'ascii');

			return {};
		},
	} satisfies WireType<string>,
};

export const types = {
	buffer,
	cstring,
	dest_address_array,
	int8,
	int16,
	int32,
	string,
	tlv,
	unsuccess_sme_array,
};
