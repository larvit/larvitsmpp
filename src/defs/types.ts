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

export type WireType<TRead extends ParamValue, TWrite extends ParamValue = TRead> = {
	default: TRead;
	read: (buffer: Buffer, offset: number, length?: number) => Result<{ value: TRead }>;
	size: (value: TWrite) => number;
	write: (value: TWrite, buffer: Buffer, offset: number) => VoidResult;
};

function outOfRange(buffer: Buffer, offset: number, needed: number): Error | undefined {
	if (offset < 0 || needed < 0 || offset + needed > buffer.length) {
		return new Error(
			`Out of range: need ${String(needed)} bytes at offset ${String(offset)} of a ${String(buffer.length)} byte buffer`,
		);
	}

	return undefined;
}

function asString(value: number | string): string {
	return typeof value === 'number' ? value.toString() : value;
}

function readCstring(buffer: Buffer, offset: number): Result<{ value: string }> {
	let length = 0;

	while (buffer[offset + length]) {
		length++;

		if (offset + length >= buffer.length) {
			return { err: new Error('Unterminated C-Octet String') };
		}
	}

	return { value: buffer.toString('ascii', offset, offset + length) };
}

function writeCstring(value: number | string, buffer: Buffer, offset: number): VoidResult {
	const str = asString(value);
	const err = outOfRange(buffer, offset, str.length + 1);

	if (err) return { err };

	buffer.write(str, offset, 'ascii');
	buffer[offset + str.length] = 0;

	return {};
}

function sizeCstring(value: number | string): number {
	return asString(value).length + 1;
}

export const int8: WireType<number> = {
	default: 0,
	read(buffer, offset) {
		const err = outOfRange(buffer, offset, 1);

		return err ? { err } : { value: buffer.readUInt8(offset) };
	},
	size() {
		return 1;
	},
	write(value, buffer, offset) {
		const err = outOfRange(buffer, offset, 1);

		if (err) return { err };

		buffer.writeUInt8(value || 0, offset);

		return {};
	},
};

export const int16: WireType<number> = {
	default: 0,
	read(buffer, offset) {
		const err = outOfRange(buffer, offset, 2);

		return err ? { err } : { value: buffer.readUInt16BE(offset) };
	},
	size() {
		return 2;
	},
	write(value, buffer, offset) {
		const err = outOfRange(buffer, offset, 2);

		if (err) return { err };

		buffer.writeUInt16BE(value || 0, offset);

		return {};
	},
};

export const int32: WireType<number> = {
	default: 0,
	read(buffer, offset) {
		const err = outOfRange(buffer, offset, 4);

		return err ? { err } : { value: buffer.readUInt32BE(offset) };
	},
	size() {
		return 4;
	},
	write(value, buffer, offset) {
		const err = outOfRange(buffer, offset, 4);

		if (err) return { err };

		buffer.writeUInt32BE(value || 0, offset);

		return {};
	},
};

/** Octet String: a length byte followed by that many octets. */
export const string: WireType<string, number | string> = {
	default: '',
	read(buffer, offset) {
		const lengthErr = outOfRange(buffer, offset, 1);

		if (lengthErr) return { err: lengthErr };

		const length = buffer.readUInt8(offset);
		const err = outOfRange(buffer, offset + 1, length);

		if (err) return { err };

		return { value: buffer.toString('ascii', offset + 1, offset + 1 + length) };
	},
	size(value) {
		return asString(value).length + 1;
	},
	write(value, buffer, offset) {
		const str = asString(value);
		const err = outOfRange(buffer, offset, str.length + 1);

		if (err) return { err };

		buffer.writeUInt8(str.length, offset);
		buffer.write(str, offset + 1, 'ascii');

		return {};
	},
};

/** C-Octet String: NULL-terminated. */
export const cstring: WireType<string, number | string> = {
	default: '',
	read: readCstring,
	size: sizeCstring,
	write: writeCstring,
};

export const buffer: WireType<Buffer, Buffer | number | string> = {
	default: Buffer.alloc(0),
	read(buf, offset, length = 0) {
		const err = outOfRange(buf, offset, length);

		return err ? { err } : { value: buf.subarray(offset, offset + length) };
	},
	// A trailing NULL octet is not counted, mirroring how peers that append one to short_message
	// report sm_length. pduToObj relies on this when deciding whether to retry a parse.
	size(value) {
		const buf = Buffer.isBuffer(value) ? value : Buffer.from(asString(value), 'ascii');

		return buf[buf.length - 1] === 0x00 ? buf.length - 1 : buf.length;
	},
	write(value, buf, offset) {
		const source = Buffer.isBuffer(value) ? value : Buffer.from(asString(value), 'ascii');
		const err = outOfRange(buf, offset, source.length);

		if (err) return { err };

		source.copy(buf, offset);

		return {};
	},
};

