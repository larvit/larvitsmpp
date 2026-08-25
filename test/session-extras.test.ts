import assert from 'node:assert/strict';
import net from 'node:net';
import test, { describe } from 'node:test';
import type { MessageDlr } from '../src/session.ts';
import type { Sms } from '../src/sms.ts';
import type { SmppServer } from '../src/server.ts';
import { client } from '../src/client.ts';
import { objToPdu } from '../src/pdu.ts';
import { server } from '../src/server.ts';

async function startServer(options: Parameters<typeof server>[0] = {}): Promise<SmppServer> {
	const { err, server: smpp } = await server({ ...options, port: 0 });

	assert.equal(err, undefined);
	assert.ok(smpp);

	return smpp;
}

function once<T>(register: (resolve: (value: T) => void) => void): Promise<T> {
	return new Promise<T>(resolve => { register(resolve); });
}

describe('merged delivery reports', () => {
	// 0.4.0 allocated a longSmsDlrs store to do exactly this and then never used it.
	test('reports once on a whole multipart message', async () => {
		const smpp = await startServer();
		const incoming = once<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});
		const { session } = await client({ port: smpp.port });

		assert.ok(session);

		const merged = once<MessageDlr>(resolve => { session.on('messageDlr', resolve); });
		const perSegment: string[] = [];

		session.on('dlr', dlr => perSegment.push(dlr.smsId));

		const [sms] = await Promise.all([
			incoming.then(async received => {
				received.smsId = 'merge-me';
				await received.sendResp();

				return received;
			}),
			session.sendSms({
				dlr: true,
				from: '46701113311',
				message: 'x'.repeat(400),
				to: '46709771337',
			}),
		]);

		await sms.sendDlr();

		const report = await merged;

		assert.equal(report.smsId, 'merge-me');
		assert.equal(report.segments.length, 3);
		assert.equal(report.statusMsg, 'DELIVERED');
		assert.deepEqual(perSegment, ['merge-me-1', 'merge-me-2', 'merge-me-3']);

		session.close();
		await smpp.close();
	});

	test('reports the worst status across the segments', async () => {
		const smpp = await startServer();
		const incoming = once<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});
		const { session } = await client({ port: smpp.port });

		assert.ok(session);

		const merged = once<MessageDlr>(resolve => { session.on('messageDlr', resolve); });

		const [sms] = await Promise.all([
			incoming.then(async received => {
				received.smsId = 'partly-failed';
				await received.sendResp();

				return received;
			}),
			session.sendSms({
				dlr: true,
				from: '46701113311',
				message: 'x'.repeat(400),
				to: '46709771337',
			}),
		]);

		await sms.sendDlr('UNDELIVERABLE');

		const report = await merged;

		assert.equal(report.statusMsg, 'UNDELIVERABLE');
		assert.equal(report.segments.length, 3);

		session.close();
		await smpp.close();
	});
});

describe('reconnect', () => {
	test('re-binds after the connection drops, keeping the same session object', async () => {
		const smpp = await startServer();
		const messages: string[] = [];

		// Registered up front so the session created by the reconnect is covered too.
		smpp.on('session', bound => {
			bound.on('sms', sms => {
				messages.push(sms.message);
				void sms.sendResp();
			});
		});

		const { err, session } = await client({
			port: smpp.port,
			reconnect: { maxDelay: 100, minDelay: 20 },
		});

		assert.equal(err, undefined);
		assert.ok(session);

		const reconnected = once<true>(resolve => { session.on('reconnected', () => { resolve(true); }); });

		// Drop the connection from the server's side, as a peer restart would.
		for (const serverSession of smpp.sessions) {
			serverSession.close();
		}

		await reconnected;

		assert.ok(session.loggedIn);

		// The session object survives the drop, so listeners stay attached and it is usable again.
		const sent = await session.sendSms({
			from: '46701113311',
			message: 'after reconnect',
			to: '46709771337',
		});

		assert.equal(sent.err, undefined);
		assert.deepEqual(messages, ['after reconnect']);

		session.close();
		await smpp.close();
	});

	test('does not reconnect after an explicit close', async () => {
		const smpp = await startServer();
		const { session } = await client({
			port: smpp.port,
			reconnect: { maxDelay: 50, minDelay: 10 },
		});

		assert.ok(session);

		let reconnects = 0;

		session.on('reconnected', () => { reconnects++; });
		session.close();

		await new Promise(resolve => setTimeout(resolve, 150));

		assert.equal(reconnects, 0);
		await smpp.close();
	});
});

