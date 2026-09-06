import assert from 'node:assert/strict';
import net from 'node:net';
import test, { after, describe } from 'node:test';
import type { Session } from '../src/session.ts';
import type { Sms } from '../src/sms.ts';
import { PduRefusedError } from '../src/index.ts';
import { bareTlvHeader, pduBytes } from '../test/raw-pdus.ts';
import { server } from '../src/server.ts';

const JSMPP_HOST = process.env.JSMPP_HOST ?? 'jsmpp:8080';
const SMPP_PORT = Number(process.env.SMPP_PORT ?? '2775');

function delay(ms: number): Promise<void> {
	return new Promise(resolve => { setTimeout(resolve, ms); });
}

async function waitFor<T>(get: () => T | undefined, budget = 8000): Promise<T | undefined> {
	const deadline = Date.now() + budget;
	let value = get();

	while (value === undefined && Date.now() < deadline) {
		await delay(20);
		value = get();
	}

	return value;
}

type DriverResult = Record<string, unknown>;

/** The jsmpp driver's own HTTP command channel - one bound session or raw socket per `session`/`raw` name. */
async function driver(path: string, params: Record<string, string> = {}): Promise<DriverResult> {
	const url = `http://${JSMPP_HOST}${path}?${new URLSearchParams(params).toString()}`;
	const response = await fetch(url);

	return response.json() as Promise<DriverResult>;
}

const allSms: { session: Session; sms: Sms }[] = [];
const allSessionErrors: { err: Error; session: Session }[] = [];
const bindPdus: Record<string, unknown>[] = [];
/** Messages a test answers itself (a refusing status, or asserting on the response) - populate
 * before triggering the submit that will carry this exact text, so the global auto-ack never runs. */
const manualTexts = new Set<string>();

const { err: serverErr, server: smpp } = await server({
	authenticate: () => true,
	idleTimeout: 40_000,
	port: SMPP_PORT,
});

assert.equal(serverErr, undefined);
assert.ok(smpp);

const smppServer = smpp;

smppServer.on('session', session => {
	session.on('incomingPduObj', pduObj => {
		if (pduObj.cmdName.startsWith('bind_')) bindPdus.push(pduObj.params);
	});
	session.on('sms', sms => {
		allSms.push({ session, sms });
		if (!manualTexts.has(sms.message)) void sms.sendResp();
	});
	session.on('sessionError', err => { allSessionErrors.push({ err, session }); });
});

after(async () => {
	await smppServer.close();
});

async function waitForSms(message: string, budget = 8000): Promise<Sms> {
	const found = await waitFor(() => allSms.find(entry => entry.sms.message === message)?.sms, budget);

	assert.ok(found, `no sms carrying ${JSON.stringify(message)} arrived (seen: ${JSON.stringify(allSms.map(e => e.sms.message))})`);

	return found;
}

async function waitForSessions(count: number, budget = 15_000): Promise<Session[]> {
	const found = await waitFor(() => ([...smppServer.sessions].length >= count ? [...smppServer.sessions] : undefined), budget);

	assert.ok(found, `no ${String(count)} session(s) bound within ${String(budget)}ms`);

	return found;
}

describe('bind version negotiation (target 8)', () => {
	test('0x34: our bind_resp carries sc_interface_version, jsmpp negotiates 3.4', async () => {
		const result = await driver('/bind', { interfaceVersion: '52', password: 'jsmpppw', session: 'v34', systemId: 'jsmpp-v34' });

		assert.equal(result.ok, true);
		assert.equal(result.negotiatedInterfaceVersion, 52);

		await waitForSessions(1);
		const bind = await waitFor(() => bindPdus.find(p => p.system_id === 'jsmpp-v34'));

		assert.ok(bind);
		assert.equal(bind.interface_version, 0x34);
	});

	test('0x33: our bind_resp carries no TLVs, and jsmpp reports back what it asked for', async () => {
		const result = await driver('/bind', { interfaceVersion: '51', password: 'jsmpppw', session: 'v33', systemId: 'jsmpp-v33' });

		assert.equal(result.ok, true);
		// jsmpp's session.getInterfaceVersion() simply echoes what the driver declared - it does not
		// visibly fall back to 3.4 here despite the absent sc_interface_version TLV, which is the
		// opposite of what its own source (a scVersion-null branch defaulting to IF_34) suggests.
		// Recorded as observed rather than as a confirmation of that code path - see Peer quirks.
		assert.equal(result.negotiatedInterfaceVersion, 51);

		const bind = await waitFor(() => bindPdus.find(p => p.system_id === 'jsmpp-v33'));

		assert.ok(bind);
		assert.equal(bind.interface_version, 0x33);

		const session = [...smppServer.sessions].find(s => s.peerInterfaceVersion === 0x33);

		assert.ok(session);
		assert.equal(session.acceptsOptionalParams(), false);
	});
});

