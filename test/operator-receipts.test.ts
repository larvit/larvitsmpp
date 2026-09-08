import assert from 'node:assert/strict';
import net from 'node:net';
import test, { describe } from 'node:test';
import type { Dlr, Receipt } from '../src/dlr.ts';
import type { MessageDlr } from '../src/session.ts';
import type { PduObject, TlvInput } from '../src/pdu.ts';
import type { Session } from '../src/session.ts';
import type { TestContext } from 'node:test';
import { DlrMerger } from '../src/dlr-merger.ts';
import { PduFramer } from '../src/pdu-framer.ts';
import { bindCommands } from '../src/session.ts';
import { client } from '../src/client.ts';
import { closeAfter, closeListenerAfter } from './teardown.ts';
import { consts } from '../src/defs/constants.ts';
import { dlrFromPdu, parseReceipt } from '../src/dlr.ts';
import { objToPdu, pduReturn, pduToObj } from '../src/pdu.ts';
import { silentLog } from '../src/log.ts';

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
	esmClass?: number;
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
		body: 'id:5be9f816f19992a78c8e26442f8afa50 submit date:2609051430 done date:2609051433 stat:DELIVRD err:000',
		dlr: {
			doneDate: '2026-09-05T14:33:00.000Z',
			errorCode: '000',
			intermediate: false,
			smsId: '5be9f816f19992a78c8e26442f8afa50',
			statusId: consts.MESSAGE_STATE.DELIVERED,
			statusMsg: 'DELIVERED',
		},
		name: 'CM.com, which writes neither sub nor dlvrd and states the same status twice',
		receipt: {
			dlvrd: undefined,
			doneDate: '2609051433',
			err: '000',
			id: '5be9f816f19992a78c8e26442f8afa50',
			stat: 'DELIVRD',
			sub: undefined,
			submitDate: '2609051430',
			text: undefined,
		},
		source: 'https://developers.cm.com/messaging/docs/smpp',
		tlvs: { message_state: { tagValue: consts.MESSAGE_STATE.DELIVERED } },
	},
	{
		body: 'id:e9ca671b2497d778d771938333dc0c52 sub:001 dlvrd:000 submit date:260905143000 done date:260905143010 stat:UNKNOWN err:4A6 text:',
		dlr: {
			doneDate: '2026-09-05T14:30:10.000Z',
			errorCode: '4A6',
			intermediate: false,
			smsId: 'e9ca671b2497d778d771938333dc0c52',
			statusId: consts.MESSAGE_STATE.SKIPPED,
			statusMsg: 'SKIPPED',
		},
		name: 'Telesign, whose err is hexadecimal and whose message_state 9 the body has no code for',
		receipt: {
			dlvrd: 0,
			doneDate: '260905143010',
			err: '4A6',
			id: 'e9ca671b2497d778d771938333dc0c52',
			stat: 'UNKNOWN',
			sub: 1,
			submitDate: '260905143000',
			text: '',
		},
		source: 'https://developer.telesign.com/enterprise/docs/sms-smpp-tlvs',
		tlvs: {
			message_state: { tagValue: 9 },
			receipted_message_id: { tagValue: 'e9ca671b2497d778d771938333dc0c52' },
		},
	},
	{
		body: 'sub:001 dlvrd:001 submit date:2609051430 done date:2609051431 stat:DELIVRD err:000 text:',
		dlr: {
			doneDate: '2026-09-05T14:31:00.000Z',
			errorCode: '000',
			intermediate: false,
			smsId: undefined,
			statusId: consts.MESSAGE_STATE.DELIVERED,
			statusMsg: 'DELIVERED',
		},
		name: 'a marked receipt naming no id, which settles a status against no message',
		receipt: {
			dlvrd: 1,
			doneDate: '2609051431',
			err: '000',
			id: undefined,
			stat: 'DELIVRD',
			sub: 1,
			submitDate: '2609051430',
			text: '',
		},
		source: 'https://smpp.org/smpp-delivery-receipt.html',
	},
];

