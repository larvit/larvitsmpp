import type { ConnectionOptions } from 'node:tls';
import type { LogInt } from '@larvit/log';
import type { Result, VoidResult } from './result.ts';
import type { Socket } from 'node:net';
import { Session } from './session.ts';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { silentLog } from './log.ts';

export type BindType = 'receiver' | 'transceiver' | 'transmitter';

export type ClientOptions = {
	addressRange?: string;
	addrNpi?: number;
	addrTon?: number;
	bindType?: BindType;
	enquireLinkInterval?: number;
	host?: string;
	interfaceVersion?: number;
	log?: LogInt;
	maxOutstanding?: number;
	password?: string;
	port?: number;
	reconnect?: { maxDelay?: number; minDelay?: number };
	responseTimeout?: number;
	signal?: AbortSignal;
	systemType?: string;
	tls?: ConnectionOptions | boolean;
	username?: string;
};

const defaults = {
	bindType: 'transceiver',
	enquireLinkInterval: 20_000,
	host: 'localhost',
	/** SMPP 3.4. The 3.4 spec reserves every value above it, so 0x50 is undefined to a 3.4 SMSC. */
	interfaceVersion: 0x34,
	password: 'pass',
	port: 2775,
	username: 'user',
} as const;

/**
 * Opens the socket. 0.4.0 built a bare `new tls.Socket()` for `tls: true`, which never performs a
 * handshake, so those connections were not encrypted at all.
 */
function openSocket(options: ClientOptions): Promise<Result<{ sock: Socket }>> {
	return new Promise(resolve => {
		const host = options.host ?? defaults.host;
		const port = options.port ?? defaults.port;
		const signal = options.signal;

		if (signal?.aborted === true) {
			resolve({ err: new Error('Aborted before connecting') });

			return;
		}

		const sock = options.tls === undefined || options.tls === false
			? netConnect({ host, port })
			: tlsConnect({
				host,
				port,
				...(typeof options.tls === 'object' ? options.tls : {}),
			});

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
		sock.once(options.tls === undefined || options.tls === false ? 'connect' : 'secureConnect', () => {
			settle({ sock });
		});
	});
}

async function bind(session: Session, options: ClientOptions): Promise<VoidResult> {
	const bindType = options.bindType ?? defaults.bindType;
	const systemId = options.username ?? defaults.username;
	const sent = await session.send({
		cmdName: `bind_${bindType}`,
		params: {
			address_range: options.addressRange ?? '',
			addr_npi: options.addrNpi ?? 0,
			addr_ton: options.addrTon ?? 0,
			interface_version: options.interfaceVersion ?? defaults.interfaceVersion,
			password: options.password ?? defaults.password,
			system_id: systemId,
			system_type: options.systemType ?? '',
		},
		...(options.signal ? { signal: options.signal } : {}),
	});

	if (sent.err) return { err: sent.err };

	if (sent.pduObj.cmdStatus !== 'ESME_ROK') {
		session.log.info('client - bind refused', {
			cmdStatus: sent.pduObj.cmdStatus ?? sent.pduObj.cmdStatusId,
			systemId,
		});

		return { err: new Error(`Remote host refused login: ${sent.pduObj.cmdStatus ?? 'unknown'}`) };
	}

	session.loggedIn = true;
	session.log.info('client - bound', { bindType, systemId });

	return {};
}

/** Connects to an SMSC and binds. */
export async function client(options: ClientOptions = {}): Promise<Result<{ session: Session }>> {
	const log = options.log ?? silentLog;
	const opened = await openSocket(options);

	if (opened.err) {
		log.warn('client - could not connect', {
			host: options.host ?? defaults.host,
			message: opened.err.message,
			port: options.port ?? defaults.port,
		});

		return { err: opened.err };
	}

	const session = new Session({
		enquireLinkInterval: options.enquireLinkInterval ?? defaults.enquireLinkInterval,
		log,
		maxOutstanding: options.maxOutstanding,
		responseTimeout: options.responseTimeout,
		sock: opened.sock,
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

	const bound = await bind(session, options);

	if (bound.err) {
		session.close();

		return { err: bound.err };
	}

	if (options.signal) {
		options.signal.addEventListener('abort', () => { session.close(); }, { once: true });
	}

	return { session };
}
