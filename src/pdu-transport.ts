import type { PduObject } from './pdu.ts';
import type { SmppLog } from './log.ts';
import type { Socket } from 'node:net';
import type { VoidResult } from './result.ts';
import { PduFramer } from './pdu-framer.ts';
import { PduRefusedError, pduToObj } from './pdu.ts';

export type PduTransportOptions = {
	log: SmppLog;
	onClose: () => void;
	/** Raw bytes, before framing. */
	onData: (chunk: Buffer) => void;
	onError: (err: Error) => void;
	/** A complete PDU, before it is parsed. */
	onFramed: (pdu: Buffer) => void;
	onPdu: (pduObj: PduObject) => void;
	/** A framed PDU the codec could not read. The stream is still in sync, so the link is not lost. */
	onRefused: (refused: PduRefusedError) => void;
	/** Nothing further can be read off this stream, whatever the socket does next. */
	onUnreadable: (err: Error) => void;
};

/** A socket read as a stream of complete PDUs. A reconnect attaches a new socket in its place. */
export class PduTransport {
	private readonly options: PduTransportOptions;
	private framer = new PduFramer();
	private socket: Socket;

	constructor(options: PduTransportOptions, sock: Socket) {
		this.options = options;
		this.socket = sock;
		this.wire(sock);
	}

	get sock(): Socket {
		return this.socket;
	}

	/** Takes over a freshly opened socket. Half a PDU left on the old one must not prefix this one. */
	attach(sock: Socket): void {
		// The socket being replaced is already dead, and its three handlers still point here.
		this.socket.removeAllListeners();
		this.socket = sock;
		this.framer = new PduFramer();
		this.wire(sock);
	}

	private wire(sock: Socket): void {
		sock.on('data', chunk => { this.read(chunk); });
		sock.on('close', () => { this.options.onClose(); });
		sock.on('error', err => {
			this.options.log.warn('transport - socket error', { message: err.message });
			this.options.onError(err);
			this.options.onClose();
		});
	}

	write(pdu: Buffer): VoidResult {
		if (this.socket.destroyed) return { err: new Error('Socket is closed') };

		this.socket.write(pdu);

		return {};
	}

	private read(chunk: Buffer): void {
		this.options.onData(chunk);
		this.framer.push(chunk);

		const framed = this.framer.next();

		if (framed.err) {
			this.options.log.warn('transport - unusable stream', { message: framed.err.message });
			this.options.onUnreadable(framed.err);

			return;
		}

		for (const pdu of framed.pdus) {
			this.options.onFramed(pdu);

			const parsed = pduToObj(pdu);

			if (parsed.err instanceof PduRefusedError) {
				this.options.log.warn('transport - refusing a PDU it could not read', {
					message: parsed.err.message,
					reason: parsed.err.reason,
				});
				this.options.onRefused(parsed.err);

				continue;
			}

			if (parsed.err) {
				this.options.log.warn('transport - could not parse an incoming PDU', {
					message: parsed.err.message,
				});
				this.options.onUnreadable(parsed.err);

				return;
			}

			this.options.onPdu(parsed.pduObj);
		}
	}
}
