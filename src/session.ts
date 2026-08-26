import type { Dlr } from './dlr.ts';
import type { ErrorName } from './defs/errors.ts';
import type { LogInt } from '@larvit/log';
import type { MessageDlr } from './dlr-merger.ts';
import type { ParamValue } from './defs/types.ts';
import type { PduObject, PduObjectInput, TlvInput } from './pdu.ts';
import type { Result, VoidResult } from './result.ts';
import type { SendSmsOptions, SendSmsResult } from './send-sms.ts';
import type { Sms } from './sms.ts';
import type { Socket } from 'node:net';
import { DlrMerger } from './dlr-merger.ts';
import { EventEmitter } from 'node:events';
import { LinkTimers } from './link-timers.ts';
import { PduFramer } from './pdu-framer.ts';
import { PendingRequests } from './pending-requests.ts';
import { ReconnectLoop } from './reconnect-loop.ts';
import { Reassembler, decodeSegments } from './reassembly.ts';
import { SendWindow } from './send-window.ts';
import { concatInfo } from './udh.ts';
import { consts, optionalParamsMinVersion } from './defs/constants.ts';
import { createSms } from './sms.ts';
import { dlrFromPdu } from './dlr.ts';
import { isResp, objToPdu, pduReturn, pduToObj } from './pdu.ts';
import { paramText } from './defs/types.ts';
import { silentLog } from './log.ts';
import { submitSms } from './send-sms.ts';

export type { MessageDlr, SendSmsOptions };

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

const defaults = {
	maxDelay: 30_000,
	maxOutstanding: 10,
	maxReassembly: 1000,
	minDelay: 1000,
	reassemblyTimeout: 300_000,
	responseTimeout: 30_000,
	systemId: '',
};

export const bindCommands: readonly string[] = [
	'bind_receiver',
	'bind_transceiver',
	'bind_transmitter',
];

export class Session extends EventEmitter<SessionEvents> {
	/** Replaced on reconnect, so hold the session rather than this. */
	sock: Socket;
	readonly log: LogInt;

	loggedIn = false;
	/** The interface_version the peer declared when binding; undefined until a bind is accepted. */
	peerInterfaceVersion: number | undefined = undefined;
	userData: unknown = undefined;

	private readonly dlrMerger = new DlrMerger();
	private readonly options: SessionOptions;
	private readonly pending: PendingRequests;
	private readonly reassembler: Reassembler;
	private readonly reconnectLoop: ReconnectLoop | undefined;
	private readonly timers: LinkTimers;
	private readonly window: SendWindow;

	private closed = false;
	private concatReference = 0;
	private framer = new PduFramer();

	constructor(options: SessionOptions) {
		super();

		this.log = options.log ?? silentLog;
		this.options = options;
		this.pending = new PendingRequests(this.log);
		this.reassembler = new Reassembler({
			log: this.log,
			max: options.maxReassembly ?? defaults.maxReassembly,
			timeout: options.reassemblyTimeout ?? defaults.reassemblyTimeout,
		});
		this.reconnectLoop = this.loopFor(options.reconnect);
		this.sock = options.sock;
		this.timers = new LinkTimers({
			enquireLinkInterval: options.enquireLinkInterval,
			idleTimeout: options.idleTimeout,
			log: this.log,
			onEnquireLink: () => { void this.send({ cmdName: 'enquire_link' }); },
			onIdle: () => { this.close(); },
		});
		this.window = new SendWindow(options.maxOutstanding ?? defaults.maxOutstanding);

		this.attach(options.sock);
		this.resetTimers();
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

		if (built.err) return { err: built.err };

		return Promise.resolve(this.write(built.buffer));
	}

	async sendSms(sms: SendSmsOptions, options: SendOptions = {}): Promise<SendSmsResult> {
		const sent = await submitSms({
			log: this.log,
			reference: this.nextConcatReference(),
			send: input => this.send(input, options),
		}, sms);

		if (!sent.err) this.dlrMerger.expect(sent.smsIds);

		return sent;
	}

	/** Unbinds politely, then closes. */
	async unbind(): Promise<VoidResult> {
		const sent = await this.send({ cmdName: 'unbind' });

		this.close();

		return sent.err ? { err: sent.err } : {};
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
		this.reassembler.clear();
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
		void this.handle(pduObj);
	}

	private async handle(pduObj: PduObject): Promise<void> {
		const onRequest = this.options.onRequest;

		if (onRequest && await onRequest(this, pduObj)) return;

		switch (pduObj.cmdName) {
			case 'deliver_sm':
				await this.onDeliverSm(pduObj);
				break;
			case 'enquire_link':
				await this.sendReturn(pduObj);
				break;
			case 'submit_sm':
				this.onSubmitSm(pduObj);
				break;
			case 'unbind':
				await this.sendReturn(pduObj);
				this.close();
				break;
			default:
				await this.unhandled(pduObj);
		}
	}

	private async unhandled(pduObj: PduObject): Promise<void> {
		if (bindCommands.includes(pduObj.cmdName)) {
			this.log.info('session - bind on an already bound session', { cmdName: pduObj.cmdName });
			// Explicit, or pduReturn's echo answers the peer with its own system_id instead of ours.
			await this.sendReturn(pduObj, 'ESME_RALYBND', {
				system_id: this.options.systemId ?? defaults.systemId,
			});

			return;
		}

		this.log.info('session - no handler for command', { cmdName: pduObj.cmdName });
		await this.sendReturn(pduObj, 'ESME_RINVCMDID');
	}

	private onSubmitSm(pduObj: PduObject): void {
		const message = pduObj.params.short_message;
		const esmClass = pduObj.params.esm_class;
		const hasUdh = typeof esmClass === 'number'
			&& (esmClass & consts.ESM_CLASS.UDH_INDICATOR) === consts.ESM_CLASS.UDH_INDICATOR;
		const concat = hasUdh && Buffer.isBuffer(message) ? concatInfo(message) : undefined;

		if (!concat) {
			this.emitSms([pduObj]);

			return;
		}

		const whole = this.reassembler.collect(pduObj, concat);

		if (whole) this.emitSms(whole);
	}

	private emitSms(pduObjs: PduObject[]): void {
		const first = pduObjs[0];

		if (!first) return;

		this.emit('sms', createSms({
			from: paramText(first.params.source_addr),
			message: decodeSegments(pduObjs),
			pduObjs,
			session: this,
			to: paramText(first.params.destination_addr),
		}));
	}

	private async onDeliverSm(pduObj: PduObject): Promise<void> {
		const dlr = dlrFromPdu(pduObj);

		if (!dlr) {
			this.log.info('session - deliver_sm carries no delivery report', { seqNr: pduObj.seqNr });
			await this.sendReturn(pduObj, 'ESME_RINVTLVSTREAM');

			return;
		}

		this.emit('dlr', dlr, pduObj);

		const merged = this.dlrMerger.collect(dlr);

		if (merged) this.emit('messageDlr', merged);

		await this.sendReturn(pduObj);
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
