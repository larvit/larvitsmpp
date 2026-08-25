import { randomBytes } from 'node:crypto';

/**
 * A UUID version 7: 48 bits of Unix milliseconds followed by random bits, so ids sort by creation
 * time without carrying a MAC address the way version 1 does.
 */
export function uuidv7(): string {
	const bytes = randomBytes(16);

	bytes.writeUIntBE(Date.now(), 0, 6);
	bytes.writeUInt8((bytes.readUInt8(6) & 0x0F) | 0x70, 6);
	bytes.writeUInt8((bytes.readUInt8(8) & 0x3F) | 0x80, 8);

	const hex = bytes.toString('hex');

	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		hex.slice(12, 16),
		hex.slice(16, 20),
		hex.slice(20),
	].join('-');
}
