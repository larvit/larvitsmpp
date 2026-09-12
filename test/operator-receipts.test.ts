import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import type { Dlr, Receipt } from '../src/dlr.ts';
import type { MessageDlr } from '../src/session.ts';
import type { PduObject, TlvInput } from '../src/pdu.ts';
import { bindToSmsc, dummySmsc } from './dummy-smsc.ts';
import { consts } from '../src/defs/constants.ts';
import { dlrFromPdu, parseReceipt, receiptCodes, transientStates } from '../src/dlr.ts';
import { objToPdu, pduToObj } from '../src/pdu.ts';

/**
 * Receipt bodies as commercial operators document them, from `interop-tests/research/operator-quirks.md`
 * topics 4 and 5. Every peer the interop suite can run is open source; these shapes are the ones only
 * an operator writes, so each fixture carries the URL it was read from.
 */

function deliverSm(
	body: string,
	tlvs?: Record<string, TlvInput>,
	esmClass: number = consts.ESM_CLASS.MC_DELIVERY_RECEIPT,
): PduObject {
	const { buffer } = objToPdu({
		cmdName: 'deliver_sm',
		params: {
			destination_addr: '46701113311',
			esm_class: esmClass,
			short_message: body,
			source_addr: '46709771337',
		},
		seqNr: 1,
		tlvs,
	});

	assert.ok(buffer);

	const { pduObj } = pduToObj(buffer);

	assert.ok(pduObj);

	return pduObj;
}

type ReceiptFixture = {
	body: string;
	dlr: {
		doneDate: string | undefined;
		errorCode: string | undefined;
		intermediate: boolean;
		smsId: string | undefined;
		statusId: number;
		statusMsg: Dlr['statusMsg'];
	};
	name: string;
	receipt: Receipt;
	source: string;
	tlvs?: Record<string, TlvInput>;
};

