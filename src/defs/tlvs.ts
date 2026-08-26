import type { ParamValue, WireType } from './types.ts';
import { tlv } from './types.ts';

export type TlvDefinition = {
	id: number;
	multiple?: boolean;
	tag: string;
	type: WireType;
};

/** The constraint keys every definition to its own name, so a `tag` that drifts fails to compile. */
const tlvSpecs = <T extends { [K in keyof T]: { id: number; multiple?: boolean; tag: K; type: WireType } }>(
	definitions: T,
): T => definitions;

// Ordered by tag id, mirroring the SMPP 5.0 TLV table.
const specs = tlvSpecs({
	dest_addr_subunit: { id: 0x0005, tag: 'dest_addr_subunit', type: tlv.int8 },
	dest_network_type: { id: 0x0006, tag: 'dest_network_type', type: tlv.int8 },
	dest_bearer_type: { id: 0x0007, tag: 'dest_bearer_type', type: tlv.int8 },
	dest_telematics_id: { id: 0x0008, tag: 'dest_telematics_id', type: tlv.int16 },
	source_addr_subunit: { id: 0x000D, tag: 'source_addr_subunit', type: tlv.int8 },
	source_network_type: { id: 0x000E, tag: 'source_network_type', type: tlv.int8 },
	source_bearer_type: { id: 0x000F, tag: 'source_bearer_type', type: tlv.int8 },
	source_telematics_id: { id: 0x0010, tag: 'source_telematics_id', type: tlv.int16 },
	qos_time_to_live: { id: 0x0017, tag: 'qos_time_to_live', type: tlv.int32 },
	payload_type: { id: 0x0019, tag: 'payload_type', type: tlv.int8 },
	additional_status_info_text: { id: 0x001D, tag: 'additional_status_info_text', type: tlv.cstring },
	receipted_message_id: { id: 0x001E, tag: 'receipted_message_id', type: tlv.cstring },
	ms_msg_wait_facilities: { id: 0x0030, tag: 'ms_msg_wait_facilities', type: tlv.int8 },
	privacy_indicator: { id: 0x0201, tag: 'privacy_indicator', type: tlv.int8 },
	source_subaddress: { id: 0x0202, tag: 'source_subaddress', type: tlv.buffer },
	dest_subaddress: { id: 0x0203, tag: 'dest_subaddress', type: tlv.buffer },
	user_message_reference: { id: 0x0204, tag: 'user_message_reference', type: tlv.int16 },
	user_response_code: { id: 0x0205, tag: 'user_response_code', type: tlv.int8 },
	source_port: { id: 0x020A, tag: 'source_port', type: tlv.int16 },
	dest_port: { id: 0x020B, tag: 'dest_port', type: tlv.int16 },
	sar_msg_ref_num: { id: 0x020C, tag: 'sar_msg_ref_num', type: tlv.int16 },
	language_indicator: { id: 0x020D, tag: 'language_indicator', type: tlv.int8 },
	sar_total_segments: { id: 0x020E, tag: 'sar_total_segments', type: tlv.int8 },
	sar_segment_seqnum: { id: 0x020F, tag: 'sar_segment_seqnum', type: tlv.int8 },
	sc_interface_version: { id: 0x0210, tag: 'sc_interface_version', type: tlv.int8 },
	callback_num_pres_ind: { id: 0x0302, multiple: true, tag: 'callback_num_pres_ind', type: tlv.int8 },
	callback_num_atag: { id: 0x0303, multiple: true, tag: 'callback_num_atag', type: tlv.buffer },
	number_of_messages: { id: 0x0304, tag: 'number_of_messages', type: tlv.int8 },
	callback_num: { id: 0x0381, multiple: true, tag: 'callback_num', type: tlv.buffer },
	dpf_result: { id: 0x0420, tag: 'dpf_result', type: tlv.int8 },
	set_dpf: { id: 0x0421, tag: 'set_dpf', type: tlv.int8 },
	ms_availability_status: { id: 0x0422, tag: 'ms_availability_status', type: tlv.int8 },
	network_error_code: { id: 0x0423, tag: 'network_error_code', type: tlv.buffer },
	message_payload: { id: 0x0424, tag: 'message_payload', type: tlv.buffer },
	delivery_failure_reason: { id: 0x0425, tag: 'delivery_failure_reason', type: tlv.int8 },
	more_messages_to_send: { id: 0x0426, tag: 'more_messages_to_send', type: tlv.int8 },
	message_state: { id: 0x0427, tag: 'message_state', type: tlv.int8 },
	congestion_state: { id: 0x0428, tag: 'congestion_state', type: tlv.int8 },
	ussd_service_op: { id: 0x0501, tag: 'ussd_service_op', type: tlv.int8 },
	broadcast_channel_indicator: { id: 0x0600, tag: 'broadcast_channel_indicator', type: tlv.int8 },
	broadcast_content_type: { id: 0x0601, tag: 'broadcast_content_type', type: tlv.buffer },
	broadcast_content_type_info: { id: 0x0602, tag: 'broadcast_content_type_info', type: tlv.string },
	broadcast_message_class: { id: 0x0603, tag: 'broadcast_message_class', type: tlv.int8 },
	broadcast_rep_num: { id: 0x0604, tag: 'broadcast_rep_num', type: tlv.int16 },
	broadcast_frequency_interval: { id: 0x0605, tag: 'broadcast_frequency_interval', type: tlv.buffer },
	broadcast_area_identifier: { id: 0x0606, multiple: true, tag: 'broadcast_area_identifier', type: tlv.buffer },
	broadcast_error_status: { id: 0x0607, multiple: true, tag: 'broadcast_error_status', type: tlv.int32 },
	broadcast_area_success: { id: 0x0608, tag: 'broadcast_area_success', type: tlv.int8 },
	broadcast_end_time: { id: 0x0609, tag: 'broadcast_end_time', type: tlv.string },
	broadcast_service_group: { id: 0x060A, tag: 'broadcast_service_group', type: tlv.string },
	billing_identification: { id: 0x060B, tag: 'billing_identification', type: tlv.buffer },
	source_network_id: { id: 0x060D, tag: 'source_network_id', type: tlv.cstring },
	dest_network_id: { id: 0x060E, tag: 'dest_network_id', type: tlv.cstring },
	source_node_id: { id: 0x060F, tag: 'source_node_id', type: tlv.string },
	dest_node_id: { id: 0x0610, tag: 'dest_node_id', type: tlv.string },
	dest_addr_np_resolution: { id: 0x0611, tag: 'dest_addr_np_resolution', type: tlv.int8 },
	dest_addr_np_information: { id: 0x0612, tag: 'dest_addr_np_information', type: tlv.string },
	dest_addr_np_country: { id: 0x0613, tag: 'dest_addr_np_country', type: tlv.int32 },
	display_time: { id: 0x1201, tag: 'display_time', type: tlv.int8 },
	sms_signal: { id: 0x1203, tag: 'sms_signal', type: tlv.int16 },
	ms_validity: { id: 0x1204, tag: 'ms_validity', type: tlv.buffer },
	alert_on_message_delivery: { id: 0x130C, tag: 'alert_on_message_delivery', type: tlv.int8 },
	its_reply_type: { id: 0x1380, tag: 'its_reply_type', type: tlv.int8 },
	its_session_info: { id: 0x1383, tag: 'its_session_info', type: tlv.buffer },
});

export type TlvName = keyof typeof specs;

export const tlvs: Record<TlvName, TlvDefinition> & Record<string, TlvDefinition> = {
	...specs,
	// Alternate spellings; the definition behind each keeps its canonical name.
	alert_on_msg_delivery: specs.alert_on_message_delivery,
	failed_broadcast_area_identifier: specs.broadcast_area_identifier,
};

export const tlvsById: Record<number, TlvDefinition> = {};

for (const definition of Object.values<TlvDefinition>(specs)) {
	tlvsById[definition.id] = definition;
}

/** Fallback for tags this table does not know: keep the raw octets. */
export const tlvDefault: WireType = tlv.buffer;

export type Tlv = {
	tagId: number;
	tagName: string | undefined;
	tagValue: ParamValue;
};
