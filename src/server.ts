import type { PduObject, TlvInput } from './pdu.ts';
import type { Result, VoidResult } from './result.ts';
import type { Server as NetServer, Socket } from 'node:net';
import type { Server as TlsServer, TlsOptions } from 'node:tls';
import type { SmppLog } from './log.ts';
import { EventEmitter } from 'node:events';
import { Session, bindCommands, defaultSystemId } from './session.ts';
import { bindTypeFromCommand, checkSessionOptions, undeclaredInterfaceVersion } from './session-options.ts';
import { createServer as createNetServer } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { defaultInterfaceVersion } from './defs/constants.ts';
import { errorFrom } from './error-from.ts';
import { paramText } from './defs/types.ts';
import { silentLog } from './log.ts';

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
	interfaceVersion?: number;
	log?: SmppLog;
	maxOutstanding?: number;
	maxOctets?: number;
	maxReassembly?: number;
	port?: number;
	reassemblyTimeout?: number;
	responseTimeout?: number;
	shutdownTimeout?: number;
	signal?: AbortSignal;
	systemId?: string;
	tls?: TlsOptions | boolean;
};

export type ServerEvents = {
	serverError: [Error];
	session: [Session];
};

const defaults = {
	idleTimeout: 40_000,
	interfaceVersion: defaultInterfaceVersion,
	port: 2775,
	systemId: defaultSystemId,
};

/** A listener may return a promise: an `async` one that rejects is routed like one that throws. */
type ServerListener<K extends keyof ServerEvents> = (...args: ServerEvents[K]) => unknown;

/** A listening SMPP server. Sessions arrive as `session` events; `close()` stops listening. */
export class SmppServer extends EventEmitter<ServerEvents> {
	declare addListener: <K extends keyof ServerEvents>(event: K, listener: ServerListener<K>) => this;
	declare off: <K extends keyof ServerEvents>(event: K, listener: ServerListener<K>) => this;
	declare on: <K extends keyof ServerEvents>(event: K, listener: ServerListener<K>) => this;
	declare once: <K extends keyof ServerEvents>(event: K, listener: ServerListener<K>) => this;
	declare prependListener: <K extends keyof ServerEvents>(event: K, listener: ServerListener<K>) => this;
	declare prependOnceListener: <K extends keyof ServerEvents>(event: K, listener: ServerListener<K>) => this;
	declare removeListener: <K extends keyof ServerEvents>(event: K, listener: ServerListener<K>) => this;

	readonly sessions = new Set<Session>();

	private readonly log: SmppLog;
	private readonly server: NetServer;

	constructor(server: NetServer, log: SmppLog) {
		super({ captureRejections: true });
		this.log = log;
		this.server = server;
	}

	/** The port actually bound, which matters when 0 was requested. */
	get port(): number {
		const address = this.server.address();

		return typeof address === 'object' && address !== null ? address.port : 0;
	}

	/** A listener that throws is the application's bug; it must not become ours. Hard rule 1. */
	override emit<K extends keyof ServerEvents>(
		event: K,
		...args: K extends keyof ServerEvents ? ServerEvents[K] : never
	): boolean {
		try {
			return super.emit(event, ...args);
		} catch (thrown: unknown) {
			const err = errorFrom(thrown);

			this.log.error('server - a listener threw', { event, message: err.message });

			// Guarded against the listener that throws being the one listening for this.
			if (event !== 'serverError') this.emit('serverError', err);

			return false;
		}
	}

	/** The same guard for a listener that rejects rather than throws; captureRejections routes here. */
	override [EventEmitter.captureRejectionSymbol](
		reason: unknown,
		...args: [event: keyof ServerEvents, ...rest: unknown[]]
	): void {
		const [event] = args;
		const error = errorFrom(reason);

		this.log.error('server - a listener rejected', { event, message: error.message });

		if (event !== 'serverError') this.emit('serverError', error);
	}

