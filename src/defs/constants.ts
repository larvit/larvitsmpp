/** The version declared on the wire. The tables below cover 5.0, which is a superset of it. */
export const defaultInterfaceVersion = 0x34;

/** Spec rule, not a preference: a peer declaring less than 3.4 is sent no optional parameters. */
export const optionalParamsMinVersion = 0x34;

export const consts = {
	BROADCAST_AREA_FORMAT: {
		ALIAS: 0x00,
		ELLIPSOID_ARC: 0x01,
		NAME: 0x00,
		POLYGON: 0x02,
	},
	BROADCAST_FREQUENCY_INTERVAL: {
		DAYS: 0x0B,
		HOURS: 0x0A,
		MAX_POSSIBLE: 0x00,
		MINUTES: 0x09,
		MONTHS: 0x0D,
		SECONDS: 0x08,
		WEEKS: 0x0C,
		YEARS: 0x0E,
	},
	ENCODING: {
		ASCII: 0x01,
		BINARY: 0x04,
		CYRILLIC: 0x06,
		EXTENDED_KANJI_JIS: 0x0D,
		FLASH: 0x10,
		HEBREW: 0x07,
		IA5: 0x01,
		ISO_2022_JP: 0x0A,
		ISO_8859_1: 0x03,
		ISO_8859_5: 0x06,
		ISO_8859_8: 0x07,
		JIS: 0x05,
		KS_C_5601: 0x0E,
		LATIN1: 0x03,
		PICTOGRAM: 0x09,
		UCS2: 0x08,
		X_0208_1990: 0x05,
		X_0212_1990: 0x0D,
	},
	ESM_CLASS: {
		CONVERSATION_ABORT: 0x18,
		DATAGRAM: 0x01,
		DELIVERY_ACKNOWLEDGEMENT: 0x08,
		FORWARD: 0x02,
		INTERMEDIATE_DELIVERY: 0x20,
		MC_DELIVERY_RECEIPT: 0x04,
		SET_REPLY_PATH: 0x80,
		STORE_FORWARD: 0x03,
		UDH_INDICATOR: 0x40,
		USER_ACKNOWLEDGEMENT: 0x10,
	},
	MESSAGE_STATE: {
		ACCEPTED: 6,
		DELETED: 4,
		DELIVERED: 2,
		ENROUTE: 1,
		EXPIRED: 3,
		REJECTED: 8,
		SCHEDULED: 0,
		SKIPPED: 9,
		UNDELIVERABLE: 5,
		UNKNOWN: 7,
	},
	NETWORK: {
		CDMA: 0x03,
		GENERIC: 0x00,
		GSM: 0x01,
		TDMA: 0x02,
	},
	NPI: {
		DATA: 0x03,
		ERMES: 0x0A,
		INTERNET: 0x0E,
		IP: 0x0E,
		ISDN: 0x01,
		LAND_MOBILE: 0x06,
		NATIONAL: 0x08,
		PRIVATE: 0x09,
		TELEX: 0x04,
		UNKNOWN: 0x00,
		WAP: 0x12,
	},
	REGISTERED_DELIVERY: {
		DELIVERY_ACKNOWLEDGEMENT: 0x04,
		FAILURE: 0x02,
		FINAL: 0x01,
		INTERMEDIATE: 0x10,
		SUCCESS: 0x03,
		USER_ACKNOWLEDGEMENT: 0x08,
	},
	TON: {
		ABBREVIATED: 0x06,
		ALPHANUMERIC: 0x05,
		INTERNATIONAL: 0x01,
		NATIONAL: 0x02,
		NETWORK_SPECIFIC: 0x03,
		SUBSCRIBER_NUMBER: 0x04,
		UNKNOWN: 0x00,
	},
} as const;

export function hasUdh(esmClass: number): boolean {
	return (esmClass & consts.ESM_CLASS.UDH_INDICATOR) === consts.ESM_CLASS.UDH_INDICATOR;
}

/** Bits 5-2 of esm_class; the rest carry the messaging mode and the GSM features. */
export function messageTypeOf(esmClass: number): number {
	return esmClass & 0x3c;
}

export type ConstGroup = keyof typeof consts;
export type MessageState = keyof typeof consts.MESSAGE_STATE;

// Aliased values (NPI.IP === NPI.INTERNET === 0x0E) resolve to whichever name sorts last.
export const constsById: Record<string, Record<number, string>> = {};

for (const [groupName, group] of Object.entries(consts)) {
	const byId: Record<number, string> = {};

	for (const [name, value] of Object.entries(group)) {
		byId[value] = name;
	}

	constsById[groupName] = byId;
}
