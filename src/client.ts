import type { ConnectionOptions } from 'node:tls';
import type { Result, VoidResult } from './result.ts';
import type { BindType } from './session-options.ts';
import type { SmppLog } from './log.ts';
import type { SmsIdFormat } from './sms-id.ts';
import type { Socket } from 'node:net';
export type { BindType };

import { Session } from './session.ts';
import { checkSessionOptions, undeclaredInterfaceVersion } from './session-options.ts';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { defaultInterfaceVersion } from './defs/constants.ts';
import { silentLog } from './log.ts';

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
	reconnect?: { maxDelay?: number; minDelay?: number };
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

function createSession(options: ClientOptions, log: SmppLog, sock: Socket): Session {
	const enquireLinkInterval = options.enquireLinkInterval ?? defaults.enquireLinkInterval;

	return new Session({
		enquireLinkInterval,
		idleTimeout: options.idleTimeout ?? enquireLinkInterval * defaults.idleTimeoutFactor,
		log,
		maxOutstanding: options.maxOutstanding,
		responseTimeout: options.responseTimeout,
		shutdownTimeout: options.shutdownTimeout,
		smsIdFormat: options.smsIdFormat,
		sock,
		...(options.reconnect
			? {
				reconnect: {
					connect: () => openSocket(options),
					maxDelay: options.reconnect.maxDelay,
					minDelay: options.reconnect.minDelay,
					onConnected: reconnected => bind(reconnected, options),
				},
			}
			: {}),
	});
}

async function connect(options: ClientOptions, log: SmppLog): Promise<Result<{ sock: Socket }>> {
	const checked = checkSessionOptions(options);

	if (checked.err) {
		log.warn('client - option out of range', { message: checked.err.message });

		return { err: checked.err };
	}

	const opened = await openSocket(options);

	if (opened.err) {
		log.warn('client - could not connect', {
			host: options.host ?? defaults.host,
			message: opened.err.message,
			port: options.port ?? defaults.port,
		});

		return { err: opened.err };
	}

	return { sock: opened.sock };
}

/** Connects to an SMSC and binds. */
export async function client(options: ClientOptions = {}): Promise<Result<{ session: Session }>> {
	const log = options.log ?? silentLog;
	const opened = await connect(options, log);

	if (opened.err) return { err: opened.err };

	const session = createSession(options, log, opened.sock);
	const signal = options.signal;

	if (signal?.aborted === true) {
		void session.close({ signal });

		return { err: new Error('Aborted before binding') };
	}

	// Registered before the bind: an abort landing while it is in flight has to close the session.
	signal?.addEventListener('abort', () => { void session.close({ signal }); }, { once: true });

	const bound = await bind(session, options);

	if (bound.err) {
		void session.close({ signal });

		return { err: bound.err };
	}

	return { session };
}
