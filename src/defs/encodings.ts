export type EncodingName = 'ASCII' | 'FLASH' | 'LATIN1' | 'UCS2';

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
		return Buffer.from(buffer).swap16().toString('utf16le');
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
	FLASH: ascii,
	LATIN1: latin1,
	UCS2: ucs2,
};

export function detect(value: string): EncodingName {
	if (encodings.ASCII.match(value)) return 'ASCII';
	if (encodings.LATIN1.match(value)) return 'LATIN1';

	return 'UCS2';
}

/**
 * SMPP data_coding is a flat table for 0x00-0x0E, but the 0x1X and 0xFX ranges carry a GSM message
 * class and encode the alphabet in bits 3-2 (or bit 2) instead — which is how a flash UCS2 message
 * arrives as 0x18. Alphabets with no codec here fall back to ASCII.
 */
export function encodingByDataCoding(dataCoding: number): EncodingName {
	if ((dataCoding & 0xF0) === 0x10) {
		return ((dataCoding >> 2) & 0x03) === 0x02 ? 'UCS2' : 'ASCII';
	}

	if ((dataCoding & 0xF0) === 0xF0) {
		return 'ASCII';
	}

	if (dataCoding === 0x03) return 'LATIN1';
	if (dataCoding === 0x08) return 'UCS2';

	return 'ASCII';
}