const fixtures: readonly ReceiptFixture[] = [
	{
		body: 'id:e731049e9fc84e61 sub:000 dlvrd:000 submit date:2609051430 done date:2609051431 stat:DELIVRD err:000 text:',
		dlr: {
			doneDate: '2026-09-05T14:31:00.000Z',
			errorCode: '000',
			intermediate: false,
			smsId: 'e731049e9fc84e61',
			statusId: consts.MESSAGE_STATE.DELIVERED,
			statusMsg: 'DELIVERED',
		},
		name: 'LINK Mobility, whose sub and dlvrd are always 000 and whose text is always empty',
		receipt: {
			dlvrd: 0,
			doneDate: '2609051431',
			err: '000',
			id: 'e731049e9fc84e61',
			stat: 'DELIVRD',
			sub: 0,
			submitDate: '2609051430',
			text: '',
		},
		source: 'https://www.linkmobility.com/resources/developer/SMSC-SMPP-User-Guide-1.5.pdf',
	},
	{
		body: 'id:2a1f0f1d sub:001 dlvrd:000 submit date:2609051430 done date:2609051447 stat:FAILED err:051 text:none',
		dlr: {
			doneDate: '2026-09-05T14:47:00.000Z',
			errorCode: '051',
			intermediate: false,
			smsId: '2a1f0f1d',
			statusId: consts.MESSAGE_STATE.UNDELIVERABLE,
			statusMsg: 'UNDELIVERABLE',
		},
		name: 'Vonage, whose stat:FAILED is six characters and outside Appendix B',
		receipt: {
			dlvrd: 0,
			doneDate: '2609051447',
			err: '051',
			id: '2a1f0f1d',
			stat: 'FAILED',
			sub: 1,
			submitDate: '2609051430',
			text: 'none',
		},
		source: 'https://api.support.vonage.com/hc/en-us/articles/204015663',
	},
	{
		body: 'id:44191696 sub:001 dlvrd:000 submit date:2609051430 done date:2609051430 stat:ENROUTE err:000',
		dlr: {
			doneDate: '2026-09-05T14:30:00.000Z',
			errorCode: '000',
			intermediate: true,
			smsId: '44191696',
			statusId: consts.MESSAGE_STATE.ENROUTE,
			statusMsg: 'ENROUTE',
		},
		name: 'Infobip, reporting ENROUTE in an ordinary receipt that carries no text field at all',
		receipt: {
			dlvrd: 0,
			doneDate: '2609051430',
			err: '000',
			id: '44191696',
			stat: 'ENROUTE',
			sub: 1,
			submitDate: '2609051430',
			text: undefined,
		},
		source: 'https://www.infobip.com/docs/essentials/api-essentials/smpp-specification',
	},
	{
		body: 'id:7d94e772 sub:001 dlvrd:001 submit date:260905143012 done date:260905143145 stat:DELIVRD err:000 text:',
		dlr: {
			doneDate: '2026-09-05T14:31:45.000Z',
			errorCode: '000',
			intermediate: false,
			smsId: '7d94e772',
			statusId: consts.MESSAGE_STATE.DELIVERED,
			statusMsg: 'DELIVERED',
		},
		name: 'Clickatell, whose dates carry seconds',
		receipt: {
			dlvrd: 1,
			doneDate: '260905143145',
			err: '000',
			id: '7d94e772',
			stat: 'DELIVRD',
			sub: 1,
			submitDate: '260905143012',
			text: '',
		},
		source: 'https://archive.clickatell.com/developers/api-docs/pdu-details/',
	},
	{
		body: 'id:5be9f816f19992a78c8e26442f8afa50 submit date:20260905143012 done date:20260905143345 stat:DELIVERD err:000',
		dlr: {
			doneDate: '2026-09-05T14:33:45.000Z',
			errorCode: '000',
			intermediate: false,
			smsId: '5be9f816f19992a78c8e26442f8afa50',
			statusId: consts.MESSAGE_STATE.DELIVERED,
			statusMsg: 'DELIVERED',
		},
		name: 'CM.com, which writes a four-digit year, an eight-character stat, and the status twice',
		receipt: {
			dlvrd: undefined,
			doneDate: '20260905143345',
			err: '000',
			id: '5be9f816f19992a78c8e26442f8afa50',
			stat: 'DELIVERD',
			sub: undefined,
			submitDate: '20260905143012',
			text: undefined,
		},
		source: 'https://developers.cm.com/messaging/docs/smpp',
		tlvs: { message_state: { tagValue: consts.MESSAGE_STATE.DELIVERED } },
	},
	{
		body: 'id:e9ca671b2497d778d771938333dc0c52 sub:001 dlvrd:000 submit date:260905143000 done date:260905143010 stat:UNDELIV err:4A6 text:',
		dlr: {
			doneDate: '2026-09-05T14:30:10.000Z',
			errorCode: '4A6',
			intermediate: false,
			smsId: 'e9ca671b2497d778d771938333dc0c52',
			statusId: consts.MESSAGE_STATE.UNDELIVERABLE,
			statusMsg: 'UNDELIVERABLE',
		},
		name: 'Telesign, whose err is hexadecimal and whose status is stated in the body and the TLVs alike',
		receipt: {
			dlvrd: 0,
			doneDate: '260905143010',
			err: '4A6',
			id: 'e9ca671b2497d778d771938333dc0c52',
			stat: 'UNDELIV',
			sub: 1,
			submitDate: '260905143000',
			text: '',
		},
		source: 'https://developer.telesign.com/enterprise/docs/smpp-protocol',
		tlvs: {
			message_state: { tagValue: consts.MESSAGE_STATE.UNDELIVERABLE },
			receipted_message_id: { tagValue: 'e9ca671b2497d778d771938333dc0c52' },
		},
	},
];

describe('receipt bodies operators document', () => {
	for (const fixture of fixtures) {
		test(fixture.name, () => {
			const dlr = dlrFromPdu(deliverSm(fixture.body, fixture.tlvs));

			assert.ok(dlr, fixture.source);
			assert.deepEqual(dlr.receipt, fixture.receipt, fixture.source);
			assert.deepEqual({
				doneDate: dlr.doneDate?.toISOString(),
				errorCode: dlr.errorCode,
				intermediate: dlr.intermediate,
				smsId: dlr.smsId,
				statusId: dlr.statusId,
				statusMsg: dlr.statusMsg,
			}, fixture.dlr, fixture.source);
		});
	}
});

