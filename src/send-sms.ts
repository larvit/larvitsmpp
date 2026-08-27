import type { EncodingName } from './defs/encodings.ts';
import type { ParamValue } from './defs/types.ts';
import type { PduObject, PduObjectInput } from './pdu.ts';
import type { Result } from './result.ts';
import type { SmppLog } from './log.ts';
import { consts } from './defs/constants.ts';
import { detect } from './defs/encodings.ts';
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
	scheduleDeliveryTime?: Date | number | string;
	sourceAddrNpi?: number;
	sourceAddrTon?: number;
	to: string;
	validityPeriod?: Date | number | string;
};

/** Both arrays hold what the peer accepted, so a partial failure names what is already delivered. */
export type SendSmsResult = { err?: Error; pduObjs: PduObject[]; smsIds: string[] };

/** What sending needs from the session: a concat reference and a way onto the wire. */
export type SendSmsDeps = {
	log: SmppLog;
	reference: number;
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
		short_message: segment,
		source_addr: sms.from,
		source_addr_npi: sms.sourceAddrNpi ?? 0,
		source_addr_ton: sms.sourceAddrTon ?? addressTon(sms.from),
	};

	if (options.multipart) params.esm_class = consts.ESM_CLASS.UDH_INDICATOR;
	if (sms.dlr === true) params.registered_delivery = consts.REGISTERED_DELIVERY.FINAL;
	if (sms.scheduleDeliveryTime !== undefined) {
		params.schedule_delivery_time = smppTime.encode(sms.scheduleDeliveryTime);
	}
	if (sms.validityPeriod !== undefined) {
		params.validity_period = smppTime.encode(sms.validityPeriod);
	}

	return params;
}

/** Puts a message on the wire as one submit_sm per segment. */
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

function collectSent(sent: Result<{ pduObj: PduObject }>[]): SendSmsResult {
	const pduObjs: PduObject[] = [];
	const smsIds: string[] = [];
	let failure: Error | undefined;

	for (const one of sent) {
		if (one.err) {
			failure ??= one.err;
		} else if (one.pduObj.cmdStatus === 'ESME_ROK') {
			pduObjs.push(one.pduObj);
			smsIds.push(paramText(one.pduObj.params.message_id));
		} else {
			const refusal = one.pduObj.cmdStatus ?? String(one.pduObj.cmdStatusId);

			failure ??= new Error(`submit_sm refused by the peer: ${refusal}`);
		}
	}

	return failure ? { err: failure, pduObjs, smsIds } : { pduObjs, smsIds };
}

export async function submitSms(deps: SendSmsDeps, sms: SendSmsOptions): Promise<SendSmsResult> {
	const allowed = sms.maxSegments ?? maxSegments;
	const encoding = sms.encoding ?? detect(sms.message);
	const segments = splitMessage(sms.message, { encoding, reference: deps.reference });
	const refused = checkSegments(allowed, segments.length);

	if (refused) return { err: refused, pduObjs: [], smsIds: [] };

	const multipart = segments.length > 1;

	deps.log.debug('sendSms() - sending', { encoding, segments: segments.length, to: sms.to });

	// Segments go out together rather than one-after-a-response: a receiver that waits for every
	// segment before answering — this library's own server does — would otherwise deadlock.
	const sent = await Promise.all(segments.map(segment => deps.send({
		cmdName: 'submit_sm',
		params: submitSmParams(sms, segment, { encoding, multipart }),
	})));

	return collectSent(sent);
}
