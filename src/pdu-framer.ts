import type { Result } from './result.ts';
import { maxPduLength } from './pdu.ts';

/**
 * Cuts a byte stream into whole PDUs.
 *
 * Chunks are held in a list and only joined when a complete PDU is available, so a peer dribbling
 * bytes cannot make this quadratic the way concatenating the whole queue on every chunk does.
 */
export class PduFramer {
	private chunks: Buffer[] = [];
	private length = 0;

	get buffered(): number {
		return this.length;
	}

	push(chunk: Buffer): void {
		if (chunk.length === 0) return;

		this.chunks.push(chunk);
		this.length += chunk.length;
	}

	/**
	 * Every complete PDU buffered so far. An error means the stream is unusable — the peer sent a
	 * command length that cannot be honoured — and the caller should close the connection.
	 */
	next(): Result<{ pdus: Buffer[] }> {
		const pdus: Buffer[] = [];

		while (this.length >= 16) {
			const cmdLength = this.join(16).readUInt32BE(0);

			if (cmdLength < 16 || cmdLength > maxPduLength) {
				return { err: new Error(`Refusing a cmd_length of ${String(cmdLength)}`) };
			}

			if (this.length < cmdLength) break;

			pdus.push(this.take(cmdLength));
		}

		return { pdus };
	}

	/** Makes sure the first chunk holds at least `size` octets, then returns it. */
	private join(size: number): Buffer {
		const first = this.chunks[0];

		if (first && first.length >= size) return first;

		const joined = Buffer.concat(this.chunks, this.length);

		this.chunks = [joined];

		return joined;
	}

	private take(size: number): Buffer {
		const source = this.join(size);
		const pdu = source.subarray(0, size);
		const rest = source.subarray(size);

		this.chunks[0] = rest;
		if (rest.length === 0) this.chunks.shift();
		this.length -= size;

		return pdu;
	}
}
