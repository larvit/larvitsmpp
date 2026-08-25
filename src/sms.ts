import type { ErrorName } from './defs/errors.ts';
import type { MessageState } from './defs/constants.ts';
import type { PduObject } from './pdu.ts';
import type { Result, VoidResult } from './result.ts';
import type { Session } from './session.ts';
import { consts } from './defs/constants.ts';
import { receiptCodes } from './dlr.ts';
import { smppDate } from './message.ts';
import { uuidv7 } from './uuid.ts';

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
	sendDlr: (status?: MessageState) => Promise<Result<{ pduObjs: PduObject[] }>>;
	/** Answers every segment. Part of the protocol, not optional. Defaults to ESME_ROK. */
	sendResp: (status?: ErrorName) => Promise<VoidResult>;
	session: Session;
	/** Generated as a UUID v7 unless the application sets its own before answering. */
	smsId: string;
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

/** Each segment of a multipart message gets its own message_id, as a separate submit_sm must. */
function segmentId(smsId: string, index: number, total: number): string {
	return total === 1 ? smsId : `${smsId}-${String(index + 1)}`;
}

export function createSms(input: SmsInput): Sms {
	const first = input.pduObjs[0];
	const registered = first?.params.registered_delivery;
	const dataCoding = first?.params.data_coding;

	const sms: Sms = {
		dlr: typeof registered === 'number' && registered !== 0,
		flash: typeof dataCoding === 'number' && (dataCoding & 0xF0) === 0x10,
		from: input.from,
		message: input.message,
		pduObjs: input.pduObjs,
		sendDlr: status => sendDlr(sms, status),
		sendResp: status => sendResp(sms, status),
		session: input.session,
		smsId: uuidv7(),
		submitTime: new Date(),
		to: input.to,
	};

	return sms;
}

async function sendResp(sms: Sms, status: ErrorName = 'ESME_ROK'): Promise<VoidResult> {
	const total = sms.pduObjs.length;

	if (total === 0) {
		return { err: new Error('No PDUs to answer') };
	}

	const results = await Promise.all(sms.pduObjs.map((pduObj, index) => sms.session.sendReturn(
		pduObj,
		status,
		{ message_id: segmentId(sms.smsId, index, total) },
	)));

	return results.find(result => result.err) ?? {};
}

async function sendDlr(
	sms: Sms,
	status: MessageState = 'DELIVERED',
): Promise<Result<{ pduObjs: PduObject[] }>> {
	const statusId = consts.MESSAGE_STATE[status];
	const total = sms.pduObjs.length;
	const pduObjs: PduObject[] = [];

	for (let index = 0; index < total; index++) {
		const smsId = segmentId(sms.smsId, index, total);
		const delivered = status === 'DELIVERED';
		const message = [
			`id:${smsId}`,
			'sub:001',
			`dlvrd:${delivered ? '001' : '000'}`,
			`submit date:${smppDate(sms.submitTime)}`,
			`done date:${smppDate(new Date())}`,
			`stat:${receiptCodes[status]}`,
			`err:${delivered ? '000' : '001'}`,
			'text:',
		].join(' ');

		const sent = await sms.session.send({
			cmdName: 'deliver_sm',
			params: {
				destination_addr: sms.from,
				esm_class: consts.ESM_CLASS.MC_DELIVERY_RECEIPT,
				short_message: message,
				source_addr: sms.to,
			},
			tlvs: {
				message_state: { tagId: 0x0427, tagName: 'message_state', tagValue: statusId },
				receipted_message_id: {
					tagId: 0x001E,
					tagName: 'receipted_message_id',
					tagValue: smsId,
				},
			},
		});

		if (sent.err) return { err: sent.err };

		pduObjs.push(sent.pduObj);
	}

	return { pduObjs };
}