describe('S2 - long messages in every spelling (targets 2, 3, 5)', () => {
	test('UDH, 8-bit reference: one reassembled sms, each segment answered <base>-<n>', async () => {
		await waitForSessions(1);

		const text = 'u8-'.padEnd(200, 'a');
		const result = await driver('/submit', { encoding: 'gsm7', from: '1001', mode: 'udh8', session: 'v34', text, to: '2001' });

		assert.equal(result.ok, true);
		const segments = result.segments as { messageId: string; part: number; total: number }[];

		assert.equal(segments.length, 2);

		const sms = await waitForSms(text, 15_000);

		assert.equal(sms.answeredOnArrival, true);
		assert.equal(segments[0]?.messageId, `${sms.smsId}-1`);
		assert.equal(segments[1]?.messageId, `${sms.smsId}-2`);
	});

	test('UDH, 16-bit reference: also reassembled - our library reads both widths', async () => {
		await waitForSessions(1);

		const text = 'u16-'.padEnd(200, 'b');
		const result = await driver('/submit', { encoding: 'gsm7', from: '1001', mode: 'udh16', session: 'v34', text, to: '2001' });

		assert.equal(result.ok, true);
		const segments = result.segments as { messageId: string }[];

		const sms = await waitForSms(text, 15_000);

		assert.equal(sms.answeredOnArrival, true);
		assert.equal(segments[0]?.messageId, `${sms.smsId}-1`);
		assert.equal(segments[1]?.messageId, `${sms.smsId}-2`);
	});

	test('message_payload: one sms, the full text', async () => {
		await waitForSessions(1);

		// No underscore: GSM 03.38's default alphabet maps ASCII 0x5F to section-sign, not "_" -
		// the driver's "gsm7" mode sends plain ASCII bytes, so a real underscore round-trips wrong
		// on purpose (a GSM7 encoder bug in this fixture, not in @larvit/smpp).
		const text = 'payload carries the whole body in one submit sm';
		const result = await driver('/submit', { encoding: 'gsm7', from: '1001', mode: 'payload', session: 'v34', text, to: '2001' });

		assert.equal(result.ok, true);

		const sms = await waitForSms(text);

		assert.equal(sms.message, text);
		assert.equal(sms.answeredOnArrival, false);
	});

	test('sar_*: defect (target 3) - each segment reaches the application as its own sms, not one', async () => {
		await waitForSessions(1);

		const text = 'sar-'.padEnd(200, 'c');
		const result = await driver('/submit', { encoding: 'gsm7', from: '1001', mode: 'sar', session: 'v34', text, to: '2001' });

		assert.equal(result.ok, true);
		const segments = result.segments as { messageId: string; part: number }[];

		assert.equal(segments.length, 2);

		// Neither segment ever arrives as the whole 200-char text: each is its own ordinary sms
		// carrying only its own ~130-char slice, with its own unrelated (non-<base>-<n>) message id.
		const first = await waitForSms(text.slice(0, 130), 15_000);
		const second = await waitForSms(text.slice(130), 15_000);

		assert.equal(first.answeredOnArrival, false);
		assert.equal(second.answeredOnArrival, false);
		assert.notEqual(first.smsId, second.smsId);
		assert.equal(allSms.some(entry => entry.sms.message === text), false);
		void first;
		void second;
	});
});

