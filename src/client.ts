import type { ConnectionOptions } from 'node:tls';
import type { Result, VoidResult } from './result.ts';
import type { BindType, ReconnectOptions } from './session-options.ts';
import type { SmppLog } from './log.ts';
import type { SmsIdFormat } from './sms-id.ts';
import type { Socket } from 'node:net';
export type { BindType };

import { ReconnectLoop } from './reconnect-loop.ts';
import { Session } from './session.ts';
import { checkSessionOptions, undeclaredInterfaceVersion } from './session-options.ts';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { defaultInterfaceVersion } from './defs/constants.ts';
import { guardedLog } from './log.ts';

/** `fromStart` puts the very first connect and bind through the same backoff loop as a drop. */
type ReconnectTuning = { fromStart?: boolean; maxDelay?: number; minDelay?: number };

export type ClientOptions = {
	addressRange?: string;
	addrNpi?: number;
	addrTon?: number;
	bindType?: BindType;
	enquireLinkInterval?: number;
	host?: string;
	idleTimeout?: number;
	interfaceVersion?: number;
	log?: SmppLog;
	maxOutstanding?: number;
	password?: string;
	port?: number;
	reconnect?: ReconnectTuning | false;
	responseTimeout?: number;
	shutdownTimeout?: number;
	signal?: AbortSignal;
	smsIdFormat?: SmsIdFormat;
	systemType?: string;
	tls?: ConnectionOptions | boolean;
	username?: string;
};

const defaults = {
	bindType: 'transceiver',
	enquireLinkInterval: 20_000,
	host: 'localhost',
	/** The idle timeout is what notices a dead link, so it has to outlast one silent probe. */
	idleTimeoutFactor: 2,
	interfaceVersion: defaultInterfaceVersion,
	password: 'pass',
	port: 2775,
	username: 'user',
} as const;

function openSocket(options: ClientOptions): Promise<Result<{ sock: Socket }>> {
	const host = options.host ?? defaults.host;
	const port = options.port ?? defaults.port;
	const secure = options.tls !== undefined && options.tls !== false;
	const tlsOptions = typeof options.tls === 'object' ? options.tls : undefined;

	return new Promise(resolve => {
		const signal = options.signal;

		if (signal?.aborted === true) {
			resolve({ err: new Error('Aborted before connecting') });

			return;
		}

		let sock: Socket;

		try {
			sock = secure ? tlsConnect({ host, port, ...tlsOptions }) : netConnect({ host, port });
		} catch (thrown: unknown) {
			resolve({ err: thrown instanceof Error ? thrown : new Error(String(thrown)) });

			return;
		}

		const settle = (result: Result<{ sock: Socket }>): void => {
			sock.removeListener('error', onError);
			signal?.removeEventListener('abort', onAbort);
			resolve(result);
		};

		function onError(err: Error): void {
			settle({ err });
		}

		function onAbort(): void {
			sock.destroy();
			settle({ err: new Error('Aborted while connecting') });
		}

		sock.once('error', onError);
		signal?.addEventListener('abort', onAbort, { once: true });
		sock.once(secure ? 'secureConnect' : 'connect', () => {
			settle({ sock });
		});
	});
}

/** Every connect this client makes goes through here, so a failed one is named the same way once. */
async function connectSocket(options: ClientOptions, log: SmppLog): Promise<Result<{ sock: Socket }>> {
	const opened = await openSocket(options);

	if (opened.err) {
		log.warn('client - could not connect', {
			host: options.host ?? defaults.host,
			message: opened.err.message,
			port: options.port ?? defaults.port,
		});
	}

	return opened;
}

function bindParams(options: ClientOptions, systemId: string) {
	return {
		address_range: options.addressRange ?? '',
		addr_npi: options.addrNpi ?? 0,
		addr_ton: options.addrTon ?? 0,
		interface_version: options.interfaceVersion ?? defaults.interfaceVersion,
		password: options.password ?? defaults.password,
		system_id: systemId,
		system_type: options.systemType ?? '',
	};
}

async function bind(session: Session, options: ClientOptions): Promise<VoidResult> {
	const bindType = options.bindType ?? defaults.bindType;
	const systemId = options.username ?? defaults.username;
	const sent = await session.send(
		{ cmdName: `bind_${bindType}`, params: bindParams(options, systemId) },
		options.signal ? { signal: options.signal } : {},
	);

	if (sent.err) return { err: sent.err };

	if (sent.pduObj.cmdStatus !== 'ESME_ROK') {
		session.log.info('client - bind refused', {
			cmdStatus: sent.pduObj.cmdStatus ?? sent.pduObj.cmdStatusId,
			systemId,
		});

		return { err: new Error(`Remote host refused login: ${sent.pduObj.cmdStatus ?? 'unknown'}`) };
	}

	const declared = sent.pduObj.tlvs.sc_interface_version?.tagValue;

	session.boundAs = bindType;
	session.loggedIn = true;
	session.peerInterfaceVersion = typeof declared === 'number'
		? declared
		: undeclaredInterfaceVersion;
	session.log.info('client - bound', { bindType, systemId });

	return {};
}

