import type { LogInt } from '@larvit/log';
import type { PduObject, TlvInput } from './pdu.ts';
import type { Result } from './result.ts';
import type { Server as NetServer, Socket } from 'node:net';
import type { Server as TlsServer, TlsOptions } from 'node:tls';
import { EventEmitter } from 'node:events';
import { Session } from './session.ts';
import { createServer as createNetServer } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { paramText } from './defs/types.ts';
import { silentLog } from './log.ts';
import { tlvs } from './defs/tlvs.ts';

export type AuthenticateResult = { userData?: unknown } | boolean;

export type AuthenticateInput = {
	password: string;
	session: Session;
	systemId: string;
	systemType: string;
};

export type ServerOptions = {
	authenticate?: (input: AuthenticateInput) => Promise<AuthenticateResult> | AuthenticateResult;
	host?: string;
	idleTimeout?: number;
	log?: LogInt;
	maxOutstanding?: number;
	maxReassembly?: number;
	port?: number;
	reassemblyTimeout?: number;
	responseTimeout?: number;
	signal?: AbortSignal;
	tls?: TlsOptions | boolean;
};

export type ServerEvents = {
	serverError: [Error];
	session: [Session];
};

const defaults = {
	idleTimeout: 40_000,
	port: 2775,
};

const bindCommands = ['bind_receiver', 'bind_transceiver', 'bind_transmitter'];
const scInterfaceVersion = 0x34;

/** A listening SMPP server. Sessions arrive as `session` events; `close()` stops listening. */
export class SmppServer extends EventEmitter<ServerEvents> {
	readonly sessions = new Set<Session>();

	private readonly server: NetServer;

	constructor(server: NetServer) {
		super();
		this.server = server;
	}

	/** The port actually bound, which matters when 0 was requested. */
	get port(): number {
		const address = this.server.address();

		return typeof address === 'object' && address !== null ? address.port : 0;
	}

	/** Stops listening and closes every live session. */
	close(): Promise<void> {
		return new Promise(resolve => {
			for (const session of this.sessions) {
				session.close();
			}

			this.sessions.clear();
			this.server.close(() => { resolve(); });
		});
	}
}

async function authenticate(
	session: Session,
	pduObj: PduObject,
	options: ServerOptions,
): Promise<boolean> {
	if (!options.authenticate) return true;

	const params = pduObj.params;
	const result = await options.authenticate({
		password: typeof params.password === 'string' ? params.password : '',
		session,
		systemId: typeof params.system_id === 'string' ? params.system_id : '',
		systemType: typeof params.system_type === 'string' ? params.system_type : '',
	});

	if (result === false) return false;

	if (result !== true && typeof result === 'object') {
		session.userData = result.userData;
	}

	return true;
}

/**
 * A peer that declared below 0x34 must not be sent optional parameters at all; above it, an ESME
 * reads a missing sc_interface_version as this SMSC having none.
 */
function bindRespTlvs(pduObj: PduObject): Record<string, TlvInput> | undefined {
	const declared = pduObj.params.interface_version;
	const definition = tlvs.sc_interface_version;

	if (!definition || typeof declared !== 'number' || declared < scInterfaceVersion) return undefined;

	return {
		sc_interface_version: {
			tagId: definition.id,
			tagName: definition.tag,
			tagValue: scInterfaceVersion,
		},
	};
}

/**
 * Handles everything a peer may send before it is bound. Returns true when it has answered, so the
 * session leaves the PDU alone.
 */
async function onRequest(
	session: Session,
	pduObj: PduObject,
	options: ServerOptions,
): Promise<boolean> {
	const log = options.log ?? silentLog;

	if (session.loggedIn || pduObj.cmdName === 'unbind') return false;

	if (!bindCommands.includes(pduObj.cmdName)) {
		log.debug('server - command before bind', { cmdName: pduObj.cmdName });
		await session.sendReturn(pduObj, 'ESME_RINVBNDSTS');

		return true;
	}

	if (!await authenticate(session, pduObj, options)) {
		log.info('server - bind refused', { systemId: paramText(pduObj.params.system_id) });
		await session.sendReturn(pduObj, 'ESME_RBINDFAIL');

		return true;
	}

	session.loggedIn = true;
	await session.sendReturn(pduObj, 'ESME_ROK', {}, bindRespTlvs(pduObj));
	log.verbose('server - bound', { systemId: paramText(pduObj.params.system_id) });

	return true;
}

function onConnection(sock: Socket, options: ServerOptions, server: SmppServer): void {
	const log = options.log ?? silentLog;
	const session = new Session({
		idleTimeout: options.idleTimeout ?? defaults.idleTimeout,
		log,
		maxOutstanding: options.maxOutstanding,
		maxReassembly: options.maxReassembly,
		onRequest: (bound, pduObj) => onRequest(bound, pduObj, options),
		reassemblyTimeout: options.reassemblyTimeout,
		responseTimeout: options.responseTimeout,
		sock,
	});

	server.sessions.add(session);
	session.on('close', () => server.sessions.delete(session));

	log.verbose('server - incoming connection', {
		remoteAddress: sock.remoteAddress ?? '',
		remotePort: sock.remotePort ?? 0,
	});

	server.emit('session', session);
}

/** Node reports a rejected handshake as `tlsClientError`, which is never an `error` event. */
function createSecureListener(tlsOptions: TlsOptions, log: LogInt): TlsServer {
	const listener = createTlsServer(tlsOptions);

	listener.on('tlsClientError', err => {
		log.warn('server - client handshake failed', { message: err.message });
	});

	return listener;
}

/** Starts listening for SMPP connections. Resolves once the socket is bound. */
export function server(options: ServerOptions = {}): Promise<Result<{ server: SmppServer }>> {
	return new Promise(resolve => {
		const log = options.log ?? silentLog;
		const port = options.port ?? defaults.port;
		const useTls = options.tls !== undefined && options.tls !== false;
		const tlsOptions = typeof options.tls === 'object' ? options.tls : undefined;

		if (useTls && !tlsOptions) {
			log.warn('server - tls without a certificate', { port });
			resolve({ err: new Error('Listening over TLS needs tls: { cert, key }') });

			return;
		}

		const listener = tlsOptions ? createSecureListener(tlsOptions, log) : createNetServer();
		const smpp = new SmppServer(listener);

		listener.on(useTls ? 'secureConnection' : 'connection', (sock: Socket) => {
			onConnection(sock, options, smpp);
		});

		const onStartupError = (err: Error): void => {
			listener.removeListener('error', onStartupError);
			log.warn('server - could not listen', { message: err.message, port });
			resolve({ err });
		};

		listener.once('error', onStartupError);

		listener.listen(port, options.host, () => {
			listener.removeListener('error', onStartupError);

			// Past startup, a listener error is a runtime event, not a failed start.
			listener.on('error', (err: Error) => {
				log.warn('server - error', { message: err.message });
				smpp.emit('serverError', err);
			});

			log.info('server - listening', { host: options.host ?? '*', port: smpp.port });

			if (options.signal) {
				options.signal.addEventListener('abort', () => { void smpp.close(); }, { once: true });
			}

			resolve({ server: smpp });
		});
	});
}
