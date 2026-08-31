import type { ErrorName } from './defs/errors.ts';
import type { MessageDlr } from './dlr-merger.ts';
import type { ParamValue } from './defs/types.ts';
import type { PduObject, PduObjectInput, TlvInput } from './pdu.ts';
import type { BindType, CloseOptions, ReconnectOptions, SendOptions, SessionEvents, SessionOptions } from './session-options.ts';
import type { Result, VoidResult } from './result.ts';
import type { SendSmsOptions, SendSmsResult } from './send-sms.ts';
import type { SmppLog } from './log.ts';
import type { Socket } from 'node:net';
import { DlrMerger } from './dlr-merger.ts';
import { EventEmitter } from 'node:events';
import { IncomingRequests } from './incoming-requests.ts';
import { LinkTimers } from './link-timers.ts';
import { PduTransport } from './pdu-transport.ts';
import { PendingRequests } from './pending-requests.ts';
import { ReconnectLoop } from './reconnect-loop.ts';
import { SendWindow } from './send-window.ts';
import { errorFrom } from './error-from.ts';
import { optionalParamsMinVersion } from './defs/constants.ts';
import { bindCarries, bindCommands, defaultSystemId, defaults } from './session-options.ts';
import { isResp, objToPdu, pduReturn } from './pdu.ts';
import { silentLog } from './log.ts';
import { submitSms } from './send-sms.ts';

export type {
	CloseOptions,
	MessageDlr,
	ReconnectOptions,
	SendOptions,
	SendSmsOptions,
	SendSmsResult,
	SessionEvents,
	SessionOptions,
};
export type { BindType };
export { bindCommands, defaultSystemId };

/** A listener may return a promise: an `async` one that rejects is routed like one that throws. */
type SessionListener<K extends keyof SessionEvents> = (...args: SessionEvents[K]) => unknown;

export class Session extends EventEmitter<SessionEvents> {
	declare addListener: <K extends keyof SessionEvents>(event: K, listener: SessionListener<K>) => this;
	declare off: <K extends keyof SessionEvents>(event: K, listener: SessionListener<K>) => this;
	declare on: <K extends keyof SessionEvents>(event: K, listener: SessionListener<K>) => this;
	declare once: <K extends keyof SessionEvents>(event: K, listener: SessionListener<K>) => this;
	declare prependListener: <K extends keyof SessionEvents>(event: K, listener: SessionListener<K>) => this;
	declare prependOnceListener: <K extends keyof SessionEvents>(event: K, listener: SessionListener<K>) => this;
	declare removeListener: <K extends keyof SessionEvents>(event: K, listener: SessionListener<K>) => this;

	readonly log: SmppLog;

	/** The role the ESME bound with, whichever end of the link this is. Undefined before any bind. */
	boundAs: BindType | undefined = undefined;
	loggedIn = false;
	/** What the peer declared when binding: 0x00 if it declared none, undefined before any bind. */
	peerInterfaceVersion: number | undefined = undefined;
	userData: unknown = undefined;

	private readonly dlrMerger: DlrMerger;
	private readonly incoming: IncomingRequests;
	private readonly options: SessionOptions;
	private readonly pending: PendingRequests;
	private readonly reconnectLoop: ReconnectLoop | undefined;
	private readonly timers: LinkTimers;
	private readonly transport: PduTransport;
	private readonly window: SendWindow;

	private closed = false;
	private concatReference = 0;
	private draining = false;
	private ended = false;

	/** A listener that throws is the application's bug; it must not become ours. Hard rule 1. */
	override emit<K extends keyof SessionEvents>(
		event: K,
		...args: K extends keyof SessionEvents ? SessionEvents[K] : never
	): boolean {
		try {
			return super.emit(event, ...args);
		} catch (thrown: unknown) {
			const err = errorFrom(thrown);

			this.log.error('session - a listener threw', { event, message: err.message });

			// Guarded against the listener that throws being the one listening for this.
			if (event !== 'sessionError') this.emit('sessionError', err);

			return false;
		}
	}

	/** The same guard for a listener that rejects rather than throws; captureRejections routes here. */
	override [EventEmitter.captureRejectionSymbol](
		reason: unknown,
		...args: [event: keyof SessionEvents, ...rest: unknown[]]
	): void {
		const [event] = args;
		const error = errorFrom(reason);

		this.log.error('session - a listener rejected', { event, message: error.message });

		if (event !== 'sessionError') this.emit('sessionError', error);
	}

