import type { ParamValue } from './defs/types.ts';

const notations = {
	decimal: { digits: /^[0-9]+$/, prefix: '' },
	hex: { digits: /^[0-9a-f]+$/i, prefix: '0x' },
};

const places = ['receipt', 'submitResp'] as const;

/** The notation a peer writes message ids in. */
export type SmsIdNotation = keyof typeof notations;

/** The notation per place the peer writes an id. An omitted place is left as it arrived. */
export type SmsIdFormat = Partial<Record<typeof places[number], SmsIdNotation | undefined>>;

export const smsIdNotations: readonly string[] = Object.keys(notations);

export const smsIdPlaces: readonly string[] = places;

export function isSmsIdNotation(value: unknown): value is SmsIdNotation {
	return typeof value === 'string' && Object.hasOwn(notations, value);
}

// SMPP 3.4 caps message_id at 64 octets, and BigInt on a longer string is a peer-controlled cost.
const maxIdLength = 64;

/**
 * The id as a plain decimal value, so an SMSC that answers a submit in one notation and writes the
 * receipt in another still correlates.
 */
export function normaliseSmsId(id: string, notation: SmsIdNotation | undefined): string {
	if (!isSmsIdNotation(notation) || id.length > maxIdLength) return id;

	const { digits, prefix } = notations[notation];

	return digits.test(id) ? BigInt(`${prefix}${id}`).toString(10) : id;
}

const numbered = /^(.*)-(\d+)$/;

/** Each segment of a multipart message gets its own message_id, as a separate submit_sm must. */
export function segmentId(smsId: string, index: number, total: number): string {
	return total === 1 ? smsId : `${smsId}-${String(index + 1)}`;
}

/** The message and the part an id names, or nothing where `segmentId()` did not write it. */
export function parseSegmentId(smsId: string): { base: string; part: number } | undefined {
	const match = numbered.exec(smsId);
	const base = match?.[1];
	const part = match?.[2];

	if (base === undefined || part === undefined) return undefined;

	return { base, part: Number(part) };
}

/** SMPP 3.4 4.6.2 makes `deliver_sm_resp`'s `message_id` unused, and Jasmin FINs the link over one. */
export function respIdParams(cmdName: string, smsId: string): Record<string, ParamValue> {
	return cmdName === 'deliver_sm' ? {} : { message_id: smsId };
}
