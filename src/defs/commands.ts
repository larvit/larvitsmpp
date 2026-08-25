import type { ParamValue, WireType } from './types.ts';
import { buffer, cstring, dest_address_array, int8, unsuccess_sme_array } from './types.ts';

type CommandSpec = {
	defaults?: Record<string, ParamValue>;
	id: number;
	params?: Record<string, WireType>;
	tlvMap?: Record<string, string>;
};

const bindParams = {
	system_id: cstring,
	password: cstring,
	system_type: cstring,
	interface_version: int8,
	addr_ton: int8,
	addr_npi: int8,
	address_range: cstring,
} as const;

/**
 * Key order inside each `params` object is the order the fields appear on the wire. Reordering
 * them corrupts every PDU of that command.
 */
const specs = {
	alert_notification: {
		id: 0x00000102,
		params: {
			source_addr_ton: int8,
			source_addr_npi: int8,
			source_addr: cstring,
			esme_addr_ton: int8,
			esme_addr_npi: int8,
			esme_addr: cstring,
		},
	},
	bind_receiver: { defaults: { interface_version: 0x50 }, id: 0x00000001, params: bindParams },
	bind_receiver_resp: { id: 0x80000001, params: { system_id: cstring } },
	bind_transmitter: { defaults: { interface_version: 0x50 }, id: 0x00000002, params: bindParams },
	bind_transmitter_resp: { id: 0x80000002, params: { system_id: cstring } },
	bind_transceiver: { defaults: { interface_version: 0x50 }, id: 0x00000009, params: bindParams },
	bind_transceiver_resp: { id: 0x80000009, params: { system_id: cstring } },
	broadcast_sm: {
		id: 0x00000111,
		params: {
			service_type: cstring,
			source_addr_ton: int8,
			source_addr_npi: int8,
			source_addr: cstring,
			message_id: cstring,
			priority_flag: int8,
			schedule_delivery_time: cstring,
			validity_period: cstring,
			replace_if_present_flag: int8,
			data_coding: int8,
			sm_default_msg_id: int8,
		},
	},
	broadcast_sm_resp: {
		id: 0x80000111,
		params: { message_id: cstring },
		tlvMap: { broadcast_area_identifier: 'failed_broadcast_area_identifier' },
	},
	cancel_broadcast_sm: {
		id: 0x00000113,
		params: {
			service_type: cstring,
			message_id: cstring,
			source_addr_ton: int8,
			source_addr_npi: int8,
			source_addr: cstring,
		},
	},
	cancel_broadcast_sm_resp: { id: 0x80000113 },
	cancel_sm: {
		id: 0x00000008,
		params: {
			service_type: cstring,
			message_id: cstring,
			source_addr_ton: int8,
			source_addr_npi: int8,
			source_addr: cstring,
			dest_addr_ton: int8,
			dest_addr_npi: int8,
			destination_addr: cstring,
		},
	},
	cancel_sm_resp: { id: 0x80000008 },
	data_sm: {
		id: 0x00000103,
		params: {
			service_type: cstring,
			source_addr_ton: int8,
			source_addr_npi: int8,
			source_addr: cstring,
			dest_addr_ton: int8,
			dest_addr_npi: int8,
			destination_addr: cstring,
			esm_class: int8,
			registered_delivery: int8,
			data_coding: int8,
		},
	},
	data_sm_resp: { id: 0x80000103, params: { message_id: cstring } },
	deliver_sm: {
		id: 0x00000005,
		params: {
			service_type: cstring,
			source_addr_ton: int8,
			source_addr_npi: int8,
			source_addr: cstring,
			dest_addr_ton: int8,
			dest_addr_npi: int8,
			destination_addr: cstring,
			esm_class: int8,
			protocol_id: int8,
			priority_flag: int8,
			schedule_delivery_time: cstring,
			validity_period: cstring,
			registered_delivery: int8,
			replace_if_present_flag: int8,
			data_coding: int8,
			sm_default_msg_id: int8,
			sm_length: int8,
			short_message: buffer,
		},
	},
	deliver_sm_resp: { id: 0x80000005, params: { message_id: cstring } },
	enquire_link: { id: 0x00000015 },
	enquire_link_resp: { id: 0x80000015 },
	generic_nack: { id: 0x80000000 },
	outbind: { id: 0x0000000B, params: { system_id: cstring, password: cstring } },
	query_broadcast_sm: {
		id: 0x00000112,
		params: {
			message_id: cstring,
			source_addr_ton: int8,
			source_addr_npi: int8,
			source_addr: cstring,
		},
	},
	query_broadcast_sm_resp: { id: 0x80000112, params: { message_id: cstring } },
	query_sm: {
		id: 0x00000003,
		params: {
			message_id: cstring,
			source_addr_ton: int8,
			source_addr_npi: int8,
			source_addr: cstring,
		},
	},
	query_sm_resp: {
		id: 0x80000003,
		params: {
			message_id: cstring,
			final_date: cstring,
			message_state: int8,
			error_code: int8,
		},
	},
	replace_sm: {
		id: 0x00000007,
		params: {
			message_id: cstring,
			source_addr_ton: int8,
			source_addr_npi: int8,
			source_addr: cstring,
			schedule_delivery_time: cstring,
			validity_period: cstring,
			registered_delivery: int8,
			sm_default_msg_id: int8,
			sm_length: int8,
			short_message: buffer,
		},
	},
	replace_sm_resp: { id: 0x80000007 },
	submit_multi: {
		id: 0x00000021,
		params: {
			service_type: cstring,
			source_addr_ton: int8,
			source_addr_npi: int8,
			source_addr: cstring,
			dest_address: dest_address_array,
			esm_class: int8,
			protocol_id: int8,
			priority_flag: int8,
			schedule_delivery_time: cstring,
			validity_period: cstring,
			registered_delivery: int8,
			replace_if_present_flag: int8,
			data_coding: int8,
			sm_default_msg_id: int8,
			short_message: buffer,
		},
	},
	submit_multi_resp: {
		id: 0x80000021,
		params: { message_id: cstring, unsuccess_sme: unsuccess_sme_array },
	},
	submit_sm: {
		id: 0x00000004,
		params: {
			service_type: cstring,
			source_addr_ton: int8,
			source_addr_npi: int8,
			source_addr: cstring,
			dest_addr_ton: int8,
			dest_addr_npi: int8,
			destination_addr: cstring,
			esm_class: int8,
			protocol_id: int8,
			priority_flag: int8,
			schedule_delivery_time: cstring,
			validity_period: cstring,
			registered_delivery: int8,
			replace_if_present_flag: int8,
			data_coding: int8,
			sm_default_msg_id: int8,
			sm_length: int8,
			short_message: buffer,
		},
	},
	submit_sm_resp: { id: 0x80000004, params: { message_id: cstring } },
	unbind: { id: 0x00000006 },
	unbind_resp: { id: 0x80000006 },
} satisfies Record<string, CommandSpec>;