	constructor(options: SessionOptions) {
		super({ captureRejections: true });

		this.log = options.log ?? silentLog;
		this.options = options;
		this.dlrMerger = new DlrMerger({
			log: this.log,
			max: defaults.maxDlrMerges,
			timeout: defaults.dlrMergeTimeout,
		});
		this.incoming = new IncomingRequests({
			dlrMerger: this.dlrMerger,
			log: this.log,
			maxOctets: options.maxOctets,
			maxReassembly: options.maxReassembly,
			onRequest: options.onRequest,
			reassemblyTimeout: options.reassemblyTimeout,
			session: this,
			smsIdFormat: options.smsIdFormat,
			systemId: options.systemId,
		});
		this.pending = new PendingRequests(this.log);
		this.reconnectLoop = this.loopFor(options.reconnect);
		this.timers = new LinkTimers({
			enquireLinkInterval: options.enquireLinkInterval,
			idleTimeout: options.idleTimeout,
			log: this.log,
			onEnquireLink: () => { void this.send({ cmdName: 'enquire_link' }); },
			// Not close(): a link that went quiet is a drop, and a drop is what reconnect is for.
			onIdle: () => { this.teardown(); },
		});
		this.transport = this.transportFor(options.sock);
		this.window = new SendWindow(options.maxOutstanding ?? defaults.maxOutstanding);

		this.attach(options.sock);
		this.resetTimers();
	}

	/** Replaced on reconnect, so hold the session rather than this. */
	get sock(): Socket {
		return this.transport.sock;
	}

	/** Whether this session's bind direction carries a command. Consulted by the library's senders. */
	bindAllows(cmdName: string): boolean {
		return bindCarries(this.boundAs, cmdName);
	}

	/** SMPP 3.4 forbids sending optional parameters to a peer that declared an older version. */
	acceptsOptionalParams(): boolean {
		return this.peerInterfaceVersion === undefined
			|| this.peerInterfaceVersion >= optionalParamsMinVersion;
	}

	/** Sends a request and resolves with the peer's response. */
	async send(
		input: PduObjectInput,
		options: SendOptions = {},
	): Promise<Result<{ pduObj: PduObject }>> {
		if (input.cmdName.endsWith('_resp')) {
			return { err: new Error(`Use sendReturn() for responses, not send(): ${input.cmdName}`) };
		}

		if (this.closed) return { err: new Error('Session is closed') };

		if (this.draining) return { err: new Error('Session is shutting down') };

		// Before the window, or a full window makes an aborted call wait for a slot it will not use.
		if (options.signal?.aborted === true) {
			return { err: new Error('Aborted before the request was sent') };
		}

		await this.window.acquire();

		try {
			return await this.request(input, options);
		} finally {
			this.window.release();
		}
	}

	/** Answers a request the peer sent us. Responses are never waited on. */
	async sendReturn(
		pdu: PduObject,
		status: ErrorName = 'ESME_ROK',
		params: Record<string, ParamValue> = {},
		tlvs?: Record<string, TlvInput>,
	): Promise<VoidResult> {
		const built = pduReturn(pdu, status, params, tlvs);
		const sent = built.err ? { err: built.err } : this.transport.write(built.buffer);

		// A peer that unbinds and drops the link takes our response with it; that is not a failure.
		if (sent.err && !this.closed) {
			this.log.warn('session - could not answer a request', {
				cmdName: pdu.cmdName,
				message: sent.err.message,
				seqNr: pdu.seqNr,
			});
			this.emit('sessionError', sent.err);
		}

		return Promise.resolve(sent);
	}

	async sendSms(sms: SendSmsOptions, options: SendOptions = {}): Promise<SendSmsResult> {
		if (!this.bindAllows('submit_sm')) {
			return { err: new Error('A receiver-bound session does not carry submit_sm'), pduObjs: [], smsIds: [] };
		}

		const sent = await submitSms({
			log: this.log,
			reference: this.nextConcatReference(),
			respIdNotation: this.options.smsIdFormat?.submitResp,
			send: input => this.send(input, options),
		}, sms);

		if (!sent.err && sms.dlr === true) this.dlrMerger.expect(sent.smsIds);

		return sent;
	}

	/**
	 * Drains, unbinds politely, then closes. Many SMSCs drop the link instead of answering the
	 * unbind, which is fine. Reports the unbind's own failure ahead of an unfinished drain.
	 */
	async unbind(): Promise<VoidResult> {
		const drained = await this.drain(undefined);
		const wasOpen = !this.closed;
		// request(), not send(): the drain gate refuses a send, and the unbind goes out either way.
		const sent = wasOpen
			? await this.request({ cmdName: 'unbind' }, {})
			: { err: new Error('Session is closed') };
		const closedOnUnbind = wasOpen && this.closed;

		this.end();

		return sent.err && !closedOnUnbind ? { err: sent.err } : drained;
	}

	/**
	 * Closes for good: refuses new sends, waits out the requests already on the wire up to
	 * `shutdownTimeout`, then tears down whatever is left. A session closed this way never reconnects.
	 */
	async close(options: CloseOptions = {}): Promise<VoidResult> {
		const drained = await this.drain(options.signal);

		this.end();

		return drained;
	}

	private transportFor(sock: Socket): PduTransport {
		return new PduTransport({
			log: this.log,
			onClose: () => { this.onClose(); },
			onData: chunk => { this.onData(chunk); },
			onError: err => { this.emit('sessionError', err); },
			onFramed: pdu => { this.emit('incomingPdu', pdu); },
			onPdu: pduObj => { this.dispatch(pduObj); },
			onUnreadable: err => {
				this.emit('sessionError', err);
				this.end();
			},
		}, sock);
	}

