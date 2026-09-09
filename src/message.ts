import type { Result } from './result.ts';
import type { EncodingName } from './defs/encodings.ts';
import { detect, encodingByDataCoding, encodings, unencodable, unencodableText } from './defs/encodings.ts';
import { consts, hasUdh } from './defs/constants.ts';
import { udhLength } from './udh.ts';

/** A single SMS carries 1120 bits, whatever the alphabet. */
const singleMessageBits = 1120;

/** The concatenation UDH numbers the segments of a message in a single octet. */
export const maxSegments = 255;

/** Budget per segment: the 134 octets left of 140 after the UDH, or the 153 septets GSM packs into them. */
const segmentUnits: Record<EncodingName, number> = { ASCII: 153, LATIN1: 134, UCS2: 134 };

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

/** A message body as octets, under the alphabet `dataCoding` resolves to, or one detected for it. */
export function encodeBody(
	text: string,
	dataCoding: number | undefined,
): Result<{ buffer: Buffer; dataCoding: number }> {
	if (dataCoding === undefined) {
		const detected = encodeMessage(text);

		return { buffer: detected.buffer, dataCoding: consts.ENCODING[detected.encoding] };
	}

	const encoding = encodingByDataCoding(dataCoding);
	const lost = unencodable(text, encoding);

	return lost
		? { err: new Error(`data_coding ${String(dataCoding)} resolves to ${encoding}, which cannot carry ${unencodableText(lost)}; pass a Buffer of octets, or a data_coding whose alphabet carries them`) }
		: { buffer: encodings[encoding].encode(text), dataCoding };
}

export function decodeMessage(
	buffer: Buffer,
	dataCoding: number,
	esmClass = 0,
): { message: string; udh: Buffer | undefined } {
	const encoding = encodingByDataCoding(dataCoding);

	if (!hasUdh(esmClass)) {
		return { message: encodings[encoding].decode(buffer), udh: undefined };
	}

	const headerLength = udhLength(buffer);

	return {
		message: encodings[encoding].decode(buffer.subarray(headerLength)),
		udh: buffer.subarray(0, headerLength),
	};
}

export function bitCount(message: string, encoding?: EncodingName): number {
	const resolved = encoding ?? detect(message);
	const encoded = encodings[resolved].encode(message);

	// GSM characters are packed seven bits to a septet; everything else stays octet-aligned.
	return resolved === 'ASCII' ? encoded.length * 7 : encoded.length * 8;
}

/**
 * Splits a message into concatenation segments, each prefixed with a UDH. A message that fits in a
 * single SMS is returned as one segment with no UDH, and one needing more than `maxSegments` as no
 * segments at all — a UDH cannot number them.
 *
 * Splitting walks code points, so an escaped GSM character never straddles a segment boundary and a
 * surrogate pair is never cut in half.
 */
export function splitMessage(message: string, options: SplitOptions): Buffer[] {
	const encoding = options.encoding ?? detect(message);

	if (bitCount(message, encoding) <= singleMessageBits) {
		return [encodings[encoding].encode(message)];
	}

	const budget = segmentUnits[encoding];
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

	if (parts.length > maxSegments) return [];

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

/** A second count is spelled in days and below: no fixed number of seconds is a month or a year. */
const maxRelativeSeconds = 99 * 86400 + 86399;

const absoluteTime = /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d)(\d\d)([+-])$/;
const relativeTime = /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)000R$/;

/** The SMPP absolute and relative time format, as used by validity_period and friends. */
export const smppTime = {
	/**
	 * A Date becomes an absolute UTC time; a number is a relative period in seconds, expressed in
	 * days and below; a string is a stamp the caller formatted itself and is passed through. A value
	 * naming no instant, and a second count no day field reaches, are refused.
	 */
	encode(value: Date | number | string): Result<{ text: string }> {
		if (typeof value === 'string') return { text: value };

		if (typeof value === 'number') {
			if (!Number.isFinite(value)) return { err: new Error(`Not an SMPP time: ${String(value)}`) };

			const seconds = Math.floor(value);

			if (seconds < 0) {
				return { err: new Error(`A relative period cannot be negative, got ${String(value)}`) };
			}

			if (seconds > maxRelativeSeconds) {
				return { err: new Error(`A period in seconds is spelled in days and below, so ${String(maxRelativeSeconds)} (99d 23:59:59) is the most, got ${String(value)}; pass a Date for an instant further out`) };
			}

			return {
				text: '0000'
					+ pad(Math.floor(seconds / 86400), 2)
					+ pad(Math.floor(seconds / 3600) % 24, 2)
					+ pad(Math.floor(seconds / 60) % 60, 2)
					+ pad(seconds % 60, 2)
					+ '000R',
			};
		}

		if (Number.isNaN(value.getTime())) return { err: new Error('Not an SMPP time: an invalid Date') };

		return {
			text: pad(value.getUTCFullYear() % 100, 2)
				+ pad(value.getUTCMonth() + 1, 2)
				+ pad(value.getUTCDate(), 2)
				+ pad(value.getUTCHours(), 2)
				+ pad(value.getUTCMinutes(), 2)
				+ pad(value.getUTCSeconds(), 2)
				+ pad(Math.floor(value.getUTCMilliseconds() / 100), 1)
				+ '00+',
		};
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
