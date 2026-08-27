import type { ErrorName } from './defs/errors.ts';
import type { MessageDlr } from './dlr-merger.ts';
import type { ParamValue } from './defs/types.ts';
import type { PduObject, PduObjectInput, TlvInput } from './pdu.ts';
import type { BindType, ReconnectOptions, SendOptions, SessionEvents, SessionOptions } from './session-options.ts';
import type { Result, VoidResult } from './result.ts';
import type { SendSmsOptions, SendSmsResult } from './send-sms.ts';
import type { SmppLog } from './log.ts';
import type { Socket } from 'node:net';
import { DlrMerger } from './dlr-merger.ts';
import { EventEmitter } from 'node:events';
import { IncomingRequests } from './incoming-requests.ts';
import { LinkTimers } from './link-timers.ts';
import { PduFramer } from './pdu-framer.ts';
import { PendingRequests } from './pending-requests.ts';
import { ReconnectLoop } from './reconnect-loop.ts';
import { SendWindow } from './send-window.ts';
import { optionalParamsMinVersion } from './defs/constants.ts';
import { bindCarries, bindCommands, defaultSystemId, defaults } from './session-options.ts';
import { isResp, objToPdu, pduReturn, pduToObj } from './pdu.ts';
import { silentLog } from './log.ts';
import { submitSms } from './send-sms.ts';

export type {
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

export class Session extends EventEmitter<SessionEvents> {
	/** Replaced on reconnect, so hold the session rather than this. */
	sock: Socket;
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
	private readonly window: SendWindow;

	private closed = false;
	private concatReference = 0;
	private framer = new PduFramer();

	/** A listener that throws is the application's bug; it must not become ours. Hard rule 1. */
	override emit<K extends keyof SessionEvents>(
		event: K,
		...args: K extends keyof SessionEvents ? SessionEvents[K] : never
	): boolean {
		try {
			return super.emit(event, ...args);
		} catch (thrown: unknown) {
			const err = thrown instanceof Error ? thrown : new Error(String(thrown));

			this.log.error('session - a listener threw', { event, message: err.message });

			// Guarded against the listener that throws being the one listening for this.
			if (event !== 'sessionError') this.emit('sessionError', err);

			return false;
		}
	}

	/** The same guard for a listener that rejects rather than throws; captureRejections routes here. */
	override [EventEmitter.captureRejectionSymbol](
		error: Error,
		...args: [event: keyof SessionEvents, ...rest: unknown[]]
	): void {
		const [event] = args;

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
			systemId: options.systemId,
		});
		this.pending = new PendingRequests(this.log);
		this.reconnectLoop = this.loopFor(options.reconnect);
		this.sock = options.sock;
		this.timers = new LinkTimers({
			enquireLinkInterval: options.enquireLinkInterval,
			idleTimeout: options.idleTimeout,
			log: this.log,
			onEnquireLink: () => { void this.send({ cmdName: 'enquire_link' }); },
			// Not close(): a link that went quiet is a drop, and a drop is what reconnect is for.
			onIdle: () => { this.teardown(); },
		});
		this.window = new SendWindow(options.maxOutstanding ?? defaults.maxOutstanding);

		this.attach(options.sock);
		this.resetTimers();
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
		const sent = built.err ? { err: built.err } : this.write(built.buffer);

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
			send: input => this.send(input, options),
		}, sms);

		if (!sent.err && sms.dlr === true) this.dlrMerger.expect(sent.smsIds);

		return sent;
	}

	/** Unbinds politely, then closes. Many SMSCs drop the link instead of answering, which is fine. */
	async unbind(): Promise<VoidResult> {
		const wasOpen = !this.closed;
		const sent = await this.send({ cmdName: 'unbind' });
		const closedOnUnbind = wasOpen && this.closed;

		this.close();

		return sent.err && !closedOnUnbind ? { err: sent.err } : {};
	}

	/** Closes for good. A session closed this way never reconnects. */
	close(): void {
		this.reconnectLoop?.stop();
		this.teardown();
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

		this.resetTimers();
		this.log.info('session - reconnected');
		this.emit('reconnected');

		return {};
	}

	/** Wires a freshly opened socket into this session, replacing any previous one. */
	private attach(sock: Socket): void {
		// The socket being replaced is already dead, and its three handlers still point here.
		if (this.sock !== sock) this.sock.removeAllListeners();

		this.sock = sock;
		this.framer = new PduFramer();
		this.closed = false;

		sock.on('data', chunk => { this.onData(chunk); });
		sock.on('close', () => { this.onClose(); });
		sock.on('error', err => {
			this.log.warn('session - socket error', { message: err.message });
			this.emit('sessionError', err);
			this.onClose();
		});
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
		const written = this.write(built.buffer);

		if (written.err) {
			this.pending.settle(seqNr, { err: written.err });

			return { err: written.err };
		}

		return response;
	}

	private teardown(): void {
		if (this.closed) return;

		this.closed = true;
		this.timers.clear();
		this.pending.settleAll(new Error('Session closed before a response arrived'));
		this.dlrMerger.clear();
		this.incoming.clear();
		this.sock.destroy();
		this.emit('close');
	}

	private nextConcatReference(): number {
		this.concatReference = this.concatReference >= 255 ? 1 : this.concatReference + 1;

		return this.concatReference;
	}

	private write(pdu: Buffer): VoidResult {
		if (this.sock.destroyed) {
			return { err: new Error('Socket is closed') };
		}

		this.sock.write(pdu);

		return {};
	}

	private onData(chunk: Buffer): void {
		this.emit('data', chunk);
		this.resetTimers();
		this.framer.push(chunk);

		const framed = this.framer.next();

		if (framed.err) {
			this.log.warn('session - unusable stream, closing', { message: framed.err.message });
			this.emit('sessionError', framed.err);
			this.close();

			return;
		}

		for (const pdu of framed.pdus) {
			if (!this.receive(pdu)) return;
		}
	}

	/** False means the PDU could not be read and the session has been closed. */
	private receive(pdu: Buffer): boolean {
		this.emit('incomingPdu', pdu);

		const parsed = pduToObj(pdu);

		if (parsed.err) {
			this.log.warn('session - could not parse an incoming PDU, closing', {
				message: parsed.err.message,
			});
			this.emit('sessionError', parsed.err);
			this.close();

			return false;
		}

		this.dispatch(parsed.pduObj);

		return true;
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
			const err = thrown instanceof Error ? thrown : new Error(String(thrown));

			this.log.error('session - a handler threw', { message: err.message });
			this.emit('sessionError', err);
		});
	}

	private resetTimers(): void {
		if (this.closed) return;

		this.timers.reset();
	}

	private onClose(): void {
		this.teardown();
		this.reconnectLoop?.schedule();
	}
}
