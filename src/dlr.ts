import type { MessageState } from './defs/constants.ts';
import type { ParamValue } from './defs/types.ts';
import type { PduObject } from './pdu.ts';
import { consts, constsById } from './defs/constants.ts';
import { decodeMessage } from './message.ts';
import { paramNumber, paramText } from './defs/types.ts';

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
	smsId: string | undefined;
	statusId: number;
	statusMsg: MessageState;
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
	const date = new Date(Date.UTC(
		century + Number(years),
		Number(months) - 1,
		Number(days),
		Number(hours),
		Number(minutes),
		Number(seconds ?? 0),
	));

	// Date.UTC rolls 31 February over into March rather than refusing it.
	const rolled = date.getUTCMonth() !== Number(months) - 1
		|| date.getUTCDate() !== Number(days)
		|| date.getUTCHours() !== Number(hours)
		|| date.getUTCMinutes() !== Number(minutes)
		|| date.getUTCSeconds() !== Number(seconds ?? 0);

	return rolled ? undefined : date;
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

/** esm_class bits 5-2 name the message type; the rest are the messaging mode and the GSM features. */
const messageTypeBits = 0x3c;

type MessageType = 'other' | 'receipt' | 'unmarked';

function messageType(pduObj: PduObject): MessageType {
	const type = paramNumber(pduObj.params.esm_class, 0) & messageTypeBits;

	if (type === consts.ESM_CLASS.MC_DELIVERY_RECEIPT) return 'receipt';
	if (type !== 0) return 'other';

	return pduObj.tlvs.receipted_message_id === undefined ? 'unmarked' : 'receipt';
}

/** A UDH-carrying short_message reaches here as a buffer, header and all. */
function receiptBody(pduObj: PduObject): string {
	const message = pduObj.params.short_message;

	if (!Buffer.isBuffer(message)) return paramText(message);

	return decodeMessage(
		message,
		paramNumber(pduObj.params.data_coding, 0),
		paramNumber(pduObj.params.esm_class, 0),
	).message;
}

function receiptId(tlvId: ParamValue | undefined, receipt: Receipt | undefined): string | undefined {
	if (typeof tlvId === 'string' && tlvId !== '') return tlvId;

	return receipt?.id === '' ? undefined : receipt?.id;
}

function isMessageState(name: string | undefined): name is MessageState {
	return name !== undefined && name in consts.MESSAGE_STATE;
}

/** The state TLV wins where it names a state we know; an unnameable one leaves the body to say. */
function receiptStatus(
	tlvState: ParamValue | undefined,
	receipt: Receipt | undefined,
): { statusId: number; statusMsg: MessageState | undefined } {
	const scraped = receiptStates[receipt?.stat?.toUpperCase() ?? ''];

	if (typeof tlvState !== 'number') {
		return { statusId: consts.MESSAGE_STATE[scraped ?? 'UNKNOWN'], statusMsg: scraped };
	}

	const named = constsById.MESSAGE_STATE?.[tlvState];

	return { statusId: tlvState, statusMsg: isMessageState(named) ? named : scraped };
}

/**
 * Builds a delivery report from a deliver_sm, or nothing if the PDU carries a message rather than a
 * receipt. `esm_class` decides that where the peer names a message type and a receipted_message_id
 * TLV where it names none; failing both, the body is read for the standard receipt fields, which is
 * the only thing Kannel and several other SMSCs send.
 */
export function dlrFromPdu(pduObj: PduObject): Dlr | undefined {
	const type = messageType(pduObj);

	if (type === 'other') return undefined;

	const body = receiptBody(pduObj);
	const receipt = body === '' ? undefined : parseReceipt(body);
	const smsId = receiptId(pduObj.tlvs.receipted_message_id?.tagValue, receipt);
	const { statusId, statusMsg } = receiptStatus(pduObj.tlvs.message_state?.tagValue, receipt);

	if (type === 'unmarked' && (smsId === undefined || statusMsg === undefined)) return undefined;

	return {
		doneDate: receiptDate(receipt?.doneDate),
		errorCode: receipt?.err,
		receipt,
		smsId,
		statusId,
		statusMsg: statusMsg ?? 'UNKNOWN',
	};
}
