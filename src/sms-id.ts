const notations = {
	decimal: { digits: /^[0-9]+$/, prefix: '' },
	hex: { digits: /^[0-9a-f]+$/i, prefix: '0x' },
};

const places = ['receipt', 'submitResp'] as const;

/** The notation a peer writes message ids in. */
export type SmsIdNotation = keyof typeof notations;

/** The notation per place the peer writes an id. An omitted place is left as it arrived. */
export type SmsIdFormat = Partial<Record<typeof places[number], SmsIdNotation | undefined>>;

export const smsIdNotations: string[] = Object.keys(notations);

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
