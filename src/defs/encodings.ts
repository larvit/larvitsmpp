export type EncodingName = 'ASCII' | 'LATIN1' | 'UCS2';

export type Encoding = {
	decode: (buffer: Uint8Array) => string;
	encode: (value: string) => Buffer;
	match: (value: string) => boolean;
};

const gsmChars =
	'@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1BÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

const gsmRegex =
	/^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1BÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà\f^{}\\[~\]|€]*$/;

const gsmExtended = /[\f^{}\\[~\]|€]/g;
const gsmEscaped = /\x1B([\nΛ()/<=>¡e])/g;

// Characters reachable only via an ESC prefix, paired with the base character that follows it.
const gsmExtendedPairs: [string, string][] = [
	['\f', '\n'],
	['^', 'Λ'],
	['{', '('],
	['}', ')'],
	['\\', '/'],
	['[', '<'],
	['~', '='],
	[']', '>'],
	['|', '¡'],
	['€', 'e'],
];

const gsmCharCodes = new Map<string, number>();
const gsmExtChars = new Map<string, string>();

// Indexed by code unit rather than code point: every entry in the table is one octet on the wire.
for (let code = 0; code < gsmChars.length; code++) {
	gsmCharCodes.set(gsmChars.charAt(code), code);
}

for (const [extended, base] of gsmExtendedPairs) {
	gsmExtChars.set(extended, base);
	gsmExtChars.set(base, extended);
}

const ascii: Encoding = {
	decode(buffer) {
		let result = '';

		for (const byte of buffer) {
			result += gsmChars[byte] ?? ' ';
		}

		return result.replace(gsmEscaped, (match, escaped: string) => gsmExtChars.get(escaped) ?? match);
	},

	encode(value) {
		const escaped = value.replace(gsmExtended, match => `\x1B${gsmExtChars.get(match) ?? ''}`);
		const result: number[] = [];

		for (const char of escaped) {
			result.push(gsmCharCodes.get(char) ?? 0x20);
		}

		return Buffer.from(result);
	},

	match(value) {
		return gsmRegex.test(value);
	},
};

const latin1: Encoding = {
	decode(buffer) {
		return Buffer.from(buffer).toString('latin1');
	},

	encode(value) {
		return Buffer.from(value, 'latin1');
	},

	// Deliberately never selected by detect(); Latin-1 is decoded when a peer asks for it, never
	// chosen for outgoing messages.
	match() {
		return false;
	},
};

const ucs2: Encoding = {
	decode(buffer) {
		// A peer-controlled sm_length can cut a character in half, and swap16() refuses odd lengths.
		const whole = buffer.length - (buffer.length % 2);

		return Buffer.from(buffer.subarray(0, whole)).swap16().toString('utf16le');
	},

	encode(value) {
		return Buffer.from(value, 'utf16le').swap16();
	},

	match() {
		return true;
	},
};

export const encodings: Record<EncodingName, Encoding> = {
	ASCII: ascii,
	LATIN1: latin1,
	UCS2: ucs2,
};

export const encodingNames: readonly string[] = Object.keys(encodings);

export function isEncodingName(value: unknown): value is EncodingName {
	return typeof value === 'string' && Object.hasOwn(encodings, value);
}

export function detect(value: string): EncodingName {
	if (encodings.ASCII.match(value)) return 'ASCII';
	if (encodings.LATIN1.match(value)) return 'LATIN1';

	return 'UCS2';
}

export type Unencodable = { char: string; index: number };

/** The first character `encoding` cannot carry, or undefined where it carries every one of them. */
export function unencodable(message: string, encoding: EncodingName): Unencodable | undefined {
	// Asked of the codec, never of match(): that is detect()'s policy, where LATIN1 answers false to
	// everything while carrying every octet here.
	const codec = encodings[encoding];
	let index = 0;

	for (const char of message) {
		if (codec.decode(codec.encode(char)) !== char) return { char, index };

		index += char.length;
	}

	return undefined;
}

/**
 * The GSM 03.38 section 4 message class a `data_coding` octet carries, in bits 1-0, or undefined
 * where its coding group carries none. Below 0x80 bit 4 says whether one is there; 0xF0 always is.
 */
export function messageClassOf(dataCoding: number): number | undefined {
	if ((dataCoding & 0x80) === 0) {
		return (dataCoding & 0x10) === 0x10 ? dataCoding & 0x03 : undefined;
	}

	return (dataCoding & 0xF0) === 0xF0 ? dataCoding & 0x03 : undefined;
}

// A class is the only evidence a peer below 0x80 is spelling 03.38 rather than SMPP's flat table,
// which contradicts it and wins: 0x03 is Latin-1 here, GSM 7-bit there.
/** A class group puts the alphabet in bits 3-2, or in bit 2 alone above 0xF0. */
function messageClassEncoding(dataCoding: number): EncodingName | undefined {
	if (messageClassOf(dataCoding) === undefined) return undefined;

	if ((dataCoding & 0xF0) === 0xF0) {
		return (dataCoding & 0x04) === 0x04 ? 'LATIN1' : 'ASCII';
	}

	const alphabet = (dataCoding >> 2) & 0x03;

	if (alphabet === 0x01) return 'LATIN1';

	return alphabet === 0x02 ? 'UCS2' : 'ASCII';
}

/**
 * SMPP data_coding is a flat table for 0x00-0x0E, and the message class ranges are how a flash UCS2
 * message arrives as 0x18. The 8-bit binary codings resolve to LATIN1, the one codec here that maps
 * every octet to a code point and back unchanged, so a binary payload survives; alphabets with no
 * codec fall back to ASCII.
 */
export function encodingByDataCoding(dataCoding: number): EncodingName {
	const messageClass = messageClassEncoding(dataCoding);

	if (messageClass) return messageClass;
	if (dataCoding === 0x08) return 'UCS2';

	// 0x02 and 0x04 are 8-bit binary, 0x03 is Latin-1.
	return dataCoding >= 0x02 && dataCoding <= 0x04 ? 'LATIN1' : 'ASCII';
}
