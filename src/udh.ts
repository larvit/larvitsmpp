export type ConcatInfo = {
	part: number;
	reference: number;
	total: number;
};

/**
 * Finds the concatenation information element in a User Data Header, walking the elements rather
 * than assuming the header holds nothing else — real SMSCs put ports, language indicators and more
 * alongside it.
 *
 * `message` is a short_message whose first octet is the UDH length.
 */
export function concatInfo(message: Buffer): ConcatInfo | undefined {
	const udhLength = message[0];

	if (udhLength === undefined) return undefined;

	const end = Math.min(udhLength + 1, message.length);
	let offset = 1;

	while (offset + 2 <= end) {
		const iei = message.readUInt8(offset);
		const ieLength = message.readUInt8(offset + 1);
		const data = message.subarray(offset + 2, offset + 2 + ieLength);

		if (offset + 2 + ieLength > end) return undefined;

		// 0x00 is an 8-bit concatenation reference, 0x08 a 16-bit one.
		if (iei === 0x00 && ieLength === 3) {
			return { part: data.readUInt8(2), reference: data.readUInt8(0), total: data.readUInt8(1) };
		}

		if (iei === 0x08 && ieLength === 4) {
			return { part: data.readUInt8(3), reference: data.readUInt16BE(0), total: data.readUInt8(2) };
		}

		offset += 2 + ieLength;
	}

	return undefined;
}