export type CommandName = keyof typeof specs;

type ParamsSpecOf<C extends CommandName> = (typeof specs)[C] extends { params: infer P } ? P : Record<never, never>;

/** Parameters as they come off the wire: every field the command defines, always present. */
export type PduParams<C extends CommandName = CommandName> = {
	[K in keyof ParamsSpecOf<C>]: ParamsSpecOf<C>[K] extends WireType<infer V> ? V : never;
};

/** Parameters callers supply: all optional, and numbers are accepted for the string fields. */
export type PduParamsInput<C extends CommandName = CommandName> = {
	[K in keyof ParamsSpecOf<C>]?: ParamsSpecOf<C>[K] extends WireType<infer V>
		? V extends string ? number | string : V
		: never;
};

export type CommandDefinition = CommandSpec & { command: string };

export const cmds: Record<string, CommandDefinition> = {};
export const cmdsById: Record<number, CommandDefinition> = {};

for (const [command, spec] of Object.entries<CommandSpec>(specs)) {
	const definition: CommandDefinition = { ...spec, command };

	cmds[command] = definition;
	cmdsById[spec.id] = definition;
}

export function isCommandName(value: unknown): value is CommandName {
	return typeof value === 'string' && Object.hasOwn(specs, value);
}

export function commandNameById(id: number): CommandName | undefined {
	const command = cmdsById[id]?.command;

	return isCommandName(command) ? command : undefined;
}
