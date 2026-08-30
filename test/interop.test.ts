import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import reference from 'smpp';
import type { ReferenceSession } from 'smpp';
import type { Sms } from '../src/sms.ts';
import { client } from '../src/client.ts';
import { closeAfter } from './teardown.ts';
import { concatInfo } from '../src/udh.ts';
import { objToPdu, pduToObj } from '../src/pdu.ts';
import { server } from '../src/server.ts';
import { splitMessage } from '../src/message.ts';

/**
 * Cross-checks against farhadi/node-smpp, an independent SMPP implementation. This is what backs
 * the claim that the corrected framing is right rather than differently wrong.
 */

function ourBuffer(...args: Parameters<typeof objToPdu>): Buffer {
	const { buffer, err } = objToPdu(...args);

	assert.equal(err, undefined);
	assert.ok(buffer);

	return buffer;
}

function referenceParse(buffer: Buffer) {
	const parsed = reference.PDU.fromBuffer(buffer);

	assert.ok(parsed, 'the reference implementation could not parse our PDU');

	return parsed;
}

describe('our encoder against the reference parser', () => {
	test('a GSM submit_sm', () => {
		const parsed = referenceParse(ourBuffer({
			cmdName: 'submit_sm',
			params: {
				destination_addr: '46709771337',
				short_message: 'Hello world',
				source_addr: '46701113311',
			},
			seqNr: 12,
		}));

		assert.equal(parsed.command, 'submit_sm');
		assert.equal(parsed.sequence_number, 12);
		assert.equal(parsed.source_addr, '46701113311');
		assert.equal(parsed.destination_addr, '46709771337');
		assert.equal(String(parsed.short_message?.message), 'Hello world');
	});

	test('a UCS2 submit_sm, including a character whose low byte is zero', () => {
		const parsed = referenceParse(ourBuffer({
			cmdName: 'submit_sm',
			params: {
				destination_addr: '46709771337',
				short_message: 'hej 一',
				source_addr: '46701113311',
			},
			seqNr: 3,
		}));

		assert.equal(parsed.data_coding, 8);
		assert.equal(String(parsed.short_message?.message), 'hej 一');
	});

	test('a bind_transceiver', () => {
		const parsed = referenceParse(ourBuffer({
			cmdName: 'bind_transceiver',
			params: {
				interface_version: 0x34,
				password: 'bar',
				system_id: 'foo',
				system_type: 'smpp',
			},
			seqNr: 1,
		}));

		assert.equal(parsed.command, 'bind_transceiver');
		assert.equal(parsed.system_id, 'foo');
		assert.equal(parsed.password, 'bar');
		assert.equal(parsed.interface_version, 0x34);
	});

	test('a deliver_sm carrying delivery receipt TLVs', () => {
		const parsed = referenceParse(ourBuffer({
			cmdName: 'deliver_sm',
			params: {
				destination_addr: '46701113311',
				esm_class: 4,
				short_message: 'id:abc123 sub:001 dlvrd:001 stat:DELIVRD err:000 text:',
				source_addr: '46709771337',
			},
			seqNr: 77,
			tlvs: {
				message_state: { tagId: 0x0427, tagValue: 2 },
				receipted_message_id: { tagId: 0x001E, tagValue: 'abc123' },
			},
		}));

		assert.equal(parsed.command, 'deliver_sm');
		assert.equal(parsed.message_state, 2);
		assert.equal(parsed.receipted_message_id, 'abc123');
	});

	// The segment sizes and UDH are the wire change most worth an independent opinion.
	test('every segment of a long message, with its concatenation header', () => {
		const message = 'a'.repeat(400);
		const segments = splitMessage(message, { reference: 0x2A });

		assert.equal(segments.length, 3);

		let rebuilt = '';

		for (const [index, segment] of segments.entries()) {
			const parsed = referenceParse(ourBuffer({
				cmdName: 'submit_sm',
				params: {
					data_coding: 0,
					destination_addr: '46709771337',
					esm_class: 0x40,
					short_message: segment,
					sm_length: segment.length,
					source_addr: '46701113311',
				},
				seqNr: index + 1,
			}));

			const body = String(parsed.short_message?.message);

			assert.deepEqual(concatInfo(segment), { part: index + 1, reference: 0x2A, total: 3 });
			// Both sides must agree on where the 6-octet UDH ends and the text begins.
			assert.equal(body.length, segment.length - 6);
			rebuilt += body;
		}

		assert.equal(rebuilt, message);
	});
});