describe('S3 - known-but-unhandled and malformed commands (targets 1, 6)', () => {
	test('query_sm, cancel_sm, replace_sm: ESME_RINVCMDID, link survives, jsmpp accepts the answer', async () => {
		await waitForSessions(1);

		const errorsBefore = allSessionErrors.length;

		for (const path of ['/querySm', '/cancelSm', '/replaceSm']) {
			const result = await driver(path, { messageId: '1', session: 'v34' });

			assert.equal(result.ok, true);
			assert.equal(result.refused, true);
			assert.equal(result.commandStatus, 0x0003);
		}

		// jsmpp itself did not throw or close the link over any of the three refusals.
		const link = await driver('/enquireLink', { session: 'v34' });

		assert.equal(link.ok, true);
		assert.equal(link.sessionState, 'BOUND_TRX');
		assert.equal(allSessionErrors.length, errorsBefore);
	});

	test('an unknown command id gets generic_nack ESME_RINVCMDID, and the link survives', async () => {
		await driver('/rawBind', { interfaceVersion: '52', password: 'rawpw', raw: 'malformed', systemId: 'jsmpp-raw' });

		const result = await driver('/rawUnknownCommand', { raw: 'malformed' });
		const response = result.response as Record<string, unknown>;

		assert.equal(response.cmdIdHex, '0x80000000');
		assert.equal(response.cmdStatusHex, '0x3');

		const refused = await waitFor(() => allSessionErrors.find(e => e.err instanceof PduRefusedError
			&& e.err.reason === 'command'));

		assert.ok(refused);

		const link = await driver('/rawEnquireLink', { raw: 'malformed' });
		const linkResponse = link.response as Record<string, unknown>;

		assert.equal(linkResponse.cmdStatusHex, '0x0');
	});

	test('a deliver_sm with a truncated TLV stream gets ESME_RINVTLVSTREAM, link survives', async () => {
		const result = await driver('/rawTruncatedTlv', { raw: 'malformed' });
		const response = result.response as Record<string, unknown>;

		assert.equal(response.cmdIdHex, '0x80000005');
		assert.equal(response.cmdStatusHex, '0xc0');

		const refused = await waitFor(() => allSessionErrors.find(e => e.err instanceof PduRefusedError && e.err.reason === 'tlvs'));

		assert.ok(refused);
	});

	test('a deliver_sm whose body is shorter than sm_length declares gets ESME_RINVCMDLEN', async () => {
		const result = await driver('/rawShortBody', { raw: 'malformed' });
		const response = result.response as Record<string, unknown>;

		assert.equal(response.cmdIdHex, '0x80000005');
		assert.equal(response.cmdStatusHex, '0x2');

		const link = await driver('/rawEnquireLink', { raw: 'malformed' });
		const linkResponse = link.response as Record<string, unknown>;

		assert.equal(linkResponse.cmdStatusHex, '0x0');
	});

	// Not reachable through jsmpp's own typed API at all (it cannot construct wire garbage), so this
	// is a raw fixture opened directly against our server().
	test('a deliver_sm ending in a bare TLV header gets ESME_RINVTLVSTREAM, and reaches no listener', async () => {
		await waitForSessions(1);

		const sock = net.connect(SMPP_PORT, '127.0.0.1');

		await new Promise<void>(resolve => { sock.once('connect', () => { resolve(); }); });

		sock.write(pduBytes({
			cmdName: 'bind_transceiver',
			params: { interface_version: 0x34, password: 'pw', system_id: 'rawverify' },
			seqNr: 1,
		}));
		await new Promise<void>(resolve => { sock.once('data', () => { resolve(); }); });

		const responsePromise = new Promise<Buffer>(resolve => { sock.once('data', data => { resolve(data); }); });

		sock.write(bareTlvHeader({
			cmdName: 'deliver_sm',
			params: {
				destination_addr: 'raw2-to',
				short_message: 'truncated tlv probe silent',
				source_addr: 'raw2-from',
			},
			seqNr: 777,
		}));

		const response = await responsePromise;

		assert.equal(response.readUInt32BE(4), 0x80000005);
		assert.equal(response.readUInt32BE(8), 0x000000C0);
		assert.equal(response.readUInt32BE(12), 777);

		const refused = await waitFor(() => allSessionErrors.find(e => e.err instanceof PduRefusedError
			&& e.err.header.seqNr === 777));

		assert.ok(refused);
		assert.ok(refused.err instanceof PduRefusedError);
		assert.equal(refused.err.reason, 'tlvs');
		assert.equal(allSms.some(entry => entry.sms.message === 'truncated tlv probe silent'), false);
		sock.destroy();
	});
});

describe('a refusing status is surfaced back to jsmpp', () => {
	test('sms.sendResp({ status: "ESME_RMSGQFUL" }) reaches jsmpp as a NegativeResponseException', async () => {
		await waitForSessions(1);

		const text = 'refuse-me';

		manualTexts.add(text);

		const submitted = driver('/submit', { encoding: 'gsm7', from: '1001', mode: 'plain', session: 'v34', text, to: '2001' });
		const sms = await waitForSms(text);

		await sms.sendResp({ status: 'ESME_RMSGQFUL' });

		const result = await submitted;

		assert.equal(result.ok, true);
		assert.equal(result.refused, true);
		assert.equal(result.commandStatusHex, '0x' + (0x00000014).toString(16));
	});
});
