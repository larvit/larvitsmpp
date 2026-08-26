import type { MessageState } from './defs/constants.ts';
import type { PduObject } from './pdu.ts';
import { consts, constsById } from './defs/constants.ts';

/**
 * The seven-character status codes carried in a receipt's `stat:` field, mapped to the
 * message_state values they correspond to.
 */
const receiptStates: Record<string, MessageState> = {
	ACCEPTD: 'ACCEPTED',
	DELETED: 'DELETED',
	DELIVRD: 'DELIVERED',
	ENROUTE: 'ENROUTE',
	EXPIRED: 'EXPIRED',
	REJECTD: 'REJECTED',
	UNDELIV: 'UNDELIVERABLE',
	UNKNOWN: 'UNKNOWN',
};

/** message_state values as the seven-character codes a receipt's `stat:` field must carry. */
export const receiptCodes: Record<MessageState, string> = {
	ACCEPTED: 'ACCEPTD',
	DELETED: 'DELETED',
	DELIVERED: 'DELIVRD',
	ENROUTE: 'ENROUTE',
	EXPIRED: 'EXPIRED',
	REJECTED: 'REJECTD',
	SCHEDULED: 'ENROUTE',
	SKIPPED: 'UNKNOWN',
	UNDELIVERABLE: 'UNDELIV',
	UNKNOWN: 'UNKNOWN',
};

export type Receipt = {
	doneDate: string | undefined;
	dlvrd: number | undefined;
	err: string | undefined;
	id: string | undefined;
	stat: string | undefined;
	sub: number | undefined;
	submitDate: string | undefined;
	text: string | undefined;
};

export type Dlr = {
	doneDate: Date | undefined;
	errorCode: string | undefined;
	receipt: Receipt | undefined;
	smsId: string;
	statusId: number;
	statusMsg: string;
};

const field = (name: string) => new RegExp(`\\b${name}:([^ ]*)`, 'i');

const patterns = {
	dlvrd: field('dlvrd'),
	doneDate: /\bdone date:([^ ]*)/i,
	err: field('err'),
	id: field('id'),
	stat: field('stat'),
	sub: field('sub'),
	submitDate: /\bsubmit date:([^ ]*)/i,
	text: /\btext:(.*)$/i,
};

function toNumber(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;

	const parsed = Number(value);

	return Number.isFinite(parsed) ? parsed : undefined;
}

/** Delivery receipt dates are YYMMDDhhmm, sometimes with seconds. */
function receiptDate(value: string | undefined): Date | undefined {
	if (value === undefined) return undefined;

	const match = /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?$/.exec(value);

	if (!match) return undefined;

	const [, years, months, days, hours, minutes, seconds] = match;
	const century = Math.floor(new Date().getUTCFullYear() / 100) * 100;

	return new Date(Date.UTC(
		century + Number(years),
		Number(months) - 1,
		Number(days),
		Number(hours),
		Number(minutes),
		Number(seconds ?? 0),
	));
}

/**
 * Parses the standard receipt body, as in
 * `id:0123 sub:001 dlvrd:001 submit date:2508251430 done date:2508251431 stat:DELIVRD err:000 text:…`
 */
export function parseReceipt(message: string): Receipt {
	const read = (pattern: RegExp): string | undefined => pattern.exec(message)?.[1];

	return {
		dlvrd: toNumber(read(patterns.dlvrd)),
		doneDate: read(patterns.doneDate),
		err: read(patterns.err),
		id: read(patterns.id),
		stat: read(patterns.stat),
		sub: toNumber(read(patterns.sub)),
		submitDate: read(patterns.submitDate),
		text: read(patterns.text),
	};
}

/**
 * Builds a delivery report from a deliver_sm. The message_state and receipted_message_id TLVs are
 * authoritative when present; otherwise the receipt text is parsed, which is the only thing Kannel
 * and several other SMSCs send. 0.4.0 required the TLVs and rejected everything else.
 */
export function dlrFromPdu(pduObj: PduObject): Dlr | undefined {
	const message = pduObj.params.short_message;
	const receipt = typeof message === 'string' ? parseReceipt(message) : undefined;
	const receiptState = receiptStates[receipt?.stat?.toUpperCase() ?? ''];

	const tlvState = pduObj.tlvs.message_state?.tagValue;
	const tlvId = pduObj.tlvs.receipted_message_id?.tagValue;

	const smsId = typeof tlvId === 'string' && tlvId !== ''
		? tlvId
		: receipt?.id;

	if (smsId === undefined || smsId === '') return undefined;

	const statusMsg = typeof tlvState === 'number'
		? constsById.MESSAGE_STATE?.[tlvState]
		: receiptState;

	if (statusMsg === undefined) return undefined;

	const statusId = typeof tlvState === 'number'
		? tlvState
		: consts.MESSAGE_STATE[receiptState ?? 'UNKNOWN'];

	return {
		doneDate: receiptDate(receipt?.doneDate),
		errorCode: receipt?.err,
		receipt,
		smsId,
		statusId,
		statusMsg,
	};
}