describe('the reference encoder against our parser', () => {
	test('a submit_sm', () => {
		const built = new reference.PDU('submit_sm', {
			destination_addr: '46709771337',
			sequence_number: 5,
			short_message: 'Hello from the reference',
			source_addr: '46701113311',
		}).toBuffer();
		const { err, pduObj } = pduToObj(built);

		assert.equal(err, undefined);
		assert.ok(pduObj);
		assert.equal(pduObj.cmdName, 'submit_sm');
		assert.equal(pduObj.seqNr, 5);
		assert.equal(pduObj.params.source_addr, '46701113311');
		assert.equal(pduObj.params.short_message, 'Hello from the reference');
	});

	test('a UCS2 submit_sm', () => {
		const built = new reference.PDU('submit_sm', {
			destination_addr: '46709771337',
			sequence_number: 6,
			short_message: 'تست 一',
			source_addr: '46701113311',
		}).toBuffer();
		const { err, pduObj } = pduToObj(built);

		assert.equal(err, undefined);
		assert.ok(pduObj);
		assert.equal(pduObj.params.short_message, 'تست 一');
	});

	test('a submit_sm_resp', () => {
		const built = new reference.PDU('submit_sm_resp', {
			message_id: 'ref-123',
			sequence_number: 7,
		}).toBuffer();
		const { err, pduObj } = pduToObj(built);

		assert.equal(err, undefined);
		assert.ok(pduObj);
		assert.equal(pduObj.cmdName, 'submit_sm_resp');
		assert.equal(pduObj.params.message_id, 'ref-123');
	});

	test('a deliver_sm with TLVs', () => {
		const built = new reference.PDU('deliver_sm', {
			destination_addr: '46701113311',
			esm_class: 4,
			message_state: 2,
			receipted_message_id: 'ref-456',
			sequence_number: 8,
			short_message: 'id:ref-456 stat:DELIVRD err:000',
			source_addr: '46709771337',
		}).toBuffer();
		const { err, pduObj } = pduToObj(built);

		assert.equal(err, undefined);
		assert.ok(pduObj);
		assert.equal(pduObj.tlvs.receipted_message_id?.tagValue, 'ref-456');
		assert.equal(pduObj.tlvs.message_state?.tagValue, 2);
	});
});

describe('a live session against the reference implementation', () => {
	test('our client binds to a reference server and delivers an SMS', async t => {
		const received: { from: string; message: string }[] = [];
		const refServer = reference.createServer({}, (session: ReferenceSession) => {
			session.on('bind_transceiver', pdu => {
				session.bind_transceiver_resp({
					sequence_number: pdu.sequence_number,
					system_id: 'ref',
				});
			});

			session.on('submit_sm', pdu => {
				received.push({
					from: String(pdu.source_addr),
					message: String(pdu.short_message?.message),
				});
				session.submit_sm_resp({
					message_id: 'ref-id',
					sequence_number: pdu.sequence_number,
				});
			});
		});

		t.after(() => new Promise<void>(resolve => { refServer.close(() => { resolve(); }); }));
		await new Promise<void>(resolve => { refServer.listen(0, () => { resolve(); }); });

		const port = refServer.address()?.port ?? 0;
		const { err, session } = await client({ port });

		assert.equal(err, undefined);
		assert.ok(session);
		closeAfter(t, session);

		const sent = await session.sendSms({
			from: 'MyBrand',
			message: 'interop check',
			to: '46709771337',
		});

		assert.equal(sent.err, undefined);
		assert.deepEqual(sent.smsIds, ['ref-id']);
		assert.deepEqual(received, [{ from: 'MyBrand', message: 'interop check' }]);
	});

	test('a reference client binds to our server and delivers an SMS', async t => {
		const { err: serverErr, server: smpp } = await server({ port: 0 });

		assert.equal(serverErr, undefined);
		assert.ok(smpp);
		closeAfter(t, smpp);

		const incoming = new Promise<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});

		const refSession = reference.connect({
			url: `smpp://localhost:${String(smpp.port)}`,
		});

		t.after(() => { refSession.close(); });

		await new Promise<void>(resolve => {
			refSession.bind_transceiver({ password: 'bar', system_id: 'foo' }, () => { resolve(); });
		});

		refSession.submit_sm({
			destination_addr: '46709771337',
			short_message: 'from the reference client',
			source_addr: '46701113311',
		});

		const sms = await incoming;

		assert.equal(sms.from, '46701113311');
		assert.equal(sms.message, 'from the reference client');
		await sms.sendResp();
	});
});