/** Every `stat:` code the researched operators list, per operator, with the page it is on. */
const documentedCodes: readonly { codes: readonly string[]; operator: string; source: string }[] = [
	{
		codes: ['ACCEPTD', 'DELIVRD', 'REJECTD', 'UNDELIV'],
		operator: 'Clickatell',
		source: 'https://archive.clickatell.com/developers/api-docs/pdu-details/',
	},
	{
		codes: ['ACCEPTD', 'DELETED', 'DELIVERD', 'EXPIRED', 'REJECTD', 'UNDELIV', 'UNKNOWN'],
		operator: 'CM.com',
		source: 'https://developers.cm.com/messaging/docs/smpp',
	},
	{
		codes: ['ACCEPTD', 'DELIVRD', 'ENROUTE', 'EXPIRED', 'REJECTD', 'UNDELIV', 'UNKNOWN'],
		operator: 'Infobip',
		source: 'https://www.infobip.com/docs/essentials/api-essentials/smpp-specification',
	},
	{
		codes: ['DELIVRD', 'EXPIRED', 'FAILED', 'UNDELIV'],
		operator: 'Kaleyra',
		source: 'https://messaging.kaleyra.com/support/solutions/articles/3000091798-delivery-reports',
	},
	{
		codes: ['DELETED', 'DELIVRD', 'EXPIRED', 'REJECTD', 'UNDELIV'],
		operator: 'LINK Mobility',
		source: 'https://www.linkmobility.com/resources/developer/SMSC-SMPP-User-Guide-1.5.pdf',
	},
	{
		codes: ['DELIVRD', 'EXPIRED', 'FAILED', 'REJECTD', 'UNDELIV'],
		operator: 'Route Mobile',
		source: 'https://routemobile.com/pdf_files/developer/api/routemobilesmpp.pdf',
	},
	{
		codes: ['ACCEPTD', 'DELETED', 'DELIVRD', 'EXPIRED', 'FAILED', 'REJECTD', 'UNDELIV', 'UNKNOWN'],
		operator: 'Vonage',
		source: 'https://api.support.vonage.com/hc/en-us/articles/204015663',
	},
];

describe('the status codes operators publish', () => {
	test('names a state of its own for every one of them', () => {
		for (const { codes, operator, source } of documentedCodes) {
			for (const code of codes) {
				const dlr = dlrFromPdu(deliverSm(`id:ec421e62 stat:${code} err:000 text:`));

				assert.ok(dlr);
				assert.equal(
					dlr.statusMsg === 'UNKNOWN',
					code === 'UNKNOWN',
					`${operator} documents stat:${code}, read as ${dlr.statusMsg} — ${source}`,
				);
				assert.equal(dlr.intermediate, code === 'ENROUTE', `${operator} stat:${code} — ${source}`);
			}
		}
	});

	// A code the reader cannot name leaves an unmarked deliver_sm arriving as an inbound message.
	test('reads an unmarked deliver_sm reporting one of them as a report, not as a message', () => {
		for (const code of ['DELIVERD', 'FAILED']) {
			const dlr = dlrFromPdu(deliverSm(`id:2a1f0f1d stat:${code} err:051 text:none`, undefined, 0));

			assert.ok(dlr, `stat:${code} marks a report even where esm_class does not`);
			assert.equal(dlr.smsId, '2a1f0f1d');
		}
	});

	// "Only none or final delivery ... are supported" — the SMSC-SMPP User Guide 1.5, sourced below.
	test('finds none of LINK Mobility\'s among the transient ones', () => {
		const link = documentedCodes.find(one => one.operator === 'LINK Mobility');

		const transient = transientStates.map(state => receiptCodes[state]);

		assert.ok(link);
		assert.deepEqual(link.codes.filter(code => transient.includes(code)), [], link.source);
	});
});

