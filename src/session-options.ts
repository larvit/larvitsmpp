import type { Dlr } from './dlr.ts';
import type { LogInt } from '@larvit/log';
import type { MessageDlr } from './dlr-merger.ts';
import type { PduObject } from './pdu.ts';
import type { Result, VoidResult } from './result.ts';
import type { Session } from './session.ts';
import type { Sms } from './sms.ts';
import type { Socket } from 'node:net';

export type SessionEvents = {
	close: [];
	data: [Buffer];
	dlr: [Dlr, PduObject];
	incomingPdu: [Buffer];
	incomingPduObj: [PduObject];
	messageDlr: [MessageDlr];
	reconnected: [];
	sessionError: [Error];
	sms: [Sms];
};

export const bindCommands: readonly string[] = [
	'bind_receiver',
	'bind_transceiver',
	'bind_transmitter',
];

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
	maxOctets?: number | undefined;
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

/**
 * A count below 1 does not fail loudly anywhere downstream: `maxOutstanding: 0` leaves every send
 * queued behind a slot that is never freed, so the call never settles at all.
 */
export function checkSessionOptions(options: SessionCounts): VoidResult {
	const limits: [string, number, number][] = [
		['idleTimeout', options.idleTimeout ?? 0, 0],
		['maxOutstanding', options.maxOutstanding ?? defaults.maxOutstanding, 1],
		['maxReassembly', options.maxReassembly ?? defaults.maxReassembly, 1],
		['reassemblyTimeout', options.reassemblyTimeout ?? defaults.reassemblyTimeout, 0],
		['responseTimeout', options.responseTimeout ?? defaults.responseTimeout, 0],
	];

	for (const [name, value, min] of limits) {
		if (!Number.isInteger(value) || value < min) {
			return { err: new Error(`${name} must be ${String(min)} or more, got ${String(value)}`) };
		}
	}

	return {};
}

export type SessionCounts = {
	idleTimeout?: number | undefined;
	maxOutstanding?: number | undefined;
	maxReassembly?: number | undefined;
	reassemblyTimeout?: number | undefined;
	responseTimeout?: number | undefined;
};
