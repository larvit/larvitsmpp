import type { LogInt } from '@larvit/log';
import type { PduObject } from './pdu.ts';
import type { Result, VoidResult } from './result.ts';
import type { Session } from './session.ts';
import type { Socket } from 'node:net';

export type SendOptions = { signal?: AbortSignal | undefined };

/**
 * How to come back after an unexpected disconnect. The session owns the retry loop; the caller
 * supplies how to open a socket and what to do once it is open (bind, for a client).
 */
export type ReconnectOptions = {
	connect: () => Promise<Result<{ sock: Socket }>>;
	maxDelay?: number | undefined;
	minDelay?: number | undefined;
	onConnected: (session: Session) => Promise<VoidResult>;
};

export type SessionOptions = {
	enquireLinkInterval?: number | undefined;
	idleTimeout?: number | undefined;
	log?: LogInt | undefined;
	maxOutstanding?: number | undefined;
	maxReassembly?: number | undefined;
	/**
	 * First refusal on every incoming request. Returning true means the hook answered it and the
	 * built-in handling is skipped — this is how the server owns bind without the session also
	 * replying "invalid command".
	 */
	onRequest?: ((session: Session, pduObj: PduObject) => Promise<boolean>) | undefined;
	reassemblyTimeout?: number | undefined;
	reconnect?: ReconnectOptions | undefined;
	responseTimeout?: number | undefined;
	sock: Socket;
	/** This end's own identity, answered to the peer in place of the one it sent. */
	systemId?: string | undefined;
};

export const defaultSystemId = '';

export const defaults = {
	/** Receipts of a multipart message can be a working day apart, so the cap does the bounding. */
	dlrMergeTimeout: 86_400_000,
	maxDelay: 30_000,
	maxDlrMerges: 1000,
	maxOutstanding: 10,
	maxReassembly: 1000,
	minDelay: 1000,
	reassemblyTimeout: 300_000,
	responseTimeout: 30_000,
	systemId: defaultSystemId,
};