describe('reassembly bounds', () => {
	function segment(reference: number, part: number, total: number, seqNr: number): Buffer {
		const body = Buffer.concat([
			Buffer.from([0x05, 0x00, 0x03, reference, total, part]),
			Buffer.from('fragment'),
		]);
		const { buffer } = objToPdu({
			cmdName: 'submit_sm',
			params: {
				data_coding: 0,
				destination_addr: '46709771337',
				esm_class: 0x40,
				short_message: body,
				sm_length: body.length,
				source_addr: '46701113311',
			},
			seqNr,
		});

		assert.ok(buffer);

		return buffer;
	}

	// 0.4.0 held incomplete groups without limit and swept them only when other traffic arrived.
	test('drops the oldest incomplete message once the cap is reached', async () => {
		const smpp = await startServer({ maxReassembly: 2, reassemblyTimeout: 60_000 });

		let delivered = 0;

		smpp.on('session', session => session.on('sms', () => { delivered++; }));

		const sock = net.connect({ port: smpp.port }, () => {
			sock.write(Buffer.from('0000002100000009000000000000002f666f6f0062617200736d70700034000000', 'hex'));
		});

		let bound = false;

		sock.on('data', () => {
			if (bound) return;

			bound = true;

			// Three different messages, each only ever sending part 1 of 2.
			sock.write(segment(1, 1, 2, 10));
			sock.write(segment(2, 1, 2, 11));
			sock.write(segment(3, 1, 2, 12));
			// Completing the first one must not produce a message: it was evicted.
			sock.write(segment(1, 2, 2, 13));
		});

		await new Promise(resolve => setTimeout(resolve, 200));

		assert.equal(delivered, 0, 'an evicted message must not be delivered');

		sock.destroy();
		await smpp.close();
	});

	test('expires an incomplete message on its own timer', async () => {
		const smpp = await startServer({ reassemblyTimeout: 60 });

		let delivered = 0;

		smpp.on('session', session => session.on('sms', () => { delivered++; }));

		const sock = net.connect({ port: smpp.port }, () => {
			sock.write(Buffer.from('0000002100000009000000000000002f666f6f0062617200736d70700034000000', 'hex'));
		});

		let bound = false;

		sock.on('data', () => {
			if (bound) return;

			bound = true;
			sock.write(segment(9, 1, 2, 20));
		});

		await new Promise(resolve => setTimeout(resolve, 200));

		// The other half arrives after the group expired, so it starts a new, still-incomplete one.
		sock.write(segment(9, 2, 2, 21));

		await new Promise(resolve => setTimeout(resolve, 100));

		assert.equal(delivered, 0);

		sock.destroy();
		await smpp.close();
	});
});

describe('AbortSignal on a send', () => {
	test('gives up on an in-flight request when the signal fires', async () => {
		const accepted: net.Socket[] = [];
		const silent = net.createServer(sock => {
			accepted.push(sock);
			sock.resume();
			// Answer the bind so the client gets a session, then go quiet.
			sock.write(Buffer.from('0000001180000009000000000000000100', 'hex'));
		});

		await new Promise<void>(resolve => silent.listen(0, resolve));

		const address = silent.address();
		const port = typeof address === 'object' && address !== null ? address.port : 0;
		const { err, session } = await client({ port, responseTimeout: 10_000 });

		assert.equal(err, undefined);
		assert.ok(session);

		const controller = new AbortController();

		setTimeout(() => { controller.abort(); }, 50);

		const sent = await session.sendSms(
			{ from: '46701113311', message: 'never answered', to: '46709771337' },
			{ signal: controller.signal },
		);

		assert.ok(sent.err instanceof Error);

		session.close();

		for (const sock of accepted) sock.destroy();

		await new Promise<void>(resolve => silent.close(() => { resolve(); }));
	});
});
