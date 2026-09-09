import type { EncodingName, Unencodable } from './defs/encodings.ts';
import type { ParamValue } from './defs/types.ts';
import type { SubmitMessagingMode } from './defs/constants.ts';
import type { PduObject, PduObjectInput } from './pdu.ts';
import type { Result } from './result.ts';
import type { SmppLog } from './log.ts';
import type { SmsIdNotation } from './sms-id.ts';
import { UnansweredError } from './unanswered-error.ts';
import { consts, defaultMessagingMode, isMessagingMode, isSubmitMessagingMode, submitMessagingModes } from './defs/constants.ts';
import { dataCodingByEncoding, detect, encodingNames, isEncodingName, unencodable, unencodableText } from './defs/encodings.ts';
import { namedValue } from './error-from.ts';
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
	messagingMode?: SubmitMessagingMode;
	scheduleDeliveryTime?: Date | number | string;
	sourceAddrNpi?: number;
	sourceAddrTon?: number;
	to: string;
	validityPeriod?: Date | number | string;
};

/** The options as they arrive: a caller without types can put anything in the checked fields. */
export type SendSmsInput =
	Omit<SendSmsOptions, 'encoding' | 'messagingMode' | 'scheduleDeliveryTime' | 'validityPeriod'> & {
		encoding?: unknown;
		messagingMode?: unknown;
		scheduleDeliveryTime?: unknown;
		validityPeriod?: unknown;
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

/** The time fields as the wire spells them, settled once for a message rather than per segment. */
type SendTimes = {
	scheduleDeliveryTime?: string;
	validityPeriod?: string;
};

/** What the checks below settle, before a segment exists to carry it. */
type CheckedOptions = {
	encoding: EncodingName;
	messagingMode: SubmitMessagingMode;
	times: SendTimes;
};

type SegmentOptions = {
	encoding: EncodingName;
	messagingMode?: SubmitMessagingMode;
	multipart: boolean;
	times?: SendTimes;
};

/** Alphanumeric senders must be TON 5. */
function addressTon(address: string): number {
	return /^\+?\d+$/.test(address) ? consts.TON.INTERNATIONAL : consts.TON.ALPHANUMERIC;
}

function dataCodingFor(encoding: EncodingName, flash: boolean): number {
	if (!flash) return dataCodingByEncoding[encoding];

	// Message class present (0x10) plus the alphabet bits, so flash survives UCS2.
	return encoding === 'UCS2' ? 0x18 : 0x10;
}

/** The mode the caller named sits beside the UDH indicator, which a segment carrying one must keep. */
function esmClassFor(mode: SubmitMessagingMode | undefined, multipart: boolean): number {
	const udh = multipart ? consts.ESM_CLASS.UDH_INDICATOR : 0;

	return consts.MESSAGING_MODE[mode ?? defaultMessagingMode] | udh;
}

export function submitSmParams(
	sms: Omit<SendSmsInput, 'scheduleDeliveryTime' | 'validityPeriod'>,
	segment: Buffer,
	options: SegmentOptions,
): Record<string, ParamValue> {
	const params: Record<string, ParamValue> = {
		data_coding: dataCodingFor(options.encoding, sms.flash === true),
		destination_addr: sms.to,
		dest_addr_npi: sms.destinationAddrNpi ?? 0,
		dest_addr_ton: sms.destinationAddrTon ?? addressTon(sms.to),
		esm_class: esmClassFor(options.messagingMode, options.multipart),
		short_message: segment,
		source_addr: sms.from,
		source_addr_npi: sms.sourceAddrNpi ?? 0,
		source_addr_ton: sms.sourceAddrTon ?? addressTon(sms.from),
	};

	const schedule = options.times?.scheduleDeliveryTime;
	const validity = options.times?.validityPeriod;

	if (sms.dlr === true) params.registered_delivery = consts.REGISTERED_DELIVERY.FINAL;
	if (schedule !== undefined) params.schedule_delivery_time = schedule;
	if (validity !== undefined) params.validity_period = validity;

	return params;
}

function refusedMode(mode: unknown): Error {
	if (isMessagingMode(mode)) {
		return new Error(`messagingMode ${mode} is data_sm only (SMPP 3.4 2.10.3), name ${submitMessagingModes.join(', ')}`);
	}

	return new Error(`messagingMode must be ${submitMessagingModes.join(', ')}, got ${namedValue(mode)}`);
}

/** SMPP 3.4 2.10.2 defines the delivery report away under datagram mode, so one asked for never comes. */
function checkedMode(
	messagingMode: SubmitMessagingMode,
	dlr: boolean,
): Result<{ messagingMode: SubmitMessagingMode }> {
	if (dlr && messagingMode === 'DATAGRAM') {
		return { err: new Error('messagingMode DATAGRAM has no delivery report to ask for, so dlr must be false') };
	}

	return { messagingMode };
}

function checkMessagingMode(
	mode: unknown,
	dlr: boolean,
): Result<{ messagingMode: SubmitMessagingMode }> {
	if (mode === undefined) return checkedMode(defaultMessagingMode, dlr);
	if (isSubmitMessagingMode(mode)) return checkedMode(mode, dlr);

	return { err: refusedMode(mode) };
}

function refusedEncoding(encoding: unknown): Error {
	if (encoding === 'FLASH') {
		return new Error('encoding FLASH is a message class rather than an alphabet; ask for it as flash: true beside the alphabet you want');
	}

	return new Error(`encoding must be ${encodingNames.join(', ')}, got ${namedValue(encoding)}`);
}

function refusedText(encoding: EncodingName, at: Unencodable): Error {
	return new Error(`encoding ${encoding} cannot carry ${unencodableText(at)}; name UCS2 or leave encoding out`);
}

/** An alphabet the caller named has to carry the message; the one detect() picks always does. */
function checkEncoding(encoding: unknown, message: string): Result<{ encoding: EncodingName }> {
	if (encoding === undefined) return { encoding: detect(message) };
	if (!isEncodingName(encoding)) return { err: refusedEncoding(encoding) };

	const lost = unencodable(message, encoding);

	return lost ? { err: refusedText(encoding, lost) } : { encoding };
}

function checkTimes(sms: SendSmsInput): Result<{ times: SendTimes }> {
	const times: SendTimes = {};

	for (const option of ['scheduleDeliveryTime', 'validityPeriod'] as const) {
		const value = sms[option];

		if (value === undefined) continue;

		if (typeof value !== 'number' && typeof value !== 'string' && !(value instanceof Date)) {
			return { err: new Error(`${option} must be a Date, a number of seconds or an SMPP stamp, got ${namedValue(value)}`) };
		}

		const encoded = smppTime.encode(value);

		if (encoded.err) return { err: new Error(`${option}: ${encoded.err.message}`) };

		times[option] = encoded.text;
	}

	return { times };
}

/** GSM 03.38 section 4 gives the class groups GSM 7-bit, 8-bit data and UCS2, and no Latin-1 at all. */
function checkFlash(encoding: EncodingName, flash: boolean): Error | undefined {
	if (!flash || encoding !== 'LATIN1') return undefined;

	return new Error('flash has no Latin-1 spelling: a message class carries GSM 7-bit, 8-bit data or UCS2, and 8-bit data is not text a handset will display, so send it as UCS2 or drop flash');
}

/** Every option a send can be refused for, so nothing is built for a message that will not go. */
function checkOptions(sms: SendSmsInput): Result<CheckedOptions> {
	const mode = checkMessagingMode(sms.messagingMode, sms.dlr === true);

	if (mode.err) return { err: mode.err };

	const chosen = checkEncoding(sms.encoding, sms.message);

	if (chosen.err) return { err: chosen.err };

	const unspellable = checkFlash(chosen.encoding, sms.flash === true);

	if (unspellable) return { err: unspellable };

	const times = checkTimes(sms);

	if (times.err) return { err: times.err };

	return { encoding: chosen.encoding, messagingMode: mode.messagingMode, times: times.times };
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
export async function submitSms(deps: SendSmsDeps, sms: SendSmsInput): Promise<SendSmsResult> {
	const options = checkOptions(sms);

	if (options.err) return unsent(options.err);

	const encoding = options.encoding;
	const segments = splitMessage(sms.message, { encoding, reference: deps.reference });
	const refused = checkSegments(sms.maxSegments ?? maxSegments, segments.length);

	if (refused) return unsent(refused);

	const multipart = segments.length > 1;

	deps.log.debug('sendSms() - sending', { encoding, segments: segments.length, to: sms.to });

	// Segments go out together rather than one-after-a-response: a receiver that waits for every
	// segment before answering — this library's own server does — would otherwise deadlock.
	const sent = await Promise.all(segments.map(segment => deps.send({
		cmdName: 'submit_sm',
		params: submitSmParams(sms, segment, {
			encoding,
			messagingMode: options.messagingMode,
			multipart,
			times: options.times,
		}),
	})));

	return collectSent(sent, deps.respIdNotation);
}
