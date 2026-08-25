import type { Dlr } from './dlr.ts';
import type { EncodingName } from './defs/encodings.ts';
import type { ErrorName } from './defs/errors.ts';
import type { LogInt } from '@larvit/log';
import type { ParamValue } from './defs/types.ts';
import type { PduObject, PduObjectInput, TlvInput } from './pdu.ts';
import type { Result, VoidResult } from './result.ts';
import type { Sms } from './sms.ts';
import type { Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { PduFramer } from './pdu-framer.ts';
import { concatInfo } from './udh.ts';
import { consts } from './defs/constants.ts';
import { createSms } from './sms.ts';
import { decodeMessage, smppTime, splitMessage } from './message.ts';
import { detect } from './defs/encodings.ts';
import { dlrFromPdu } from './dlr.ts';
import { isResp, maxSeqNr, objToPdu, pduReturn, pduToObj } from './pdu.ts';
import { paramText } from './defs/types.ts';
import { silentLog } from './log.ts';

export type MessageDlr = Dlr & { segments: Dlr[] };

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

export type SendSmsOptions = {
	dlr?: boolean;
	destinationAddrNpi?: number;
	destinationAddrTon?: number;
	encoding?: EncodingName;
	flash?: boolean;
	from: string;
	message: string;
	scheduleDeliveryTime?: Date | number | string;
	sourceAddrNpi?: number;
	sourceAddrTon?: number;
	to: string;
	validityPeriod?: Date | number | string;
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
};

type Pending = {
	settle: (result: Result<{ pduObj: PduObject }>) => void;
};

type Reassembly = {
	parts: Map<number, PduObject>;
	timer: NodeJS.Timeout;
	total: number;
};

const defaults = {
	maxDelay: 30_000,
	maxOutstanding: 10,
	maxReassembly: 1000,
	minDelay: 1000,
	reassemblyTimeout: 300_000,
	responseTimeout: 30_000,
};

/** Alphanumeric senders must be TON 5; 0.4.0 sent everything as TON 1 (international). */
function addressTon(address: string): number {
	return /^\+?\d+$/.test(address) ? consts.TON.INTERNATIONAL : consts.TON.ALPHANUMERIC;
}

function dataCodingFor(encoding: EncodingName, flash: boolean): number {
	if (!flash) return consts.ENCODING[encoding];

	// Message class present (0x10) plus the alphabet bits, so flash survives UCS2.
	return encoding === 'UCS2' ? 0x18 : 0x10;
}

export class Session extends EventEmitter<SessionEvents> {
	/** Replaced on reconnect, so hold the session rather than this. */
	sock: Socket;
	readonly log: LogInt;

	loggedIn = false;
	userData: unknown = undefined;

	private framer = new PduFramer();
	private readonly options: SessionOptions;
	private readonly pending = new Map<number, Pending>();
	private readonly reassembly = new Map<string, Reassembly>();
	private readonly segmentDlrs = new Map<string, Map<number, Dlr>>();
	private readonly waiting: (() => void)[] = [];

	private closed = false;
	private concatReference = 0;
	private enquireLinkTimer: NodeJS.Timeout | undefined;
	private idleTimer: NodeJS.Timeout | undefined;
	private inFlight = 0;
	private ourSeqNr = 1;
	private reconnectDelay: number;
	private reconnectTimer: NodeJS.Timeout | undefined;
	private stopped = false;

	constructor(options: SessionOptions) {
		super();

		this.options = options;
		this.log = options.log ?? silentLog;
		this.sock = options.sock;
		this.reconnectDelay = options.reconnect?.minDelay ?? defaults.minDelay;

		this.attach(options.sock);
		this.resetTimers();
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

	/** Sends a request and resolves with the peer's response. */
	async send(
		input: PduObjectInput,
		options: SendOptions = {},
	): Promise<Result<{ pduObj: PduObject }>> {
		if (input.cmdName.endsWith('_resp')) {
			return { err: new Error(`Use sendReturn() for responses, not send(): ${input.cmdName}`) };
		}

		if (this.closed) return { err: new Error('Session is closed') };

		await this.acquire();

		try {
			const seqNr = this.nextSeqNr();
			const built = objToPdu({ ...input, seqNr });

			if (built.err) return { err: built.err };

			const response = this.awaitResponse(seqNr, options.signal);
			const written = this.write(built.buffer);

			if (written.err) {
				this.settle(seqNr, { err: written.err });

				return { err: written.err };
			}

			return await response;
		} finally {
			this.release();
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

	async sendSms(
		sms: SendSmsOptions,
		options: SendOptions = {},
	): Promise<Result<{ pduObjs: PduObject[]; smsIds: string[] }>> {
		const encoding = sms.encoding ?? detect(sms.message);
		const segments = splitMessage(sms.message, {
			encoding,
			reference: this.nextConcatReference(),
		});
		const pduObjs: PduObject[] = [];
		const smsIds: string[] = [];

		this.log.debug('sendSms() - sending', { encoding, segments: segments.length, to: sms.to });

		// Segments go out together rather than one-after-a-response: a receiver that waits for every
		// segment before answering — this library's own server does — would otherwise deadlock.
		const sent = await Promise.all(segments.map(segment => {
			const params: Record<string, ParamValue> = {
				data_coding: dataCodingFor(encoding, sms.flash === true),
				destination_addr: sms.to,
				dest_addr_npi: sms.destinationAddrNpi ?? 0,
				dest_addr_ton: sms.destinationAddrTon ?? addressTon(sms.to),
				short_message: segment,
				sm_length: segment.length,
				source_addr: sms.from,
				source_addr_npi: sms.sourceAddrNpi ?? 0,
				source_addr_ton: sms.sourceAddrTon ?? addressTon(sms.from),
			};

			if (segments.length > 1) params.esm_class = consts.ESM_CLASS.UDH_INDICATOR;
			if (sms.dlr === true) params.registered_delivery = consts.REGISTERED_DELIVERY.FINAL;
			if (sms.validityPeriod !== undefined) {
				params.validity_period = smppTime.encode(sms.validityPeriod);
			}
			if (sms.scheduleDeliveryTime !== undefined) {
				params.schedule_delivery_time = smppTime.encode(sms.scheduleDeliveryTime);
			}

			return this.send({ cmdName: 'submit_sm', params }, options);
		}));

		for (const one of sent) {
			if (one.err) return { err: one.err };

			pduObjs.push(one.pduObj);
			smsIds.push(paramText(one.pduObj.params.message_id));
		}

		return { pduObjs, smsIds };
	}

	/** Unbinds politely, then closes. */
	async unbind(): Promise<VoidResult> {
		const sent = await this.send({ cmdName: 'unbind' });

		this.close();

		return sent.err ? { err: sent.err } : {};
	}

	/** Closes for good. A session closed this way never reconnects. */
	close(): void {
		this.stopped = true;

		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

		this.reconnectTimer = undefined;
		this.teardown();
	}

	private teardown(): void {
		if (this.closed) return;

		this.closed = true;
		this.clearTimers();

		for (const [seqNr] of this.pending) {
			this.settle(seqNr, { err: new Error('Session closed before a response arrived') });
		}

		for (const group of this.reassembly.values()) {
			clearTimeout(group.timer);
		}

		this.reassembly.clear();
		this.sock.destroy();
	}

	private nextSeqNr(): number {
		const seqNr = this.ourSeqNr;

		this.ourSeqNr = this.ourSeqNr >= maxSeqNr ? 1 : this.ourSeqNr + 1;

		return seqNr;
	}

	private nextConcatReference(): number {
		this.concatReference = this.concatReference >= 255 ? 1 : this.concatReference + 1;

		return this.concatReference;
	}

	private async acquire(): Promise<void> {
		const limit = this.options.maxOutstanding ?? defaults.maxOutstanding;

		if (this.inFlight < limit) {
			this.inFlight++;

			return;
		}

		return new Promise<void>(resolve => this.waiting.push(resolve));
	}

	private release(): void {
		const next = this.waiting.shift();

		if (next) {
			next();

			return;
		}

		this.inFlight--;
	}

	private write(pdu: Buffer): VoidResult {
		if (this.sock.destroyed) {
			return { err: new Error('Socket is closed') };
		}

		this.sock.write(pdu);

		return {};
	}

	private awaitResponse(
		seqNr: number,
		signal: AbortSignal | undefined,
	): Promise<Result<{ pduObj: PduObject }>> {
		return new Promise(resolve => {
			const timeout = this.options.responseTimeout ?? defaults.responseTimeout;
			let timer: NodeJS.Timeout | undefined;

			const onAbort = (): void => {
				this.settle(seqNr, { err: new Error('Aborted before a response arrived') });
			};

			const settle = (result: Result<{ pduObj: PduObject }>): void => {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener('abort', onAbort);
				this.pending.delete(seqNr);
				resolve(result);
			};

			this.pending.set(seqNr, { settle });

			if (signal?.aborted === true) {
				settle({ err: new Error('Aborted before a response arrived') });

				return;
			}

			signal?.addEventListener('abort', onAbort, { once: true });

			if (timeout > 0) {
				timer = setTimeout(() => {
					this.log.warn('session - no response before the timeout', { seqNr, timeout });
					this.settle(seqNr, { err: new Error(`No response to seqNr ${String(seqNr)}`) });
				}, timeout);
				timer.unref();
			}
		});
	}

	private settle(seqNr: number, result: Result<{ pduObj: PduObject }>): void {
		this.pending.get(seqNr)?.settle(result);
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
			this.emit('incomingPdu', pdu);

			const parsed = pduToObj(pdu);

			if (parsed.err) {
				this.log.warn('session - could not parse an incoming PDU, closing', {
					message: parsed.err.message,
				});
				this.emit('sessionError', parsed.err);
				this.close();

				return;
			}

			this.dispatch(parsed.pduObj);
		}
	}

	private dispatch(pduObj: PduObject): void {
		if (isResp(pduObj)) {
			const pending = this.pending.get(pduObj.seqNr);

			if (!pending) {
				this.log.debug('session - response with no matching request', { seqNr: pduObj.seqNr });

				return;
			}

			pending.settle({ pduObj });

			return;
		}

		this.emit('incomingPduObj', pduObj);
		void this.handle(pduObj);
	}

	private async handle(pduObj: PduObject): Promise<void> {
		const onRequest = this.options.onRequest;

		if (onRequest && await onRequest(this, pduObj)) return;

		if (pduObj.cmdName === 'enquire_link') {
			await this.sendReturn(pduObj);

			return;
		}

		if (pduObj.cmdName === 'unbind') {
			await this.sendReturn(pduObj);
			this.close();

			return;
		}

		if (pduObj.cmdName === 'submit_sm') {
			this.onSubmitSm(pduObj);

			return;
		}

		if (pduObj.cmdName === 'deliver_sm') {
			await this.onDeliverSm(pduObj);

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

		if (!hasUdh || !Buffer.isBuffer(message)) {
			this.emitSms([pduObj]);

			return;
		}

		const concat = concatInfo(message);

		if (!concat) {
			this.emitSms([pduObj]);

			return;
		}

		this.collectSegment(pduObj, concat);
	}

	private collectSegment(
		pduObj: PduObject,
		concat: { part: number; reference: number; total: number },
	): void {
		const key = [
			paramText(pduObj.params.source_addr),
			paramText(pduObj.params.destination_addr),
			String(concat.reference),
		].join('_');

		let group = this.reassembly.get(key);

		if (!group) {
			const limit = this.options.maxReassembly ?? defaults.maxReassembly;

			if (this.reassembly.size >= limit) {
				const oldest = this.reassembly.keys().next();

				if (!oldest.done) {
					this.log.warn('session - reassembly buffer full, dropping the oldest message', {
						limit,
					});
					this.dropReassembly(oldest.value);
				}
			}

			const timer = setTimeout(() => {
				this.log.info('session - incomplete message expired', { key, total: concat.total });
				this.dropReassembly(key);
			}, this.options.reassemblyTimeout ?? defaults.reassemblyTimeout);

			timer.unref();
			group = { parts: new Map(), timer, total: concat.total };
			this.reassembly.set(key, group);
		}

		group.parts.set(concat.part, pduObj);

		if (group.parts.size < group.total) return;

		clearTimeout(group.timer);
		this.reassembly.delete(key);

		const ordered = [...group.parts.entries()]
			.sort(([a], [b]) => a - b)
			.map(([, part]) => part);

		this.emitSms(ordered);
	}

	private dropReassembly(key: string): void {
		const group = this.reassembly.get(key);

		if (!group) return;

		clearTimeout(group.timer);
		this.reassembly.delete(key);
	}

	private emitSms(pduObjs: PduObject[]): void {
		const first = pduObjs[0];

		if (!first) return;

		let message = '';

		for (const pduObj of pduObjs) {
			const part = pduObj.params.short_message;
			const dataCoding = pduObj.params.data_coding;
			const esmClass = pduObj.params.esm_class;

			message += Buffer.isBuffer(part)
				? decodeMessage(
					part,
					typeof dataCoding === 'number' ? dataCoding : 0,
					typeof esmClass === 'number' ? esmClass : 0,
				).message
				: paramText(part);
		}

		this.emit('sms', createSms({
			from: paramText(first.params.source_addr),
			message,
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
		this.collectSegmentDlr(dlr);
		await this.sendReturn(pduObj);
	}

	/** Segment ids look like `<uuid>-<n>`; once every segment is in, report on the whole message. */
	private collectSegmentDlr(dlr: Dlr): void {
		const match = /^(.*)-(\d+)$/.exec(dlr.smsId);

		if (!match) return;

		const [, smsId, part] = match;

		if (smsId === undefined || part === undefined) return;

		const segments = this.segmentDlrs.get(smsId) ?? new Map<number, Dlr>();

		segments.set(Number(part), dlr);
		this.segmentDlrs.set(smsId, segments);

		const highest = Math.max(...segments.keys());

		if (segments.size < highest) return;

		this.segmentDlrs.delete(smsId);

		const ordered = [...segments.entries()].sort(([a], [b]) => a - b).map(([, one]) => one);
		const worst = ordered.reduce((carry, one) => (one.statusId > carry.statusId ? one : carry));

		this.emit('messageDlr', { ...worst, segments: ordered, smsId });
	}

	private resetTimers(): void {
		if (this.closed) return;

		this.clearTimers();

		const { enquireLinkInterval, idleTimeout } = this.options;

		if (enquireLinkInterval !== undefined && enquireLinkInterval > 0) {
			this.enquireLinkTimer = setTimeout(() => {
				void this.send({ cmdName: 'enquire_link' });
			}, enquireLinkInterval);
			this.enquireLinkTimer.unref();
		}

		if (idleTimeout !== undefined && idleTimeout > 0) {
			this.idleTimer = setTimeout(() => {
				this.log.info('session - closing an idle peer', { idleTimeout });
				this.close();
			}, idleTimeout);
			this.idleTimer.unref();
		}
	}

	private clearTimers(): void {
		if (this.enquireLinkTimer) clearTimeout(this.enquireLinkTimer);
		if (this.idleTimer) clearTimeout(this.idleTimer);

		this.enquireLinkTimer = undefined;
		this.idleTimer = undefined;
	}

	private onClose(): void {
		const wasOpen = !this.closed;

		this.teardown();

		if (wasOpen) this.emit('close');

		if (!this.stopped && this.options.reconnect) this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer) return;

		const reconnect = this.options.reconnect;

		if (!reconnect) return;

		const delay = this.reconnectDelay;

		this.log.info('session - reconnecting after a drop', { delay });

		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			void this.reconnect();
		}, delay);
		this.reconnectTimer.unref();

		this.reconnectDelay = Math.min(delay * 2, reconnect.maxDelay ?? defaults.maxDelay);
	}

	/** Read through a method: close() can land while a reconnect is awaiting. */
	private isStopped(): boolean {
		return this.stopped;
	}

	private async reconnect(): Promise<void> {
		const reconnect = this.options.reconnect;

		if (!reconnect || this.isStopped()) return;

		const opened = await reconnect.connect();

		if (opened.err) {
			this.log.warn('session - reconnect failed to open a socket', {
				message: opened.err.message,
			});
			this.scheduleReconnect();

			return;
		}

		if (this.isStopped()) {
			opened.sock.destroy();

			return;
		}

		this.attach(opened.sock);

		const bound = await reconnect.onConnected(this);

		if (bound.err) {
			this.log.warn('session - reconnect failed to bind', { message: bound.err.message });
			this.teardown();
			this.scheduleReconnect();

			return;
		}

		this.reconnectDelay = reconnect.minDelay ?? defaults.minDelay;
		this.resetTimers();
		this.log.info('session - reconnected');
		this.emit('reconnected');
	}
}