describe('a receipt body that is not the shape the spec fixes', () => {
	const id = 'f5c98a862c8d6014';
	const ordered = `id:${id} sub:001 dlvrd:001 submit date:2609051430 done date:2609051431 stat:DELIVRD err:000 text:`;

	test('reads the same fields whatever order they arrive in', () => {
		const shuffled = `stat:DELIVRD err:000 done date:2609051431 dlvrd:001 submit date:2609051430 sub:001 id:${id} text:`;

		assert.deepEqual(parseReceipt(shuffled), parseReceipt(ordered));
	});

	// text: is the one field that may hold spaces, so it can only end where the line does.
	test('reads the rest of the line as the text where a peer does not write text last', () => {
		const early = `id:${id} text: stat:DELIVRD err:000`;

		assert.equal(parseReceipt(early).text, ' stat:DELIVRD err:000');
		assert.equal(parseReceipt(early).stat, 'DELIVRD', 'the other fields are still read');
	});

	test('settles a status against no message where a marked receipt names no id', () => {
		const bodyless = 'sub:001 dlvrd:001 submit date:2609051430 done date:2609051431 stat:DELIVRD err:000 text:';
		const marked = dlrFromPdu(deliverSm(bodyless));

		assert.ok(marked);
		assert.equal(marked.smsId, undefined);
		assert.equal(marked.statusMsg, 'DELIVERED');
		assert.equal(marked.receipt?.id, undefined);
		assert.equal(dlrFromPdu(deliverSm(bodyless, undefined, 0)), undefined, 'unmarked, it is a message');
	});

	// Telesign's page calls err a 3-octet hex code and then gives eight-digit examples of it.
	test('hands the err field over as it arrived, whichever width the operator writes', () => {
		for (const err of ['4A6', '000004A6']) {
			assert.equal(dlrFromPdu(deliverSm(`id:x stat:UNDELIV err:${err}`))?.errorCode, err);
		}
	});

	test('takes the id from the TLV where the body names none', () => {
		const id54 = '08472259999bf99e679376b52ebbb685';
		const dlr = dlrFromPdu(deliverSm('sub:001 stat:DELIVRD err:000 text:', {
			receipted_message_id: { tagValue: id54 },
		}, 0));

		assert.ok(dlr);
		assert.equal(dlr.smsId, id54);
		assert.equal(dlr.statusMsg, 'DELIVERED');
	});
});

/** Resolves once `count` of them have arrived, so a run short of that fails rather than hangs. */
function collect<T>(count: number, register: (push: (value: T) => void) => void): Promise<T[]> {
	const values: T[] = [];

	return new Promise<T[]>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`waited 5000 ms for ${String(count)} events, ${String(values.length)} arrived`));
		}, 5000);

		register(value => {
			values.push(value);

			if (values.length < count) return;

			clearTimeout(timer);
			resolve(values);
		});
	});
}

const message = { from: '46701113311', to: '46709771337' };

function receiptBody(id: string): string {
	return `id:${id} sub:001 dlvrd:001 submit date:2609051430 done date:2609051431 stat:DELIVRD err:000 text:`;
}

describe('an SMSC that writes its message ids in two notations', () => {
	// Vonage answers a submit in hex and writes the receipt's id: in decimal off the same number.
	const hex = '33647f6c';
	const decimal = '862224236';

	test('correlates the receipt against the send once both notations are named', async t => {
		const smsc = await dummySmsc(t, { messageIds: [hex] });
		const session = await bindToSmsc(t, smsc.port, {
			smsIdFormat: { receipt: 'decimal', submitResp: 'hex' },
		});
		const reported = collect<Dlr>(1, push => { session.on('dlr', push); });
		const sent = await session.sendSms({ dlr: true, message: 'operator receipt', ...message });

		assert.equal(sent.err, undefined);
		assert.deepEqual(sent.smsIds, [decimal]);
		smsc.deliver(receiptBody(decimal));

		const [dlr] = await reported;

		assert.ok(dlr);
		assert.equal(dlr.smsId, sent.smsIds[0]);
		assert.equal(dlr.receipt?.id, decimal, 'the receipt itself keeps what the operator wrote');
	});

	test('leaves the two incomparable where neither notation is named', async t => {
		const smsc = await dummySmsc(t, { messageIds: [hex] });
		const session = await bindToSmsc(t, smsc.port);
		const reported = collect<Dlr>(1, push => { session.on('dlr', push); });
		const sent = await session.sendSms({ dlr: true, message: 'operator receipt', ...message });

		assert.deepEqual(sent.smsIds, [hex]);
		smsc.deliver(receiptBody(decimal));

		const [dlr] = await reported;

		assert.ok(dlr);
		assert.equal(dlr.smsId, decimal);
		assert.notEqual(dlr.smsId, sent.smsIds[0]);
	});

	test('strips the padding an operator writes the same number with', async t => {
		const smsc = await dummySmsc(t, { messageIds: ['706678557'] });
		const session = await bindToSmsc(t, smsc.port, {
			smsIdFormat: { receipt: 'decimal', submitResp: 'decimal' },
		});
		const reported = collect<Dlr>(1, push => { session.on('dlr', push); });
		const sent = await session.sendSms({ dlr: true, message: 'operator receipt', ...message });

		assert.deepEqual(sent.smsIds, ['706678557']);
		smsc.deliver(receiptBody('0000706678557'));

		const [dlr] = await reported;

		assert.ok(dlr);
		assert.equal(dlr.smsId, sent.smsIds[0]);
	});
});

