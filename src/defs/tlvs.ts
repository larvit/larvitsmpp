import type { ParamValue, WireType } from './types.ts';
import { tlv } from './types.ts';

export type TlvDefinition = {
	id: number;
	multiple?: boolean;
	tag: string;
	type: WireType;
};

type TlvSpec = { id: number; multiple?: boolean; type: WireType };

// Ordered by tag id, mirroring the SMPP 5.0 TLV table.
const specs = {
	dest_addr_subunit: { id: 0x0005, type: tlv.int8 },
	dest_network_type: { id: 0x0006, type: tlv.int8 },
	dest_bearer_type: { id: 0x0007, type: tlv.int8 },
	dest_telematics_id: { id: 0x0008, type: tlv.int16 },
	source_addr_subunit: { id: 0x000D, type: tlv.int8 },
	source_network_type: { id: 0x000E, type: tlv.int8 },
	source_bearer_type: { id: 0x000F, type: tlv.int8 },
	source_telematics_id: { id: 0x0010, type: tlv.int16 },
	qos_time_to_live: { id: 0x0017, type: tlv.int32 },
	payload_type: { id: 0x0019, type: tlv.int8 },
	additional_status_info_text: { id: 0x001D, type: tlv.cstring },
	receipted_message_id: { id: 0x001E, type: tlv.cstring },
	ms_msg_wait_facilities: { id: 0x0030, type: tlv.int8 },
	privacy_indicator: { id: 0x0201, type: tlv.int8 },
	source_subaddress: { id: 0x0202, type: tlv.buffer },
	dest_subaddress: { id: 0x0203, type: tlv.buffer },
	user_message_reference: { id: 0x0204, type: tlv.int16 },
	user_response_code: { id: 0x0205, type: tlv.int8 },
	source_port: { id: 0x020A, type: tlv.int16 },
	dest_port: { id: 0x020B, type: tlv.int16 },
	sar_msg_ref_num: { id: 0x020C, type: tlv.int16 },
	language_indicator: { id: 0x020D, type: tlv.int8 },
	sar_total_segments: { id: 0x020E, type: tlv.int8 },
	sar_segment_seqnum: { id: 0x020F, type: tlv.int8 },
	sc_interface_version: { id: 0x0210, type: tlv.int8 },
	callback_num_pres_ind: { id: 0x0302, multiple: true, type: tlv.int8 },
	callback_num_atag: { id: 0x0303, multiple: true, type: tlv.buffer },
	number_of_messages: { id: 0x0304, type: tlv.int8 },
	callback_num: { id: 0x0381, multiple: true, type: tlv.buffer },
	dpf_result: { id: 0x0420, type: tlv.int8 },
	set_dpf: { id: 0x0421, type: tlv.int8 },
	ms_availability_status: { id: 0x0422, type: tlv.int8 },
	network_error_code: { id: 0x0423, type: tlv.buffer },
	message_payload: { id: 0x0424, type: tlv.buffer },
	delivery_failure_reason: { id: 0x0425, type: tlv.int8 },
	more_messages_to_send: { id: 0x0426, type: tlv.int8 },
	message_state: { id: 0x0427, type: tlv.int8 },
	congestion_state: { id: 0x0428, type: tlv.int8 },
	ussd_service_op: { id: 0x0501, type: tlv.int8 },
	broadcast_channel_indicator: { id: 0x0600, type: tlv.int8 },
	broadcast_content_type: { id: 0x0601, type: tlv.buffer },
	broadcast_content_type_info: { id: 0x0602, type: tlv.string },
	broadcast_message_class: { id: 0x0603, type: tlv.int8 },
	broadcast_rep_num: { id: 0x0604, type: tlv.int16 },
	broadcast_frequency_interval: { id: 0x0605, type: tlv.buffer },
	broadcast_area_identifier: { id: 0x0606, multiple: true, type: tlv.buffer },
	broadcast_error_status: { id: 0x0607, multiple: true, type: tlv.int32 },
	broadcast_area_success: { id: 0x0608, type: tlv.int8 },
	broadcast_end_time: { id: 0x0609, type: tlv.string },
	broadcast_service_group: { id: 0x060A, type: tlv.string },
	billing_identification: { id: 0x060B, type: tlv.buffer },
	source_network_id: { id: 0x060D, type: tlv.cstring },
	dest_network_id: { id: 0x060E, type: tlv.cstring },
	source_node_id: { id: 0x060F, type: tlv.string },
	dest_node_id: { id: 0x0610, type: tlv.string },
	dest_addr_np_resolution: { id: 0x0611, type: tlv.int8 },
	dest_addr_np_information: { id: 0x0612, type: tlv.string },
	dest_addr_np_country: { id: 0x0613, type: tlv.int32 },
	display_time: { id: 0x1201, type: tlv.int8 },
	sms_signal: { id: 0x1203, type: tlv.int16 },
	ms_validity: { id: 0x1204, type: tlv.buffer },
	alert_on_message_delivery: { id: 0x130C, type: tlv.int8 },
	its_reply_type: { id: 0x1380, type: tlv.int8 },
	its_session_info: { id: 0x1383, type: tlv.buffer },
} satisfies Record<string, TlvSpec>;

export type TlvName = keyof typeof specs;

export const tlvs: Record<string, TlvDefinition> = {};
export const tlvsById: Record<number, TlvDefinition> = {};

for (const [tag, spec] of Object.entries<TlvSpec>(specs)) {
	const definition: TlvDefinition = { ...spec, tag };

	tlvs[tag] = definition;
	tlvsById[spec.id] = definition;
}

// Alternate spellings that resolve to the same tag; the definition keeps its canonical name.
const aliases: Record<string, TlvName> = {
	alert_on_msg_delivery: 'alert_on_message_delivery',
	failed_broadcast_area_identifier: 'broadcast_area_identifier',
};

for (const [alias, target] of Object.entries(aliases)) {
	tlvs[alias] = { ...specs[target], tag: target };
}

/** Fallback for tags this table does not know: keep the raw octets. */
export const tlvDefault: WireType = tlv.buffer;

export type Tlv = {
	tagId: number;
	tagName: string | undefined;
	tagValue: ParamValue;
};
