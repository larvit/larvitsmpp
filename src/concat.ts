import type { ConcatInfo } from './udh.ts';
import type { PduObject } from './pdu.ts';
import { concatInfo } from './udh.ts';
import { hasUdh } from './defs/constants.ts';
import { messageOctets } from './message-body.ts';
import { paramNumber } from './defs/types.ts';

/** Where a segment sits in its message, and what ties it to the rest of that message. */
export type Concat = ConcatInfo & {
	/** Which of the two carried the numbering: their references are counters of their own. */
	spelling: 'sar' | 'udh';
};

function sarConcat(pduObj: PduObject): Concat | undefined {
	const reference = pduObj.tlvs.sar_msg_ref_num?.tagValue;
	const part = pduObj.tlvs.sar_segment_seqnum?.tagValue;
	const total = pduObj.tlvs.sar_total_segments?.tagValue;

	if (typeof reference !== 'number' || typeof part !== 'number' || typeof total !== 'number') {
		return undefined;
	}

	return { part, reference, spelling: 'sar', total };
}

/**
 * How a PDU says it is one segment of a longer message: the UDH its body starts with, or the
 * sar_* TLVs SMPP 3.4 5.3.2.31-5.3.2.33 define in its place. A UDH that names the concatenation
 * wins; one carrying only a port or a language indicator leaves the TLVs to say.
 */
export function concatOf(pduObj: PduObject): Concat | undefined {
	const body = messageOctets(pduObj);
	const udh = body !== undefined && hasUdh(paramNumber(pduObj.params.esm_class, 0))
		? concatInfo(body)
		: undefined;

	if (udh) return { ...udh, spelling: 'udh' };

	return sarConcat(pduObj);
}