	/** Stops listening and closes every live session, draining each one first. */
	async close(): Promise<void> {
		const live = [...this.sessions];

		this.sessions.clear();

		await Promise.all(live.map(async session => {
			const closed = await session.close().catch((thrown: unknown) => ({ err: errorFrom(thrown) }));

			if (closed.err) this.emit('serverError', closed.err);
		}));

		return new Promise(resolve => { this.server.close(() => { resolve(); }); });
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

/** An ESME reads a missing sc_interface_version as this SMSC having none. */
function bindRespTlvs(session: Session, options: ServerOptions): Record<string, TlvInput> | undefined {
	if (!session.acceptsOptionalParams()) return undefined;

	return {
		sc_interface_version: { tagValue: options.interfaceVersion ?? defaults.interfaceVersion },
	};
}

async function acceptBind(
	session: Session,
	pduObj: PduObject,
	options: ServerOptions,
	identity: Record<string, string>,
): Promise<void> {
	const declared = pduObj.params.interface_version;

	session.boundAs = bindTypeFromCommand(pduObj.cmdName);
	session.loggedIn = true;
	session.peerInterfaceVersion = typeof declared === 'number'
		? declared
		: undeclaredInterfaceVersion;

	await session.sendReturn(pduObj, 'ESME_ROK', identity, bindRespTlvs(session, options));
}

async function onBind(session: Session, pduObj: PduObject, options: ServerOptions): Promise<void> {
	const log = options.log ?? silentLog;
	const identity = { system_id: options.systemId ?? defaults.systemId };
	const systemId = paramText(pduObj.params.system_id);

	if (!await authenticate(session, pduObj, options)) {
		log.info('server - bind refused', { systemId });
		await session.sendReturn(pduObj, 'ESME_RBINDFAIL', identity);

		return;
	}

	await acceptBind(session, pduObj, options, identity);
	log.verbose('server - bound', { systemId });
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
	if (session.loggedIn || pduObj.cmdName === 'unbind') return false;

	if (!bindCommands.includes(pduObj.cmdName)) {
		const log = options.log ?? silentLog;

		log.debug('server - command before bind', { cmdName: pduObj.cmdName });
		await session.sendReturn(pduObj, 'ESME_RINVBNDSTS');

		return true;
	}

	await onBind(session, pduObj, options);

	return true;
}

function onConnection(sock: Socket, options: ServerOptions, server: SmppServer): void {
	const log = options.log ?? silentLog;
	const session = new Session({
		idleTimeout: options.idleTimeout ?? defaults.idleTimeout,
		log,
		maxOutstanding: options.maxOutstanding,
		maxOctets: options.maxOctets,
		maxReassembly: options.maxReassembly,
		onRequest: (bound, pduObj) => onRequest(bound, pduObj, options),
		reassemblyTimeout: options.reassemblyTimeout,
		responseTimeout: options.responseTimeout,
		shutdownTimeout: options.shutdownTimeout,
		sock,
		systemId: options.systemId ?? defaults.systemId,
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
function createSecureListener(tlsOptions: TlsOptions, log: SmppLog): TlsServer {
	const listener = createTlsServer(tlsOptions);

	listener.on('tlsClientError', err => {
		log.warn('server - client handshake failed', { message: err.message });
	});

	return listener;
}

function checkOptions(options: ServerOptions, log: SmppLog, port: number): VoidResult {
	const checked = checkSessionOptions(options);

	if (checked.err) return { err: checked.err };

	if (options.tls === true) {
		log.warn('server - tls without a certificate', { port });

		return { err: new Error('Listening over TLS needs tls: { cert, key }') };
	}

	// An int8 TLV on every bind response: out of range here means no ESME can ever bind.
	const version = options.interfaceVersion ?? defaults.interfaceVersion;

	if (!Number.isInteger(version) || version < 0 || version > 0xFF) {
		log.warn('server - interface version out of range', { interfaceVersion: version });

		return { err: new Error(`interfaceVersion must be 0-255, got ${String(version)}`) };
	}

	return {};
}

function createListener(
	options: ServerOptions,
	log: SmppLog,
	port: number,
): Result<{ listener: NetServer | TlsServer; useTls: boolean }> {
	const useTls = options.tls !== undefined && options.tls !== false;
	const tlsOptions = typeof options.tls === 'object' ? options.tls : undefined;
	const checked = checkOptions(options, log, port);

	if (checked.err) return { err: checked.err };

	return {
		listener: tlsOptions ? createSecureListener(tlsOptions, log) : createNetServer(),
		useTls,
	};
}

function onListening(listener: NetServer, smpp: SmppServer, options: ServerOptions): void {
	const log = options.log ?? silentLog;

	// Past startup, a listener error is a runtime event, not a failed start.
	listener.on('error', (err: Error) => {
		log.warn('server - error', { message: err.message });
		smpp.emit('serverError', err);
	});

	log.info('server - listening', { host: options.host ?? '*', port: smpp.port });

	options.signal?.addEventListener('abort', () => { void smpp.close(); }, { once: true });
}

/** Starts listening for SMPP connections. Resolves once the socket is bound. */
export function server(options: ServerOptions = {}): Promise<Result<{ server: SmppServer }>> {
	const log = options.log ?? silentLog;
	const port = options.port ?? defaults.port;
	const created = createListener(options, log, port);

	if (created.err) return Promise.resolve({ err: created.err });

	const listener = created.listener;
	const smpp = new SmppServer(listener, log);

	listener.on(created.useTls ? 'secureConnection' : 'connection', (sock: Socket) => {
		onConnection(sock, options, smpp);
	});

	return new Promise(resolve => {
		const onStartupError = (err: Error): void => {
			listener.removeListener('error', onStartupError);
			log.warn('server - could not listen', { message: err.message, port });
			resolve({ err });
		};

		listener.once('error', onStartupError);

		try {
			listener.listen(port, options.host, () => {
				listener.removeListener('error', onStartupError);
				onListening(listener, smpp, options);
				resolve({ server: smpp });
			});
		} catch (thrown: unknown) {
			onStartupError(errorFrom(thrown));
		}
	});
}
