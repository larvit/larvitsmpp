import type { PduObject } from './pdu.ts';
import { concatInfo } from './udh.ts';
import { hasUdh } from './defs/constants.ts';
import { messageOctets } from './message-body.ts';
import { paramNumber } from './defs/types.ts';

/** Where a segment sits in its message, and the identity every segment of that message shares. */
export type Concat = {
	/** Namespaced by the spelling it was read from: the two count in reference spaces of their own. */
	group: string;
	part: number;
	total: number;
};

function sarConcat(pduObj: PduObject): Concat | undefined {
	const reference = pduObj.tlvs.sar_msg_ref_num?.tagValue;
	const part = pduObj.tlvs.sar_segment_seqnum?.tagValue;
	const total = pduObj.tlvs.sar_total_segments?.tagValue;

	if (typeof reference !== 'number' || typeof part !== 'number' || typeof total !== 'number') {
		return undefined;
	}

	return { group: `sar:${String(reference)}`, part, total };
}

/**
 * How a PDU says it is one segment of a longer message: the UDH its body starts with, or the
 * sar_* TLVs SMPP 3.4 5.3.2.31-5.3.2.33 define in its place. The UDH wins where a peer wrote both.
 */
export function concatOf(pduObj: PduObject): Concat | undefined {
	const body = messageOctets(pduObj);
	const udh = body !== undefined && hasUdh(paramNumber(pduObj.params.esm_class, 0))
		? concatInfo(body)
		: undefined;

	if (udh) return { group: `udh:${String(udh.reference)}`, part: udh.part, total: udh.total };

	return sarConcat(pduObj);
}
