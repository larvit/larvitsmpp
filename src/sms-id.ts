/** The notation a peer writes message ids in. */
export type SmsIdFormat = 'decimal' | 'hex';

/** The notation per place the peer writes an id. An omitted place is left as it arrived. */
export type SmsIdFormats = {
	receipt?: SmsIdFormat | undefined;
	submitResp?: SmsIdFormat | undefined;
};

export function isSmsIdFormat(value: unknown): value is SmsIdFormat {
	return value === 'decimal' || value === 'hex';
}

// SMPP 3.4 caps message_id at 64 octets, and BigInt on a longer string is a peer-controlled cost.
const maxIdLength = 64;

const notations = {
	decimal: { digits: /^[0-9]+$/, prefix: '' },
	hex: { digits: /^[0-9a-f]+$/i, prefix: '0x' },
};

/**
 * The id as a plain decimal value, so an SMSC that answers a submit in one notation and writes the
 * receipt in another still correlates. An id the notation cannot read is left as it arrived.
 */
export function normaliseSmsId(id: string, format: SmsIdFormat | undefined): string {
	if (format === undefined || id.length > maxIdLength) return id;

	const { digits, prefix } = notations[format];

	return digits.test(id) ? BigInt(`${prefix}${id}`).toString(10) : id;
}