function reconnectFor(options: ClientOptions, log: SmppLog): ReconnectOptions | undefined {
	if (options.reconnect === false) return undefined;

	const tuning = options.reconnect ?? {};

	return {
		connect: () => connectSocket(options, log),
		maxDelay: tuning.maxDelay,
		minDelay: tuning.minDelay,
		onConnected: reconnected => bind(reconnected, options),
	};
}

function createSession(options: ClientOptions, log: SmppLog, sock: Socket): Session {
	const enquireLinkInterval = options.enquireLinkInterval ?? defaults.enquireLinkInterval;

	return new Session({
		enquireLinkInterval,
		idleTimeout: options.idleTimeout ?? enquireLinkInterval * defaults.idleTimeoutFactor,
		log,
		maxOutstanding: options.maxOutstanding,
		reconnect: reconnectFor(options, log),
		responseTimeout: options.responseTimeout,
		shutdownTimeout: options.shutdownTimeout,
		smsIdFormat: options.smsIdFormat,
		sock,
	});
}

async function connectAndBind(
	options: ClientOptions,
	log: SmppLog,
): Promise<Result<{ session: Session }>> {
	const opened = await connectSocket(options, log);

	if (opened.err) return { err: opened.err };

	return bindOn(createSession(options, log, opened.sock), options);
}

/** Binds a session the caller has not seen yet, so a failure takes it down instead of surfacing. */
async function bindOn(
	session: Session,
	options: ClientOptions,
): Promise<Result<{ session: Session }>> {
	const signal = options.signal;

	if (signal?.aborted === true) {
		void session.close({ signal });

		return { err: new Error('Aborted before binding') };
	}

	const onAbort = (): void => { void session.close({ signal }); };

	// Registered before the bind: an abort landing while it is in flight has to close the session.
	signal?.addEventListener('abort', onAbort, { once: true });

	const bound = await bind(session, options);

	if (bound.err) {
		signal?.removeEventListener('abort', onAbort);
		// close() must reach the loop's stop() before its first await, or this session retries too.
		void session.close({ signal });

		return { err: bound.err };
	}

	return { session };
}

function retriesFromStart(reconnect: ClientOptions['reconnect']): reconnect is ReconnectTuning {
	return reconnect !== undefined && reconnect !== false && reconnect.fromStart === true;
}

/** A fresh session per attempt, and the failure to answer an abort with when none of them binds. */
function initialAttempts(options: ClientOptions, log: SmppLog) {
	let lastErr: Error | undefined = undefined;

	return {
		bind: async (sock: Socket): Promise<Result<{ session: Session }>> => {
			const bound = await bindOn(createSession(options, log, sock), options);

			if (bound.err) lastErr = bound.err;

			return bound;
		},
		connect: async (): Promise<Result<{ sock: Socket }>> => {
			const opened = await connectSocket(options, log);

			if (opened.err) lastErr = opened.err;

			return opened;
		},
		lastErr: (): Error | undefined => lastErr,
	};
}

/** Retries the first connect and bind, on the backoff a drop takes, until one of them binds. */
function keepTrying(
	options: ClientOptions,
	log: SmppLog,
	tuning: ReconnectTuning,
): Promise<Result<{ session: Session }>> {
	return new Promise(resolve => {
		const attempts = initialAttempts(options, log);
		const signal = options.signal;
		let settled = false;
		const loop = new ReconnectLoop({
			connect: attempts.connect,
			log,
			maxDelay: tuning.maxDelay,
			minDelay: tuning.minDelay,
			onConnected: async sock => {
				const bound = await attempts.bind(sock);

				if (bound.err) return { err: bound.err };

				settle({ session: bound.session });

				return {};
			},
			// Awaited with no other handle, so an unref()'d wait would exit the process unbound.
			unref: false,
		});

		function settle(result: Result<{ session: Session }>): void {
			if (settled) return;

			settled = true;
			loop.stop();
			signal?.removeEventListener('abort', onAbort);
			resolve(result);
		}

		function onAbort(): void {
			settle({ err: new Error('Aborted while connecting', { cause: attempts.lastErr() }) });
		}

		signal?.addEventListener('abort', onAbort, { once: true });
		loop.schedule();
	});
}

/** Connects to an SMSC and binds. */
export async function client(options: ClientOptions = {}): Promise<Result<{ session: Session }>> {
	const log = guardedLog(options.log);
	const checked = checkSessionOptions(options);

	if (checked.err) {
		log.warn('client - unusable option', { message: checked.err.message });

		return { err: checked.err };
	}

	const first = await connectAndBind(options, log);
	const reconnect = options.reconnect;

	if (!first.err || options.signal?.aborted === true || !retriesFromStart(reconnect)) return first;

	return keepTrying(options, log, reconnect);
}
