import type { EncodingName } from './defs/encodings.ts';
import type { MessagingMode } from './defs/constants.ts';
import type { ParamValue } from './defs/types.ts';
import type { PduObject, PduObjectInput } from './pdu.ts';
import type { Result } from './result.ts';
import type { SmppLog } from './log.ts';
import type { SmsIdNotation } from './sms-id.ts';
import { UnansweredError } from './unanswered-error.ts';
import { consts, isMessagingMode, messagingModes } from './defs/constants.ts';
import { detect } from './defs/encodings.ts';
import { normaliseSmsId } from './sms-id.ts';
import { paramText } from './defs/types.ts';
import { maxSegments, smppTime, splitMessage } from './message.ts';

export type SendSmsOptions = {
	dlr?: boolean;
	destinationAddrNpi?: number;
	destinationAddrTon?: number;
	encoding?: EncodingName;
	flash?: boolean;
	from: string;
	/** Refuse before sending anything if the message needs more than this many segments. */
	maxSegments?: number;
	message: string;
	/** The esm_class messaging mode, SMPP 3.4 5.2.12. Absent leaves the choice to the SMSC. */
	messagingMode?: MessagingMode;
	scheduleDeliveryTime?: Date | number | string;
	sourceAddrNpi?: number;
	sourceAddrTon?: number;
	to: string;
	validityPeriod?: Date | number | string;
};

/** Both arrays hold what the peer accepted, so a partial failure names what is already delivered. */
export type SendSmsResult = {
	err?: Error;
	pduObjs: PduObject[];
	smsIds: string[];
	/** Segments that went out unanswered. The peer may have taken them, so sending again may duplicate. */
	unanswered: number;
};

/** A message that never went out, in the shape a caller aggregating segments still reads. */
export function unsent(err: Error): SendSmsResult {
	return { err, pduObjs: [], smsIds: [], unanswered: 0 };
}

/** What sending needs from the session: a concat reference and a way onto the wire. */
export type SendSmsDeps = {
	log: SmppLog;
	reference: number;
	respIdNotation?: SmsIdNotation | undefined;
	send: (input: PduObjectInput) => Promise<Result<{ pduObj: PduObject }>>;
};

type SegmentOptions = {
	encoding: EncodingName;
	multipart: boolean;
};

/** Alphanumeric senders must be TON 5. */
function addressTon(address: string): number {
	return /^\+?\d+$/.test(address) ? consts.TON.INTERNATIONAL : consts.TON.ALPHANUMERIC;
}

function dataCodingFor(encoding: EncodingName, flash: boolean): number {
	if (!flash) return consts.ENCODING[encoding];

	// Message class present (0x10) plus the alphabet bits, so flash survives UCS2.
	return encoding === 'UCS2' ? 0x18 : 0x10;
}

/** The mode the caller named sits beside the UDH indicator, which a segment carrying one must keep. */
function esmClassFor(mode: MessagingMode | undefined, multipart: boolean): number {
	const udh = multipart ? consts.ESM_CLASS.UDH_INDICATOR : 0;

	return consts.MESSAGING_MODE[mode ?? 'SMSC_DEFAULT'] | udh;
}

export function submitSmParams(
	sms: SendSmsOptions,
	segment: Buffer,
	options: SegmentOptions,
): Record<string, ParamValue> {
	const params: Record<string, ParamValue> = {
		data_coding: dataCodingFor(options.encoding, sms.flash === true),
		destination_addr: sms.to,
		dest_addr_npi: sms.destinationAddrNpi ?? 0,
		dest_addr_ton: sms.destinationAddrTon ?? addressTon(sms.to),
		esm_class: esmClassFor(sms.messagingMode, options.multipart),
		short_message: segment,
		source_addr: sms.from,
		source_addr_npi: sms.sourceAddrNpi ?? 0,
		source_addr_ton: sms.sourceAddrTon ?? addressTon(sms.from),
	};

	if (sms.dlr === true) params.registered_delivery = consts.REGISTERED_DELIVERY.FINAL;
	if (sms.scheduleDeliveryTime !== undefined) {
		params.schedule_delivery_time = smppTime.encode(sms.scheduleDeliveryTime);
	}
	if (sms.validityPeriod !== undefined) {
		params.validity_period = smppTime.encode(sms.validityPeriod);
	}

	return params;
}

/** The mode is named, never written as bits: a number could clear the UDH indicator a segment needs. */
export function checkMessagingMode(mode: unknown): Error | undefined {
	if (mode === undefined || isMessagingMode(mode)) return undefined;

	// String() throws on a null-prototype object, and this value is whatever the caller passed.
	const got = typeof mode === 'string' || typeof mode === 'number' ? String(mode) : typeof mode;

	return new Error(`messagingMode must be ${messagingModes.join(', ')}, got ${got}`);
}

/** Nothing goes on the wire until the whole message fits: a half-sent message bills twice. */
function checkSegments(allowed: number, segments: number): Error | undefined {
	if (!Number.isInteger(allowed) || allowed < 1 || allowed > maxSegments) {
		return new Error(`maxSegments must be between 1 and ${String(maxSegments)}, got ${String(allowed)}`);
	}

	if (segments === 0) {
		return new Error(`Message needs more than ${String(maxSegments)} segments, the concatenation limit`);
	}

	if (segments > allowed) {
		return new Error(`Message needs ${String(segments)} segments, more than the ${String(allowed)} allowed`);
	}

	return undefined;
}

function collectSent(
	sent: Result<{ pduObj: PduObject }>[],
	notation: SmsIdNotation | undefined,
): SendSmsResult {
	const pduObjs: PduObject[] = [];
	const smsIds: string[] = [];
	let failure: Error | undefined;
	let unanswered = 0;

	for (const one of sent) {
		if (one.err) {
			if (one.err instanceof UnansweredError) unanswered++;

			failure ??= one.err;
		} else if (one.pduObj.cmdStatus === 'ESME_ROK') {
			pduObjs.push(one.pduObj);
			smsIds.push(normaliseSmsId(paramText(one.pduObj.params.message_id), notation));
		} else {
			const refusal = one.pduObj.cmdStatus ?? String(one.pduObj.cmdStatusId);

			failure ??= new Error(`submit_sm refused by the peer: ${refusal}`);
		}
	}

	return failure ? { err: failure, pduObjs, smsIds, unanswered } : { pduObjs, smsIds, unanswered };
}

/** Puts a message on the wire as one submit_sm per segment. */
export async function submitSms(deps: SendSmsDeps, sms: SendSmsOptions): Promise<SendSmsResult> {
	const unnamed = checkMessagingMode(sms.messagingMode);

	if (unnamed) return unsent(unnamed);

	const allowed = sms.maxSegments ?? maxSegments;
	const encoding = sms.encoding ?? detect(sms.message);
	const segments = splitMessage(sms.message, { encoding, reference: deps.reference });
	const refused = checkSegments(allowed, segments.length);

	if (refused) return unsent(refused);

	const multipart = segments.length > 1;

	deps.log.debug('sendSms() - sending', { encoding, segments: segments.length, to: sms.to });

	// Segments go out together rather than one-after-a-response: a receiver that waits for every
	// segment before answering — this library's own server does — would otherwise deadlock.
	const sent = await Promise.all(segments.map(segment => deps.send({
		cmdName: 'submit_sm',
		params: submitSmParams(sms, segment, { encoding, multipart }),
	})));

	return collectSent(sent, deps.respIdNotation);
}
