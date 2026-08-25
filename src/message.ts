import type { Result } from './result.ts';
import type { EncodingName } from './defs/encodings.ts';
import { consts } from './defs/constants.ts';
import { detect, encodingByDataCoding, encodings } from './defs/encodings.ts';

/** A single SMS carries 1120 bits, whatever the alphabet. */
const singleMessageBits = 1120;

/** Budget per concatenated segment: septets for GSM, octets for UCS2. */
const segmentUnits = { ASCII: 153, UCS2: 67 * 2 } as const;

export type SplitOptions = {
	encoding?: EncodingName;
	reference: number;
};

export function encodeMessage(
	message: string,
	encoding?: EncodingName,
): { buffer: Buffer; encoding: EncodingName } {
	const resolved = encoding ?? detect(message);

	return { buffer: encodings[resolved].encode(message), encoding: resolved };
}

export function decodeMessage(
	buffer: Buffer,
	dataCoding: number,
	esmClass = 0,
): { message: string; udh: Buffer | undefined } {
	const encoding = encodingByDataCoding(dataCoding);

	if ((esmClass & consts.ESM_CLASS.UDH_INDICATOR) !== consts.ESM_CLASS.UDH_INDICATOR) {
		return { message: encodings[encoding].decode(buffer), udh: undefined };
	}

	const udhLength = (buffer[0] ?? 0) + 1;

	return {
		message: encodings[encoding].decode(buffer.subarray(udhLength)),
		udh: buffer.subarray(0, udhLength),
	};
}

export function bitCount(message: string, encoding?: EncodingName): number {
	const resolved = encoding ?? detect(message);
	const encoded = encodings[resolved].encode(message);

	// GSM characters are packed seven bits to a septet; everything else stays octet-aligned.
	return resolved === 'ASCII' || resolved === 'FLASH' ? encoded.length * 7 : encoded.length * 8;
}

/**
 * Splits a message into concatenation segments, each prefixed with a UDH. A message that fits in a
 * single SMS is returned as one segment with no UDH.
 *
 * Splitting walks code points, so an escaped GSM character never straddles a segment boundary and a
 * surrogate pair is never cut in half.
 */
export function splitMessage(message: string, options: SplitOptions): Buffer[] {
	const encoding = options.encoding ?? detect(message);

	if (bitCount(message, encoding) <= singleMessageBits) {
		return [encodings[encoding].encode(message)];
	}

	const budget = encoding === 'UCS2' ? segmentUnits.UCS2 : segmentUnits.ASCII;
	const parts: string[] = [];
	let current = '';
	let used = 0;

	for (const char of message) {
		const cost = encodings[encoding].encode(char).length;

		if (used + cost > budget) {
			parts.push(current);
			current = '';
			used = 0;
		}

		current += char;
		used += cost;
	}

	if (current !== '') parts.push(current);

	return parts.map((part, index) => Buffer.concat([
		Buffer.from([0x05, 0x00, 0x03, options.reference & 0xFF, parts.length, index + 1]),
		encodings[encoding].encode(part),
	]));
}

function pad(value: number, length: number): string {
	return value.toString().padStart(length, '0');
}

/**
 * The YYMMDDhhmm stamp used inside delivery receipt text. UTC, so a receipt reads the same wherever
 * the process runs.
 */
export function smppDate(date: Date): string {
	return pad(date.getUTCFullYear() % 100, 2)
		+ pad(date.getUTCMonth() + 1, 2)
		+ pad(date.getUTCDate(), 2)
		+ pad(date.getUTCHours(), 2)
		+ pad(date.getUTCMinutes(), 2);
}

const absoluteTime = /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d)(\d\d)([+-])$/;
const relativeTime = /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)000R$/;

/** The SMPP absolute and relative time format, as used by validity_period and friends. */
export const smppTime = {
	/**
	 * A Date becomes an absolute UTC time; a number is a relative period in seconds. Relative
	 * periods are expressed in days and below, so anything past 99 days is clamped to that.
	 */
	encode(value: Date | number | string): string {
		if (typeof value === 'string') return value;

		if (typeof value === 'number') {
			const total = Math.max(0, Math.floor(value));
			const days = Math.min(99, Math.floor(total / 86400));
			const capped = days === 99 ? 99 * 86400 + 86399 : total;

			return '0000'
				+ pad(Math.floor(capped / 86400), 2)
				+ pad(Math.floor(capped / 3600) % 24, 2)
				+ pad(Math.floor(capped / 60) % 60, 2)
				+ pad(capped % 60, 2)
				+ '000R';
		}

		return pad(value.getUTCFullYear() % 100, 2)
			+ pad(value.getUTCMonth() + 1, 2)
			+ pad(value.getUTCDate(), 2)
			+ pad(value.getUTCHours(), 2)
			+ pad(value.getUTCMinutes(), 2)
			+ pad(value.getUTCSeconds(), 2)
			+ pad(Math.floor(value.getUTCMilliseconds() / 100), 1)
			+ '00+';
	},

	decode(value: string): Result<{ date: Date }> {
		const relative = relativeTime.exec(value);

		if (relative) {
			const [, years, months, days, hours, minutes, seconds] = relative;
			const date = new Date();

			date.setUTCFullYear(date.getUTCFullYear() + Number(years));
			date.setUTCMonth(date.getUTCMonth() + Number(months));
			date.setUTCDate(date.getUTCDate() + Number(days));
			date.setUTCHours(date.getUTCHours() + Number(hours));
			date.setUTCMinutes(date.getUTCMinutes() + Number(minutes));
			date.setUTCSeconds(date.getUTCSeconds() + Number(seconds));

			return { date };
		}

		const absolute = absoluteTime.exec(value);

		if (!absolute) {
			return { err: new Error(`Not an SMPP time: ${JSON.stringify(value)}`) };
		}

		const [, years, months, days, hours, minutes, seconds, tenths, quarters, sign] = absolute;
		const century = Math.floor(new Date().getUTCFullYear() / 100) * 100;
		const millis = Date.UTC(
			century + Number(years),
			Number(months) - 1,
			Number(days),
			Number(hours),
			Number(minutes),
			Number(seconds),
			Number(tenths) * 100,
		);

		// The offset says how far the stamp's local time runs ahead of UTC, so undo it.
		const offset = Number(quarters) * 15 * 60_000;

		return { date: new Date(sign === '+' ? millis - offset : millis + offset) };
	},
};
