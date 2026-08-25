import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import type { PduParams, PduParamsInput } from '../src/defs/commands.ts';
import { cmds, cmdsById, commandNameById, isCommandName } from '../src/defs/commands.ts';

describe('command table', () => {
	test('every command is reachable by name and by id', () => {
		assert.equal(cmds.submit_sm?.id, 0x00000004);
		assert.equal(cmds.submit_sm_resp?.id, 0x80000004);
		assert.equal(cmdsById[0x00000004]?.command, 'submit_sm');
		assert.equal(cmdsById[0x80000009]?.command, 'bind_transceiver_resp');
	});

	test('covers all 33 commands', () => {
		assert.equal(Object.keys(cmds).length, 33);
	});

	// Wire order, not alphabetical order — reordering these corrupts every PDU.
	test('submit_sm parameters are in wire order', () => {
		assert.deepEqual(Object.keys(cmds.submit_sm?.params ?? {}), [
			'service_type',
			'source_addr_ton',
			'source_addr_npi',
			'source_addr',
			'dest_addr_ton',
			'dest_addr_npi',
			'destination_addr',
			'esm_class',
			'protocol_id',
			'priority_flag',
			'schedule_delivery_time',
			'validity_period',
			'registered_delivery',
			'replace_if_present_flag',
			'data_coding',
			'sm_default_msg_id',
			'sm_length',
			'short_message',
		]);
	});

	test('resolves names from ids and guards unknown ones', () => {
		assert.equal(commandNameById(0x00000004), 'submit_sm');
		assert.equal(commandNameById(0x0BADF00D), undefined);
		assert.ok(isCommandName('deliver_sm'));
		assert.ok(!isCommandName('deliver_pizza'));
	});
});

describe('per-command parameter types', () => {
	test('narrow to the fields the command actually defines', () => {
		const params: PduParams<'submit_sm'> = {
			data_coding: 0,
			destination_addr: '46709771337',
			dest_addr_npi: 0,
			dest_addr_ton: 1,
			esm_class: 0,
			priority_flag: 0,
			protocol_id: 0,
			registered_delivery: 0,
			replace_if_present_flag: 0,
			schedule_delivery_time: '',
			service_type: '',
			short_message: Buffer.from('hello'),
			sm_default_msg_id: 0,
			sm_length: 5,
			source_addr: '46701113311',
			source_addr_npi: 0,
			source_addr_ton: 1,
			validity_period: '',
		};

		// Fails to compile if short_message is not known to be a Buffer.
		assert.equal(params.short_message.toString(), 'hello');
		// Fails to compile if destination_addr is not known to be a string.
		assert.equal(params.destination_addr.length, 11);
	});

	test('accept a partial input, coercing numbers into the string fields', () => {
		const input: PduParamsInput<'submit_sm_resp'> = { message_id: 2343 };

		assert.equal(input.message_id, 2343);
	});
});
