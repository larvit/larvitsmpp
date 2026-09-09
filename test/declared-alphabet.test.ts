import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { bindToSmsc, dummySmsc } from './dummy-smsc.ts';
import { client } from '../src/client.ts';
import { closeAfter } from './teardown.ts';
import { consts } from '../src/defs/constants.ts';
import { decodeMessage } from '../src/message.ts';
import { dlrFromPdu } from '../src/dlr.ts';
import { encodingByDataCoding, encodings } from '../src/defs/encodings.ts';
import { objToPdu, pduToObj } from '../src/pdu.ts';
import { paramNumber } from '../src/defs/types.ts';
import { server } from '../src/server.ts';
import type { PduObject } from '../src/pdu.ts';

const from = '46701113311';
const to = '46709771337';

/** GSM 03.38 puts $ at 0x02 and @ at 0x00, where IA5 has STX and NUL. */
const bothTables = 'Cost 5$ @home';

/** What SMPP 3.4 5.2.19 assigns each coding, read the way a peer honouring the field reads it. */
const byTheSpecsTable: Record<number, (octets: Buffer) => string> = {
	// The SMSC default alphabet, which every peer in interop-tests/ runs as GSM 03.38.
	0x00: octets => encodings.ASCII.decode(octets),
	// IA5 (CCITT T.50), whose whole range is what Latin-1 reads below 0x80.
	[consts.ENCODING.IA5]: octets => octets.toString('latin1'),
};

function submitted(octets: Buffer[]): PduObject[] {
	return octets.map(pdu => {
		const { pduObj } = pduToObj(pdu);

		assert.ok(pduObj);

		return pduObj;
	});
}

function declaredBy(pduObj: PduObject): number {
	return paramNumber(pduObj.params.data_coding, 0);
}

/** A deliver_sm carrying `body` under `dataCoding`, as a peer answering our own send would write it. */
function delivered(body: Buffer | string, dataCoding: number, esmClass: number): PduObject {
	const { buffer } = objToPdu({
		cmdName: 'deliver_sm',
		params: {
			data_coding: dataCoding,
			destination_addr: from,
			esm_class: esmClass,
			short_message: body,
			source_addr: to,
		},
		seqNr: 1,
	});

	assert.ok(buffer);

	const { pduObj } = pduToObj(buffer);

	assert.ok(pduObj);

	return pduObj;
}