describe('receipt bodies operators document', () => {
	for (const fixture of fixtures) {
		test(fixture.name, () => {
			const dlr = dlrFromPdu(deliverSm(fixture.body, fixture.tlvs, fixture.esmClass));

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

/** Every seven-character code the researched operators list, per operator, with the page it is on. */
const documentedCodes: readonly { codes: readonly string[]; operator: string; source: string }[] = [
	{
		codes: ['ACCEPTD', 'DELIVRD', 'REJECTD', 'UNDELIV'],
		operator: 'Clickatell',
		source: 'https://archive.clickatell.com/developers/api-docs/pdu-details/',
	},
	{
		codes: ['ACCEPTD', 'DELETED', 'DELIVRD', 'EXPIRED', 'REJECTD', 'UNDELIV', 'UNKNOWN'],
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
					`${operator} documents stat:${code}, which nothing here names — ${source}`,
				);
				assert.equal(dlr.intermediate, code === 'ENROUTE', `${operator} stat:${code} — ${source}`);
			}
		}
	});

	// LINK Mobility supports no intermediate receipts at all, so none of its codes may read as one.
	test('reads none of LINK Mobility\'s as anything but final', () => {
		const link = documentedCodes.find(one => one.operator === 'LINK Mobility');

		assert.ok(link);

		for (const code of link.codes) {
			assert.equal(dlrFromPdu(deliverSm(`id:53a9d7b2 stat:${code}`))?.intermediate, false);
		}
	});
});

describe('a receipt whose fields are not where the spec puts them', () => {
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

	test('leaves an unmarked deliver_sm that names no id to arrive as a message', () => {
		const bodyless = 'sub:001 dlvrd:001 stat:DELIVRD err:000 text:';

		assert.equal(dlrFromPdu(deliverSm(bodyless, undefined, 0)), undefined);
		assert.equal(dlrFromPdu(deliverSm(bodyless))?.smsId, undefined, 'the marker still makes it a report');
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

type OperatorSmsc = {
	port: number;
	/** Writes a receipt to the ESME, spelled as the operator's own documentation spells it. */
	receipt: (body: string, options?: { esmClass?: number; tlvs?: Record<string, TlvInput> }) => void;
	submits: PduObject[];
};

/** An SMSC answering binds, and each submit_sm with the next message id the fixture names. */
async function operatorSmsc(t: TestContext, messageIds: readonly string[]): Promise<OperatorSmsc> {
	const accepted: net.Socket[] = [];
	const submits: PduObject[] = [];
	let answered = 0;
	let sent = 0;
	const listener = net.createServer(sock => {
		const framer = new PduFramer();

		accepted.push(sock);
		sock.on('data', chunk => {
			framer.push(chunk);

			for (const pdu of framer.next().pdus ?? []) {
				const { pduObj } = pduToObj(pdu);

				if (!pduObj) continue;

				if (bindCommands.includes(pduObj.cmdName)) {
					const bound = pduReturn(pduObj, 'ESME_ROK', { system_id: 'operator' });

					if (bound.buffer) sock.write(bound.buffer);
				} else if (pduObj.cmdName === 'submit_sm') {
					submits.push(pduObj);

					const taken = pduReturn(pduObj, 'ESME_ROK', { message_id: messageIds[answered++] ?? '' });

					if (taken.buffer) sock.write(taken.buffer);
				}
			}
		});
	});

	await new Promise<void>(resolve => { listener.listen(0, resolve); });
	closeListenerAfter(t, listener, accepted);

	const address = listener.address();

	return {
		port: typeof address === 'object' && address !== null ? address.port : 0,
		receipt: (body, options = {}) => {
			const { buffer } = objToPdu({
				cmdName: 'deliver_sm',
				params: {
					destination_addr: '46701113311',
					esm_class: options.esmClass ?? consts.ESM_CLASS.MC_DELIVERY_RECEIPT,
					short_message: body,
					source_addr: '46709771337',
				},
				seqNr: ++sent,
				tlvs: options.tlvs,
			});

			assert.ok(buffer);
			accepted[accepted.length - 1]?.write(buffer);
		},
		submits,
	};
}

async function bindTo(
	t: TestContext,
	port: number,
	options: Parameters<typeof client>[0] = {},
): Promise<Session> {
	const { err, session } = await client({ ...options, port });

	assert.equal(err, undefined);
	assert.ok(session);
	closeAfter(t, session);

	return session;
}

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
		const smsc = await operatorSmsc(t, [hex]);
		const session = await bindTo(t, smsc.port, {
			smsIdFormat: { receipt: 'decimal', submitResp: 'hex' },
		});
		const reported = collect<Dlr>(1, push => { session.on('dlr', push); });
		const sent = await session.sendSms({ dlr: true, message: 'operator receipt', ...message });

		assert.equal(sent.err, undefined);
		assert.deepEqual(sent.smsIds, [decimal]);
		smsc.receipt(receiptBody(decimal));

		const [dlr] = await reported;

		assert.ok(dlr);
		assert.equal(dlr.smsId, sent.smsIds[0]);
		assert.equal(dlr.receipt?.id, decimal, 'the receipt itself keeps what the operator wrote');
	});

	test('leaves the two incomparable where neither notation is named', async t => {
		const smsc = await operatorSmsc(t, [hex]);
		const session = await bindTo(t, smsc.port);
		const reported = collect<Dlr>(1, push => { session.on('dlr', push); });
		const sent = await session.sendSms({ dlr: true, message: 'operator receipt', ...message });

		assert.deepEqual(sent.smsIds, [hex]);
		smsc.receipt(receiptBody(decimal));

		const [dlr] = await reported;

		assert.ok(dlr);
		assert.equal(dlr.smsId, decimal);
		assert.notEqual(dlr.smsId, sent.smsIds[0]);
	});

	test('strips the padding an operator writes the same number with', async t => {
		const smsc = await operatorSmsc(t, ['706678557']);
		const session = await bindTo(t, smsc.port, {
			smsIdFormat: { receipt: 'decimal', submitResp: 'decimal' },
		});
		const reported = collect<Dlr>(1, push => { session.on('dlr', push); });
		const sent = await session.sendSms({ dlr: true, message: 'operator receipt', ...message });

		assert.deepEqual(sent.smsIds, ['706678557']);
		smsc.receipt(receiptBody('0000706678557'));

		const [dlr] = await reported;

		assert.ok(dlr);
		assert.equal(dlr.smsId, sent.smsIds[0]);
	});
});

