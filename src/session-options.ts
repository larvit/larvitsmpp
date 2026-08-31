import type { Dlr } from './dlr.ts';
import type { MessageDlr } from './dlr-merger.ts';
import type { PduObject } from './pdu.ts';
import type { Result, VoidResult } from './result.ts';
import type { Session } from './session.ts';
import type { SmppLog } from './log.ts';
import type { SmsIdFormat } from './sms-id.ts';
import type { Sms } from './sms.ts';
import type { Socket } from 'node:net';
import { isSmsIdNotation, smsIdNotations, smsIdPlaces } from './sms-id.ts';

export type SessionEvents = {
	close: [];
	data: [Buffer];
	disconnected: [];
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

export type BindType = 'receiver' | 'transceiver' | 'transmitter';

export function bindTypeFromCommand(cmdName: string): BindType | undefined {
	if (cmdName === 'bind_receiver') return 'receiver';
	if (cmdName === 'bind_transceiver') return 'transceiver';
	if (cmdName === 'bind_transmitter') return 'transmitter';

	return undefined;
}

/**
 * Whether a bind direction carries a command at all. A receiver-bound ESME submits nothing and a
 * transmitter-bound one is delivered nothing, whichever end of the link is looking. A session that
 * has not bound carries everything, since nothing has declared a direction yet.
 */
export function bindCarries(bindType: BindType | undefined, cmdName: string): boolean {
	if (bindType === 'receiver') return cmdName !== 'submit_sm';
	if (bindType === 'transmitter') return cmdName !== 'deliver_sm';

	return true;
}

export type SendOptions = { signal?: AbortSignal | undefined };

/** An already-aborted signal skips the drain; one that fires during it cuts the wait short. */
export type CloseOptions = { signal?: AbortSignal | undefined };

/**
 * First refusal on every incoming request. Returning true means the hook answered it and the
 * built-in handling is skipped — this is how the server owns bind without the session also
 * replying "invalid command".
 */
export type OnRequest = (session: Session, pduObj: PduObject) => Promise<boolean>;

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
	log?: SmppLog | undefined;
	maxOctets?: number | undefined;
	maxOutstanding?: number | undefined;
	maxReassembly?: number | undefined;
	onRequest?: OnRequest | undefined;
	reassemblyTimeout?: number | undefined;
	reconnect?: ReconnectOptions | undefined;
	responseTimeout?: number | undefined;
	/** How long a drain waits for the requests already on the wire. 0 waits forever. */
	shutdownTimeout?: number | undefined;
	/** The notation the peer writes message ids in, where it is not the one they are compared in. */
	smsIdFormat?: SmsIdFormat | undefined;
	sock: Socket;
	/** This end's own identity, answered to the peer in place of the one it sent. */
	systemId?: string | undefined;
};

export const defaultSystemId = '';

/** SMPP 3.4: a peer that declares no version at all is one from before optional parameters. */
export const undeclaredInterfaceVersion = 0x00;

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
	shutdownTimeout: 5000,
	systemId: defaultSystemId,
};

/**
 * A count below 1 does not fail loudly anywhere downstream: `maxOutstanding: 0` leaves every send
 * queued behind a slot that is never freed, so the call never settles at all.
 */
export function checkSessionOptions(options: CheckableOptions): VoidResult {
	const checked = checkLimits([
		['idleTimeout', options.idleTimeout ?? 0, 0],
		['maxOutstanding', options.maxOutstanding ?? defaults.maxOutstanding, 1],
		['maxReassembly', options.maxReassembly ?? defaults.maxReassembly, 1],
		['reassemblyTimeout', options.reassemblyTimeout ?? defaults.reassemblyTimeout, 0],
		['responseTimeout', options.responseTimeout ?? defaults.responseTimeout, 0],
		['shutdownTimeout', options.shutdownTimeout ?? defaults.shutdownTimeout, 0],
	]);

	if (checked.err) return checked;

	const backoff = checkReconnect(options.reconnect);

	return backoff.err ? backoff : checkSmsIdFormat(options.smsIdFormat);
}

function checkLimits(limits: [string, number, number][]): VoidResult {
	for (const [name, value, min] of limits) {
		if (!Number.isInteger(value) || value < min) {
			return { err: new Error(`${name} must be ${String(min)} or more, got ${String(value)}`) };
		}
	}

	return {};
}

const backoffDelays: readonly string[] = ['maxDelay', 'minDelay'];

function checkReconnect(reconnect: unknown): VoidResult {
	if (reconnect === undefined || reconnect === false) return {};

	if (!isRecord(reconnect)) {
		return { err: new Error('reconnect takes { maxDelay, minDelay }, or false to turn it off') };
	}

	for (const key of Object.keys(reconnect)) {
		if (!backoffDelays.includes(key)) {
			return { err: new Error(`reconnect has no ${key}, name ${backoffDelays.join(' or ')}`) };
		}
	}

	const maxDelay = delayOr(reconnect.maxDelay, defaults.maxDelay);
	const minDelay = delayOr(reconnect.minDelay, defaults.minDelay);
	// A delay of 0 never doubles, so the backoff never starts and every retry lands at once.
	const checked = checkLimits([['maxDelay', maxDelay, 1], ['minDelay', minDelay, 1]]);

	if (checked.err) return checked;

	if (maxDelay < minDelay) {
		return { err: new Error(`maxDelay must be minDelay (${String(minDelay)}) or more, got ${String(maxDelay)}`) };
	}

	return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A tuning value that is not a number lands on NaN, which the range check refuses by name. */
function delayOr(value: unknown, fallback: number): number {
	if (value === undefined) return fallback;

	return typeof value === 'number' ? value : NaN;
}

function checkSmsIdFormat(smsIdFormat: unknown): VoidResult {
	if (smsIdFormat === undefined) return {};

	if (!isRecord(smsIdFormat)) {
		return { err: new Error('smsIdFormat names a notation per place, as { receipt, submitResp }') };
	}

	for (const [place, notation] of Object.entries(smsIdFormat)) {
		if (!smsIdPlaces.includes(place)) {
			return { err: new Error(`smsIdFormat has no ${place}, name ${smsIdPlaces.join(' or ')}`) };
		}

		if (notation === undefined || isSmsIdNotation(notation)) continue;

		// String() throws on a null-prototype object, and this value is whatever the caller passed.
		const got = typeof notation === 'string' ? notation : typeof notation;

		return { err: new Error(`smsIdFormat.${place} must be ${smsIdNotations.join(' or ')}, got ${got}`) };
	}

	return {};
}

/** What the checker reads, as it arrives: a caller without types can put anything in it. */
export type CheckableOptions = {
	idleTimeout?: number | undefined;
	maxOutstanding?: number | undefined;
	maxReassembly?: number | undefined;
	reassemblyTimeout?: number | undefined;
	reconnect?: unknown;
	responseTimeout?: number | undefined;
	shutdownTimeout?: number | undefined;
	smsIdFormat?: unknown;
};