	private loopFor(reconnect: ReconnectOptions | undefined): ReconnectLoop | undefined {
		if (!reconnect) return undefined;

		return new ReconnectLoop({
			connect: reconnect.connect,
			log: this.log,
			maxDelay: reconnect.maxDelay ?? defaults.maxDelay,
			minDelay: reconnect.minDelay ?? defaults.minDelay,
			onConnected: sock => this.comeBackUp(sock, reconnect.onConnected),
		});
	}

	private async comeBackUp(
		sock: Socket,
		bind: (session: Session) => Promise<VoidResult>,
	): Promise<VoidResult> {
		this.attach(sock);

		const bound = await bind(this);

		if (bound.err) {
			this.teardown();

			return { err: bound.err };
		}

		// close() can land while the rebind is in flight.
		if (this.reconnectLoop?.isStopped() === true) {
			this.teardown();

			return { err: new Error('Session closed while it was coming back up') };
		}

		this.resetTimers();
		this.log.info('session - reconnected');
		this.emit('reconnected');

		return {};
	}

	private attach(sock: Socket): void {
		this.transport.attach(sock);
		this.closed = false;
	}

	private async request(
		input: PduObjectInput,
		options: SendOptions,
	): Promise<Result<{ pduObj: PduObject }>> {
		// pending.wait() alone settles the caller while the request still goes out to the peer.
		if (options.signal?.aborted === true) {
			return { err: new Error('Aborted before the request was sent') };
		}

		const seqNr = this.pending.nextSeqNr();
		const built = objToPdu({ ...input, seqNr });

		if (built.err) return { err: built.err };

		const response = this.pending.wait(seqNr, {
			signal: options.signal,
			timeout: this.options.responseTimeout ?? defaults.responseTimeout,
		});
		const written = this.transport.write(built.buffer);

		if (written.err) {
			this.pending.settle(seqNr, { err: written.err });

			return { err: written.err };
		}

		return response;
	}

	/** Stops new sends and waits out the ones already issued. */
	private async drain(signal: AbortSignal | undefined): Promise<VoidResult> {
		this.reconnectLoop?.stop();
		this.draining = true;

		if (this.closed || this.sock.destroyed) return {};

		const timeout = this.options.shutdownTimeout ?? defaults.shutdownTimeout;
		const unfinished = await this.window.idle(timeout, signal);

		// The window empties on a teardown too, which settles everything the link was carrying.
		if (this.isClosed()) return { err: new Error('The session closed before the drain finished') };

		if (unfinished === 0) return {};

		this.log.warn('session - shutting down with requests unfinished', { timeout, unfinished });

		return { err: new Error(`Shut down with ${String(unfinished)} request(s) unfinished`) };
	}

	/** Read through a method: teardown() can land while the drain is awaiting. */
	private isClosed(): boolean {
		return this.closed;
	}

	/** The session is over now, drained or not. Nothing brings it back. */
	private end(): void {
		this.reconnectLoop?.stop();
		this.teardown();
		this.dlrMerger.clear();
		this.emitClose();
	}

	/** A session torn down by a drop the loop was retrying reaches here with nothing left to tear down. */
	private emitClose(): void {
		if (this.ended) return;

		this.ended = true;
		this.emit('close');
	}

	private teardown(): void {
		if (this.closed) return;

		this.closed = true;
		this.timers.clear();
		this.pending.settleAll(new Error('Session closed before a response arrived'));
		this.incoming.clear();
		this.sock.destroy();

		if (this.retrying()) this.emit('disconnected');
		else this.emitClose();
	}

	private retrying(): boolean {
		return this.reconnectLoop !== undefined && !this.reconnectLoop.isStopped();
	}

	private nextConcatReference(): number {
		this.concatReference = this.concatReference >= 255 ? 1 : this.concatReference + 1;

		return this.concatReference;
	}

	private onData(chunk: Buffer): void {
		this.emit('data', chunk);
		this.resetTimers();
	}

	private dispatch(pduObj: PduObject): void {
		if (isResp(pduObj)) {
			if (!this.pending.deliver(pduObj)) {
				this.log.debug('session - response with no matching request', { seqNr: pduObj.seqNr });
			}

			return;
		}

		this.emit('incomingPduObj', pduObj);
		// Every application hook and listener reached from an incoming PDU funnels through here.
		void this.incoming.handle(pduObj).catch((thrown: unknown) => {
			const err = errorFrom(thrown);

			this.log.error('session - a handler threw', { message: err.message });
			this.emit('sessionError', err);
		});
	}

	private resetTimers(): void {
		if (this.closed) return;

		this.timers.reset();
	}

	private onClose(): void {
		if (this.reconnectLoop && !this.reconnectLoop.isStopped()) {
			this.teardown();
			this.reconnectLoop.schedule();

			return;
		}

		this.end();
	}
}