describe('an SMSC that reports one message more than once', () => {
	// tyntec sends a buffered receipt shortly after submission and a final one later.
	test('hands both receipts to the application rather than taking the second for a duplicate', async t => {
		const id = 'd91518bd27c1018d';
		const smsc = await operatorSmsc(t, [id]);
		const session = await bindTo(t, smsc.port);
		const reported = collect<Dlr>(2, push => { session.on('dlr', push); });
		const sent = await session.sendSms({ dlr: true, message: 'buffered then delivered', ...message });

		assert.deepEqual(sent.smsIds, [id]);
		smsc.receipt(`id:${id} sub:001 dlvrd:000 submit date:2609051430 done date:2609051430 stat:ENROUTE err:000 text:`);
		smsc.receipt(receiptBody(id));

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
		const smsc = await operatorSmsc(t, ids);
		const session = await bindTo(t, smsc.port);
		const merged: MessageDlr[] = [];
		const reported = collect<Dlr>(3, push => { session.on('dlr', push); });

		session.on('messageDlr', report => merged.push(report));

		const sent = await session.sendSms({ dlr: true, message: 'x'.repeat(400), ...message });

		assert.equal(sent.err, undefined);
		assert.deepEqual(sent.smsIds, ids);

		for (const id of ids) {
			smsc.receipt(receiptBody(id));
		}

		const dlrs = await reported;

		assert.deepEqual(dlrs.map(one => one.smsId), ids);
		assert.deepEqual(merged, [], 'unrelated ids spell out no message to merge');
	});

	// Telesign answers only the first part of a concatenated submit with a message id.
	test('hands back what landed where only the first segment is answered with one', async t => {
		const id = '5cb0ea53b5d61093529174ca44e23871';
		const smsc = await operatorSmsc(t, [id]);
		const session = await bindTo(t, smsc.port);
		const sent = await session.sendSms({ dlr: true, message: 'x'.repeat(400), ...message });

		assert.equal(sent.err, undefined);
		assert.equal(smsc.submits.length, 3);
		assert.deepEqual(sent.smsIds, [id, '', '']);

		const merger = new DlrMerger({ log: silentLog, max: 10, now: () => 0, timeout: 60_000 });

		merger.expect(sent.smsIds);
		assert.equal(merger.size, 0, 'ids that do not number one message arm no merge');
	});
});
