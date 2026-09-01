import type { DlrMerger } from './dlr-merger.ts';
import type { OnRequest } from './session-options.ts';
import type { PduObject, PduObjectInput } from './pdu.ts';
import type { Result, VoidResult } from './result.ts';
import type { Session } from './session.ts';
import type { SmppLog } from './log.ts';
import type { SmsIdFormat } from './sms-id.ts';
import { HeldMessages } from './held-messages.ts';
import { Reassembler, decodeSegments } from './reassembly.ts';
import { bindCommands, defaults } from './session-options.ts';
import { concatInfo } from './udh.ts';
import { hasUdh } from './defs/constants.ts';
import { createSms } from './sms.ts';
import { dlrFromPdu } from './dlr.ts';
import { paramNumber, paramText } from './defs/types.ts';

export type IncomingRequestsOptions = {
	dlrMerger: DlrMerger;
	log: SmppLog;
	maxOctets?: number | undefined;
	maxReassembly?: number | undefined;
	onRequest?: OnRequest | undefined;
	reassemblyTimeout?: number | undefined;
	/** Past a drain's refusal, for a receipt the drain is itself waiting for. */
	sendPastDrain: (input: PduObjectInput) => Promise<Result<{ pduObj: PduObject }>>;
	session: Session;
	smsIdFormat?: SmsIdFormat | undefined;
	systemId?: string | undefined;
};

/** Everything the peer asks of a session: messages, receipts, links and the answers to them. */
export class IncomingRequests {
	private readonly dlrMerger: DlrMerger;
	private readonly held: HeldMessages;
	private readonly log: SmppLog;
	private readonly onRequest: OnRequest | undefined;
	private readonly reassembler: Reassembler;
	private readonly sendPastDrain: IncomingRequestsOptions['sendPastDrain'];
	private readonly session: Session;
	private readonly smsIdFormat: SmsIdFormat;
	private readonly systemId: string;
	private linkGeneration = 0;

	constructor(options: IncomingRequestsOptions) {
		this.dlrMerger = options.dlrMerger;
		this.held = new HeldMessages({
			log: options.log,
			max: defaults.maxHeldMessages,
			timeout: defaults.heldMessageTimeout,
		});
		this.log = options.log;
		this.onRequest = options.onRequest;
		this.reassembler = new Reassembler({
			log: options.log,
			max: options.maxReassembly ?? defaults.maxReassembly,
			maxOctets: options.maxOctets,
			timeout: options.reassemblyTimeout ?? defaults.reassemblyTimeout,
		});
		this.sendPastDrain = options.sendPastDrain;
		this.session = options.session;
		this.smsIdFormat = options.smsIdFormat ?? {};
		this.systemId = options.systemId ?? defaults.systemId;
	}

	async handle(pduObj: PduObject): Promise<void> {
		const generation = this.linkGeneration;

		if (this.onRequest && await this.onRequest(this.session, pduObj)) return;

		// The link it arrived on went while the hook ran, so nothing we answer now correlates.
		if (this.linkGeneration !== generation) return;

		if (!this.session.bindAllows(pduObj.cmdName)) {
			this.log.info('session - command the peer\'s bind direction does not carry', {
				bindType: this.session.boundAs ?? '',
				cmdName: pduObj.cmdName,
			});
			await this.session.sendReturn(pduObj, 'ESME_RINVBNDSTS');

			return;
		}

		switch (pduObj.cmdName) {
			case 'deliver_sm':
				await this.onDeliverSm(pduObj);
				break;
			case 'enquire_link':
				await this.session.sendReturn(pduObj);
				break;
			case 'submit_sm':
				this.onMessage(pduObj);
				break;
			case 'unbind':
				await this.session.sendReturn(pduObj);
				// A peer that has said it is finished will not answer what we still have outstanding.
				await this.session.close({ signal: AbortSignal.abort() });
				break;
			default:
				await this.unhandled(pduObj);
		}
	}

	/** Drops the segments of every message that never became whole, and of every one still held. */
	clear(): void {
		this.linkGeneration++;
		this.held.clear();
		this.reassembler.clear();
	}

	/** Waits out the messages the application still holds, and says how many it never answered. */
	async drain(timeout: number, signal: AbortSignal | undefined): Promise<VoidResult> {
		const unanswered = await this.held.idle(timeout, signal);

		if (unanswered === 0) return {};

		this.log.warn('session - shutting down with messages unanswered', { timeout, unanswered });

		return { err: new Error(`Shut down with ${String(unanswered)} message(s) unanswered`) };
	}

	private async unhandled(pduObj: PduObject): Promise<void> {
		if (bindCommands.includes(pduObj.cmdName)) {
			this.log.info('session - bind on an already bound session', { cmdName: pduObj.cmdName });
			await this.session.sendReturn(pduObj, 'ESME_RALYBND', { system_id: this.systemId });

			return;
		}

		this.log.info('session - no handler for command', { cmdName: pduObj.cmdName });
		await this.session.sendReturn(pduObj, 'ESME_RINVCMDID');
	}

	/** SMPP carries a mobile-originated message and a delivery receipt on the same command. */
	private async onDeliverSm(pduObj: PduObject): Promise<void> {
		const dlr = dlrFromPdu(pduObj, this.smsIdFormat);

		if (!dlr) {
			this.onMessage(pduObj);

			return;
		}

		this.session.emit('dlr', dlr, pduObj);

		const merged = this.dlrMerger.collect(dlr);

		if (merged) this.session.emit('messageDlr', merged);

		await this.session.sendReturn(pduObj);
	}

	private onMessage(pduObj: PduObject): void {
		const message = pduObj.params.short_message;
		const carriesUdh = hasUdh(paramNumber(pduObj.params.esm_class, 0));
		const concat = carriesUdh && Buffer.isBuffer(message) ? concatInfo(message) : undefined;

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

		const generation = this.linkGeneration;

		const sms = createSms({
			from: paramText(first.params.source_addr),
			message: decodeSegments(pduObjs),
			pduObjs,
			session: this.session,
			to: paramText(first.params.destination_addr),
		}, {
			lostLink: () => this.linkGeneration !== generation,
			// A turn later, so a listener sending its receipt straight after the response still holds.
			onAnswered: () => { setImmediate(() => { this.held.release(pduObjs); }); },
			// Past the refusal only while a drain is still waiting for this message; an ordinary send after.
			send: input => (this.held.has(pduObjs) ? this.sendPastDrain(input) : this.session.send(input)),
		});

		this.held.hold(pduObjs);

		// A message nobody took is not work a shutdown can wait for.
		if (!this.session.emit('sms', sms)) this.held.release(pduObjs);
	}
}
