import type { PduObject } from './pdu.ts';

/**
 * The user data, wherever the peer put it. SMPP 3.4 5.3.2.32 carries up to 64 KB in
 * `message_payload` with `sm_length` 0, and a `data_sm` has nowhere else to put a body at all.
 * A filled `short_message` is the peer using the mandatory field, so it wins over a TLV the spec
 * only allows in its place.
 */
export function messageOctets(pduObj: PduObject): Buffer | undefined {
	const shortMessage = pduObj.shortMessageOctets;

	if (shortMessage !== undefined && shortMessage.length > 0) return shortMessage;

	const payload = pduObj.tlvs.message_payload?.tagValue;

	return Buffer.isBuffer(payload) ? payload : shortMessage;
}