describe('the alphabet a message declares is the one its octets are written in', () => {
	// data_coding 0x01 is SMPP 3.4 5.2.19's IA5, and the codec writes GSM 03.38.
	test('sends GSM 03.38 under data_coding 0x00, the SMSC default alphabet', async t => {
		const smsc = await dummySmsc(t, { messageIds: ['01a08779-de97-7caa-9d26-e6d50f5c4888'] });
		const session = await bindToSmsc(t, smsc.port, { reconnect: false });
		const sent = await session.sendSms({ from, message: bothTables, to });

		assert.equal(sent.err, undefined);
		assert.deepEqual(submitted(smsc.octets).map(declaredBy), [0x00]);
	});

	test('keeps $ and @ for a peer that honours the declaration, where IA5 read STX and NUL', async t => {
		const smsc = await dummySmsc(t, { messageIds: ['01a08779-de98-7d24-9542-e652e0d3761c'] });
		const session = await bindToSmsc(t, smsc.port, { reconnect: false });

		assert.equal((await session.sendSms({ from, message: bothTables, to })).err, undefined);

		const [pduObj] = submitted(smsc.octets);

		assert.ok(pduObj);

		const octets = pduObj.shortMessageOctets;

		assert.ok(octets);
		assert.equal(octets.toString('hex'), '436f73742035022000686f6d65');

		const read = byTheSpecsTable[declaredBy(pduObj)];

		assert.ok(read, 'the coding declared must be one SMPP 3.4 5.2.19 names an alphabet for');
		assert.equal(read(octets), bothTables);
	});

	test('leaves Latin-1 at 0x03 and UCS2 at 0x08, the codings those alphabets always had', async t => {
		const smsc = await dummySmsc(t, {
			messageIds: ['01a08779-de99-7fa5-bcac-18feef55aeee', '01a08779-de99-72ec-8dbb-9365a00158c3'],
		});
		const session = await bindToSmsc(t, smsc.port, { reconnect: false });

		assert.equal((await session.sendSms({ encoding: 'LATIN1', from, message: 'Räksmörgås', to })).err, undefined);
		assert.equal((await session.sendSms({ from, message: 'あいう', to })).err, undefined);
		assert.deepEqual(submitted(smsc.octets).map(declaredBy), [0x03, 0x08]);
	});

	// sendDlr() writes its body as a string with no data_coding, so it takes the detected branch too.
	test('declares 0x00 on a receipt it writes itself', async t => {
		const { err, server: smpp } = await server({ port: 0 });

		assert.equal(err, undefined);
		assert.ok(smpp);
		closeAfter(t, smpp);

		smpp.on('session', peer => peer.on('sms', async sms => {
			await sms.sendResp();
			await sms.sendDlr('DELIVERED');
		}));

		const connected = await client({ port: smpp.port, reconnect: false });

		assert.equal(connected.err, undefined);
		assert.ok(connected.session);
		closeAfter(t, connected.session);

		const session = connected.session;
		const reported = new Promise<PduObject>(resolve => {
			session.on('dlr', (_report, pduObj) => { resolve(pduObj); });
		});

		assert.equal((await session.sendSms({ dlr: true, from, message: bothTables, to })).err, undefined);
		assert.equal(declaredBy(await reported), 0x00);
	});

	// The low-level surface settles data_coding off the same detection, so it carried the same defect.
	test('settles a detected string body at 0x00 where the caller named no data_coding', () => {
		const built = objToPdu({
			cmdName: 'submit_sm',
			params: { destination_addr: to, short_message: bothTables, source_addr: from },
		});

		assert.ok(built.buffer);

		const { pduObj } = pduToObj(built.buffer);

		assert.ok(pduObj);
		assert.equal(declaredBy(pduObj), 0x00);
		assert.equal(pduObj.shortMessageOctets?.toString('hex'), '436f73742035022000686f6d65');
	});
});

describe('what a peer declares is read as generously as it was before', () => {
	// LINK Mobility, Route Mobile and Telesign all document 0x01 as GSM 03.38; the two that mention
	// IA5 at all call the value known to cause problems, so no researched peer means it literally.
	test('reads data_coding 0x01 as GSM 03.38, as 0x00 is read', () => {
		assert.equal(encodingByDataCoding(0x01), 'ASCII');

		const octets = Buffer.from('436f73742035022000686f6d65', 'hex');

		for (const dataCoding of [0x00, 0x01]) {
			assert.equal(decodeMessage(octets, dataCoding).message, bothTables, String(dataCoding));
		}
	});

	test('leaves a receipt and an inbound message reading the same under either coding', () => {
		const receiptId = '01a08779-de97-7caa-9d26-e6d50f5c4888';
		const body = `id:${receiptId} sub:001 dlvrd:001 submit date:2509091430 done date:2509091431 stat:DELIVRD err:000 text:${bothTables}`;

		for (const dataCoding of [0x00, 0x01]) {
			const receipt = dlrFromPdu(delivered(body, dataCoding, consts.ESM_CLASS.MC_DELIVERY_RECEIPT));

			assert.ok(receipt, String(dataCoding));
			assert.equal(receipt.smsId, receiptId, String(dataCoding));
			assert.equal(receipt.statusMsg, 'DELIVERED', String(dataCoding));

			const inbound = delivered(Buffer.from('436f73742035022000686f6d65', 'hex'), dataCoding, 0);

			assert.equal(dlrFromPdu(inbound), undefined, String(dataCoding));
			assert.equal(inbound.params.short_message, bothTables, String(dataCoding));
		}
	});
});