export const dest_address_array: WireType<DestAddress[]> = {
	default: [],
	read(buf, offset) {
		const countErr = outOfRange(buf, offset, 1);

		if (countErr) return { err: countErr };

		const result: DestAddress[] = [];
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
				const { err, value } = readCstring(buf, offset);

				if (err) return { err };

				offset += sizeCstring(value);
				result.push({ dest_addr_npi, dest_addr_ton, destination_addr: value });
			} else {
				const { err, value } = readCstring(buf, offset);

				if (err) return { err };

				offset += sizeCstring(value);
				result.push({ dl_name: value });
			}
		}

		return { value: result };
	},
	size(value) {
		let size = 1;

		for (const dest of value) {
			size += 'dl_name' in dest
				? sizeCstring(dest.dl_name) + 1
				: sizeCstring(dest.destination_addr) + 3;
		}

		return size;
	},
	write(value, buf, offset) {
		const err = outOfRange(buf, offset, dest_address_array.size(value));

		if (err) return { err };

		buf.writeUInt8(value.length, offset++);

		for (const dest of value) {
			if ('dl_name' in dest) {
				buf.writeUInt8(2, offset++);
				writeCstring(dest.dl_name, buf, offset);
				offset += sizeCstring(dest.dl_name);
			} else {
				buf.writeUInt8(1, offset++);
				buf.writeUInt8(dest.dest_addr_ton || 0, offset++);
				buf.writeUInt8(dest.dest_addr_npi || 0, offset++);
				writeCstring(dest.destination_addr, buf, offset);
				offset += sizeCstring(dest.destination_addr);
			}
		}

		return {};
	},
};

export const unsuccess_sme_array: WireType<UnsuccessSme[]> = {
	default: [],
	read(buf, offset) {
		const countErr = outOfRange(buf, offset, 1);

		if (countErr) return { err: countErr };

		const result: UnsuccessSme[] = [];
		let remaining = buf.readUInt8(offset++);

		while (remaining-- > 0) {
			const headerErr = outOfRange(buf, offset, 2);

			if (headerErr) return { err: headerErr };

			const dest_addr_ton = buf.readUInt8(offset++);
			const dest_addr_npi = buf.readUInt8(offset++);
			const { err, value } = readCstring(buf, offset);

			if (err) return { err };

			offset += sizeCstring(value);

			const statusErr = outOfRange(buf, offset, 4);

			if (statusErr) return { err: statusErr };

			result.push({
				dest_addr_npi,
				dest_addr_ton,
				destination_addr: value,
				error_status_code: buf.readUInt32BE(offset),
			});
			offset += 4;
		}

		return { value: result };
	},
	size(value) {
		let size = 1;

		for (const sme of value) {
			size += sizeCstring(sme.destination_addr) + 6;
		}

		return size;
	},
	write(value, buf, offset) {
		const err = outOfRange(buf, offset, unsuccess_sme_array.size(value));

		if (err) return { err };

		buf.writeUInt8(value.length, offset++);

		for (const sme of value) {
			buf.writeUInt8(sme.dest_addr_ton || 0, offset++);
			buf.writeUInt8(sme.dest_addr_npi || 0, offset++);
			writeCstring(sme.destination_addr, buf, offset);
			offset += sizeCstring(sme.destination_addr);
			buf.writeUInt32BE(sme.error_status_code, offset);
			offset += 4;
		}

		return {};
	},
};

/** TLV variants are length-prefixed by the TLV header, so they carry no length of their own. */
export const tlv = {
	buffer: {
		default: Buffer.alloc(0),
		read(buf: Buffer, offset: number, length = 0): Result<{ value: Buffer }> {
			const err = outOfRange(buf, offset, length);

			return err ? { err } : { value: buf.subarray(offset, offset + length) };
		},
		size(value: Buffer | number | string): number {
			return Buffer.isBuffer(value) ? value.length : asString(value).length;
		},
		write: buffer.write,
	} satisfies WireType<Buffer, Buffer | number | string>,
	cstring,
	int8,
	int16,
	int32,
	string: {
		default: '',
		read(buf: Buffer, offset: number, length = 0): Result<{ value: string }> {
			const err = outOfRange(buf, offset, length);

			return err ? { err } : { value: buf.toString('ascii', offset, offset + length) };
		},
		size(value: number | string): number {
			return asString(value).length;
		},
		write(value: number | string, buf: Buffer, offset: number): VoidResult {
			const str = asString(value);
			const err = outOfRange(buf, offset, str.length);

			if (err) return { err };

			buf.write(str, offset, 'ascii');

			return {};
		},
	} satisfies WireType<string, number | string>,
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