describe('an SMSC that reports one message more than once', () => {
	// tyntec sends a buffered receipt shortly after submission and a final one later.
	test('hands both receipts to the application rather than taking the second for a duplicate', async t => {
		const id = 'd91518bd27c1018d';
		const smsc = await dummySmsc(t, { messageIds: [id] });
		const session = await bindToSmsc(t, smsc.port);
		const reported = collect<Dlr>(2, push => { session.on('dlr', push); });
		const sent = await session.sendSms({ dlr: true, message: 'buffered then delivered', ...message });

		assert.deepEqual(sent.smsIds, [id]);
		smsc.deliver(`id:${id} sub:001 dlvrd:000 submit date:2609051430 done date:2609051430 stat:ENROUTE err:000 text:`);
		smsc.deliver(receiptBody(id));

		const [buffered, final] = await reported;

		assert.ok(buffered);
		assert.ok(final);
		assert.equal(buffered.smsId, id);
		assert.equal(final.smsId, id);
		assert.deepEqual([buffered.intermediate, final.intermediate], [true, false]);
		assert.deepEqual([buffered.statusMsg, final.statusMsg], ['ENROUTE', 'DELIVERED']);
	});
});

describe('an SMSC that reports each segment under an id of its own', () => {
	// Vonage sends one receipt per segment, and its ids carry no <base>-<n> to merge them by.
	test('reports every segment and merges nothing', async t => {
		const ids = ['bf53ad8b', '40ccdce2', 'b64bf122'];
		const smsc = await dummySmsc(t, { messageIds: ids });
		const session = await bindToSmsc(t, smsc.port);
		const merged: MessageDlr[] = [];
		const reported = collect<Dlr>(3, push => { session.on('dlr', push); });

		session.on('messageDlr', report => merged.push(report));

		const sent = await session.sendSms({ dlr: true, message: 'x'.repeat(400), ...message });

		assert.equal(sent.err, undefined);
		assert.deepEqual(sent.smsIds, ids);

		for (const id of ids) {
			smsc.deliver(receiptBody(id));
		}

		const dlrs = await reported;

		assert.deepEqual(dlrs.map(one => one.smsId), ids);
		assert.deepEqual(merged, [], 'unrelated ids spell out no message to merge');
	});

	// Telesign answers only the first part of a concatenated submit with a message id.
	test('hands back what landed where only the first segment is answered with one', async t => {
		const id = '5cb0ea53b5d61093529174ca44e23871';
		const smsc = await dummySmsc(t, { messageIds: [id] });
		const session = await bindToSmsc(t, smsc.port);
		const sent = await session.sendSms({ dlr: true, message: 'x'.repeat(400), ...message });

		assert.equal(sent.err, undefined);
		assert.equal(smsc.octets.length, 3, 'every segment goes out whatever the peer answers');
		assert.deepEqual(sent.smsIds, [id, undefined, undefined]);
		assert.equal(sent.smsIds.length, sent.pduObjs.length, 'an entry per accepted segment, positional with pduObjs');
	});

	// A peer that writes message_id empty and one that omits it build the same octets.
	test('reads an empty message_id as no id, on a single-segment send as much as a split one', async t => {
		const smsc = await dummySmsc(t, { messageIds: [] });
		const session = await bindToSmsc(t, smsc.port);
		const sent = await session.sendSms({ dlr: true, message: 'one segment', ...message });

		assert.equal(sent.err, undefined);
		assert.deepEqual(sent.smsIds, [undefined]);
	});

	test('reports the segment that was named and merges nothing where the others were not', async t => {
		const base = '01a09739-0a98-7ac0-8a9a-fcd3a7648e62';
		const smsc = await dummySmsc(t, { messageIds: [`${base}-1`] });
		const session = await bindToSmsc(t, smsc.port);
		const merged: MessageDlr[] = [];
		const reported = collect<Dlr>(1, push => { session.on('dlr', push); });

		session.on('messageDlr', report => merged.push(report));

		const sent = await session.sendSms({ dlr: true, message: 'x'.repeat(400), ...message });

		assert.deepEqual(sent.smsIds, [`${base}-1`, undefined, undefined]);
		smsc.deliver(receiptBody(`${base}-1`));

		const [dlr] = await reported;

		assert.equal(dlr?.smsId, `${base}-1`);
		assert.deepEqual(merged, [], 'a send with an unnamed segment spells out no message to merge');
	});
});
