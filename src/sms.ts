import type { ErrorName } from './defs/errors.ts';
import type { MessageState } from './defs/constants.ts';
import type { PduObject, PduObjectInput, TlvInput } from './pdu.ts';
import type { Result, VoidResult } from './result.ts';
import type { Session } from './session.ts';
import { UnansweredError } from './unanswered-error.ts';
import { consts } from './defs/constants.ts';
import { receiptCodes } from './dlr.ts';
import { smppDate } from './message.ts';
import { uuidv7 } from './uuid.ts';

/** Both fields hold what the peer took, so a partial failure names what is already receipted. */
export type SendDlrResult = {
	err?: Error;
	pduObjs: PduObject[];
	/** Segments that went out unanswered. The peer may have taken them, so sending again may duplicate. */
	unanswered: number;
};

export type SendRespOptions = {
	/** The id the peer correlates a later delivery receipt by. Defaults to a generated UUID v7. */
	smsId?: string;
	status?: ErrorName;
};

/**
 * A received SMS, and the handle for answering it. Multipart messages arrive as one Sms carrying
 * every segment's PDU.
 */
export type Sms = {
	dlr: boolean;
	flash: boolean;
	from: string;
	message: string;
	pduObjs: PduObject[];
	/** Sends a delivery report back to the sender. Defaults to DELIVERED. */
	sendDlr: (status?: MessageState) => Promise<SendDlrResult>;
	/** Answers every segment. Part of the protocol, not optional. Defaults to ESME_ROK. */
	sendResp: (options?: SendRespOptions) => Promise<VoidResult>;
	session: Session;
	/** The id answered to the peer: what sendResp() was given, or a generated UUID v7. */
	readonly smsId: string;
	submitTime: Date;
	to: string;
};

export type SmsInput = {
	from: string;
	message: string;
	pduObjs: PduObject[];
	session: Session;
	to: string;
};

/** What the session's incoming side gives a message so it can be answered and accounted for. */
export type SmsHandlers = {
	onAnswered: () => void;
	send: (input: PduObjectInput) => Promise<Result<{ pduObj: PduObject }>>;
};

/** Each segment of a multipart message gets its own message_id, as a separate submit_sm must. */
function segmentId(smsId: string, index: number, total: number): string {
	return total === 1 ? smsId : `${smsId}-${String(index + 1)}`;
}

export function createSms(input: SmsInput, handlers: SmsHandlers): Sms {
	const first = input.pduObjs[0];
	const registered = first?.params.registered_delivery;
	const dataCoding = first?.params.data_coding;
	const answered = { smsId: uuidv7() };

	const sms: Sms = {
		dlr: typeof registered === 'number' && registered !== 0,
		flash: typeof dataCoding === 'number' && (dataCoding & 0xF0) === 0x10,
		from: input.from,
		message: input.message,
		pduObjs: input.pduObjs,
		sendDlr: status => sendDlr(sms, handlers.send, status),
		sendResp: options => sendResp(sms, answered, options ?? {}).finally(handlers.onAnswered),
		session: input.session,
		get smsId(): string {
			return answered.smsId;
		},
		submitTime: new Date(),
		to: input.to,
	};

	return sms;
}

async function sendResp(
	sms: Sms,
	answered: { smsId: string },
	options: SendRespOptions,
): Promise<VoidResult> {
	const total = sms.pduObjs.length;

	if (total === 0) {
		return { err: new Error('No PDUs to answer') };
	}

	if (options.smsId === '') {
		return { err: new Error('smsId must not be empty') };
	}

	if (options.smsId !== undefined) answered.smsId = options.smsId;

	const results = await Promise.all(sms.pduObjs.map((pduObj, index) => sms.session.sendReturn(
		pduObj,
		options.status ?? 'ESME_ROK',
		{ message_id: segmentId(answered.smsId, index, total) },
	)));

	return results.find(result => result.err) ?? {};
}

/** The receipt as text, which is all of it a peer below SMPP 3.4 is allowed to be sent. */
function receiptText(sms: Sms, smsId: string, status: MessageState): string {
	const delivered = status === 'DELIVERED';

	return [
		`id:${smsId}`,
		'sub:001',
		`dlvrd:${delivered ? '001' : '000'}`,
		`submit date:${smppDate(sms.submitTime)}`,
		`done date:${smppDate(new Date())}`,
		`stat:${receiptCodes[status]}`,
		`err:${delivered ? '000' : '001'}`,
		'text:',
	].join(' ');
}

function receiptTlvs(smsId: string, status: MessageState): Record<string, TlvInput> {
	return {
		message_state: { tagValue: consts.MESSAGE_STATE[status] },
		receipted_message_id: { tagValue: smsId },
	};
}

function collectReceipt(sent: Result<{ pduObj: PduObject }>[]): SendDlrResult {
	const pduObjs: PduObject[] = [];
	let failure: Error | undefined;
	let unanswered = 0;

	for (const one of sent) {
		if (one.err) {
			if (one.err instanceof UnansweredError) unanswered++;

			failure ??= one.err;
		} else if (one.pduObj.cmdStatus === 'ESME_ROK') {
			pduObjs.push(one.pduObj);
		} else {
			const refusal = one.pduObj.cmdStatus ?? String(one.pduObj.cmdStatusId);

			failure ??= new Error(`deliver_sm refused by the peer: ${refusal}`);
		}
	}

	return failure ? { err: failure, pduObjs, unanswered } : { pduObjs, unanswered };
}

async function sendDlr(
	sms: Sms,
	send: SmsHandlers['send'],
	status: MessageState = 'DELIVERED',
): Promise<SendDlrResult> {
	if (!sms.session.bindAllows('deliver_sm')) {
		return {
			err: new Error('A transmitter-bound session does not carry deliver_sm'),
			pduObjs: [],
			unanswered: 0,
		};
	}

	const total = sms.pduObjs.length;
	// Together, not one after a response: a drain waiting for this message must see the whole receipt.
	const sent = await Promise.all(sms.pduObjs.map((_segment, index) => {
		const smsId = segmentId(sms.smsId, index, total);

		return send({
			cmdName: 'deliver_sm',
			params: {
				destination_addr: sms.from,
				esm_class: consts.ESM_CLASS.MC_DELIVERY_RECEIPT,
				short_message: receiptText(sms, smsId, status),
				source_addr: sms.to,
			},
			...(sms.session.acceptsOptionalParams() ? { tlvs: receiptTlvs(smsId, status) } : {}),
		});
	}));
	return collectReceipt(sent);
}
