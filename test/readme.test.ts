import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import type { Dlr } from '../src/dlr.ts';
import type { Session } from '../src/session.ts';
import type { Sms } from '../src/sms.ts';
import type { SmppLog } from '../src/log.ts';
import type { SmppServer } from '../src/server.ts';
import type { TestContext } from 'node:test';
import { client } from '../src/client.ts';
import { server } from '../src/server.ts';

function once<T>(register: (resolve: (value: T) => void) => void): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error('waited 5000 ms for an event that never fired'));
		}, 5000);

		register(value => {
			clearTimeout(timer);
			resolve(value);
		});
	});
}

/** The README's examples listen on the documented default port, so one server runs at a time. */
async function answeringServer(t: TestContext): Promise<SmppServer> {
	const { err, server: smpp } = await server();

	assert.equal(err, undefined);
	assert.ok(smpp);
	t.after(() => smpp.close());

	smpp.on('session', session => {
		session.on('sms', async sms => {
			await sms.sendResp();

			if (sms.dlr) await sms.sendDlr();
		});
	});

	return smpp;
}

describe('README: Client', () => {
	test('the simplest possible client', async t => {
		await answeringServer(t);

		const { err, session } = await client();
		if (err) throw err;

		await session.sendSms({
			from: '46701113311',
			message: 'Hello world',
			to: '46709771337',
		});

		await session.unbind();
	});

	test('with connection parameters, a delivery report and logging', async t => {
		await answeringServer(t);

		const log: SmppLog = {
			debug: () => undefined,
			error: () => undefined,
			info: () => undefined,
			verbose: () => undefined,
			warn: () => undefined,
		};

		const { err, session } = await client({
			host: 'localhost',
			log,
			password: 'bar',
			port: 2775,
			username: 'foo',
		});
		if (err) throw err;

		t.after(() => { session.close(); });

		const reported = once<Dlr>(resolve => { session.on('dlr', resolve); });
		const { err: sendErr, smsIds } = await session.sendSms({
			dlr: true,
			from: '46701113311',
			message: '«baff»',
			to: '46709771337',
		});

		assert.equal(sendErr, undefined);
		assert.equal(smsIds.length, 1);
		assert.equal((await reported).smsId, smsIds[0]);
	});

	test('the documented sending options', async t => {
		const smpp = await answeringServer(t);
		const incoming = once<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});
		const { err, session } = await client();
		if (err) throw err;

		t.after(() => { session.close(); });

		const { signal } = new AbortController();
		const [sms, sent] = await Promise.all([
			incoming,
			session.sendSms({
				dlr: true,
				encoding: 'UCS2',
				flash: false,
				from: 'MyBrand',
				message: 'Hello world',
				scheduleDeliveryTime: new Date(Date.now() + 3600_000),
				to: '46709771337',
				validityPeriod: 3600,
			}, { signal }),
		]);

		assert.equal(sent.err, undefined);
		assert.equal(sms.from, 'MyBrand');
		assert.equal(sms.message, 'Hello world');
	});

	test('receiving an inbound message on a client session', async t => {
		const smpp = await answeringServer(t);
		const bound = once<Session>(resolve => { smpp.on('session', resolve); });
		const { err, session } = await client();
		if (err) throw err;

		t.after(() => { session.close(); });

		const incoming = once<Sms>(resolve => { session.on('sms', resolve); });
		const peer = await bound;

		void peer.send({
			cmdName: 'deliver_sm',
			params: {
				destination_addr: '46709771337',
				short_message: 'inbound hello',
				source_addr: '46701113311',
			},
		});

		const sms = await incoming;

		await sms.sendResp();

		assert.equal(sms.message, 'inbound hello');
	});
});

describe('README: Server', () => {
	test('the simplest possible server', async t => {
		const { err, server: smpp } = await server();
		if (err) throw err;

		t.after(() => smpp.close());

		const received: string[] = [];

		smpp.on('session', session => {
			session.on('sms', async sms => {
				received.push(sms.message);
				await sms.sendResp();
			});
		});

		const { err: clientErr, session } = await client();

		assert.equal(clientErr, undefined);
		assert.ok(session);

		await session.sendSms({ from: '46701113311', message: 'Hello world', to: '46709771337' });
		await session.unbind();

		assert.deepEqual(received, ['Hello world']);
	});

	test('with authentication and delivery reports', async t => {
		const { err, server: smpp } = await server({
			authenticate: ({ password, systemId }) => {
				if (systemId !== 'foo' || password !== 'bar') return false;

				return { userData: { userId: 123 } };
			},
		});
		if (err) throw err;

		t.after(() => smpp.close());

		smpp.on('session', session => {
			session.on('sms', async sms => {
				await sms.sendResp();

				if (sms.dlr) {
					await sms.sendDlr();
				}
			});
		});

		assert.equal(smpp.port, 2775);

		const refused = await client({ password: 'wrong', username: 'foo' });

		assert.ok(refused.err instanceof Error);

		const { err: clientErr, session } = await client({ password: 'bar', username: 'foo' });

		assert.equal(clientErr, undefined);
		assert.ok(session);

		const reported = once<Dlr>(resolve => { session.on('dlr', resolve); });
		const sent = await session.sendSms({
			dlr: true,
			from: '46701113311',
			message: 'with a receipt',
			to: '46709771337',
		});

		assert.equal(sent.err, undefined);
		assert.equal((await reported).statusMsg, 'DELIVERED');

		await session.unbind();
	});
});

describe('README: Errors', () => {
	test('a refused connection reports err instead of throwing', async () => {
		const { err, session } = await client({ port: 1 });

		assert.ok(err instanceof Error);
		assert.equal(session, undefined);
	});
});
