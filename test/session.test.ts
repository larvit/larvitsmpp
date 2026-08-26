import assert from 'node:assert/strict';
import net from 'node:net';
import test, { describe } from 'node:test';
import type { Session } from '../src/session.ts';
import type { Sms } from '../src/sms.ts';
import type { SmppServer } from '../src/server.ts';
import { client } from '../src/client.ts';
import { isCommand } from '../src/pdu.ts';
import { server } from '../src/server.ts';

async function startServer(options: Parameters<typeof server>[0] = {}): Promise<SmppServer> {
	const { err, server: smpp } = await server({ ...options, port: 0 });

	assert.equal(err, undefined);
	assert.ok(smpp);

	return smpp;
}

async function connect(smpp: SmppServer, options: Parameters<typeof client>[0] = {}) {
	return client({ port: smpp.port, ...options });
}

function once<T>(register: (resolve: (value: T) => void) => void): Promise<T> {
	return new Promise<T>(resolve => { register(resolve); });
}

describe('bind', () => {
	test('binds and unbinds against a server with no auth', async () => {
		const smpp = await startServer();
		const { err, session } = await connect(smpp);

		assert.equal(err, undefined);
		assert.ok(session);
		assert.ok(session.loggedIn);

		assert.deepEqual(await session.unbind(), {});
		await smpp.close();
	});

	test('reports the resolved port when 0 was requested', async () => {
		const smpp = await startServer();

		assert.ok(smpp.port > 0);
		await smpp.close();
	});

	test('refuses the wrong credentials', async () => {
		const smpp = await startServer({
			authenticate: ({ password, systemId }) => systemId === 'foo' && password === 'bar',
		});
		const { err, session } = await connect(smpp);

		assert.ok(err instanceof Error);
		assert.equal(session, undefined);
		await smpp.close();
	});

	test('accepts the right credentials and attaches userData', async () => {
		const smpp = await startServer({
			authenticate: ({ password, systemId }) => systemId === 'foo' && password === 'bar'
				? { userData: { userId: 123 } }
				: false,
		});
		const serverSession = once<Session>(resolve => smpp.on('session', resolve));
		const { err, session } = await connect(smpp, { password: 'bar', username: 'foo' });

		assert.equal(err, undefined);
		assert.ok(session);

		const bound = await serverSession;

		assert.deepEqual(bound.userData, { userId: 123 });

		session.close();
		await smpp.close();
	});

	test('answers a non-bind command from an unbound peer with ESME_RINVBNDSTS', async () => {
		const smpp = await startServer();
		const responded = once<string>(resolve => {
			const sock = net.connect({ port: smpp.port }, () => {
				// enquire_link before binding
				sock.write(Buffer.from('00000010000000150000000000000001', 'hex'));
			});

			sock.on('data', data => {
				sock.destroy();
				resolve(data.toString('hex'));
			});
		});

		// 0x00000004 is ESME_RINVBNDSTS
		assert.equal(await responded, '00000010800000150000000400000001');
		await smpp.close();
	});

	test('declares SMPP 3.4 by default and the version the caller asks for', async () => {
		const smpp = await startServer();
		const declared: (number | undefined)[] = [];

		smpp.on('session', session => {
			session.on('incomingPduObj', pduObj => {
				if (isCommand(pduObj, 'bind_transceiver')) {
					declared.push(pduObj.params.interface_version);
				}
			});
		});

		const { session: byDefault } = await connect(smpp);
		const { session: asFive } = await connect(smpp, { interfaceVersion: 0x50 });

		assert.ok(byDefault);
		assert.ok(asFive);
		assert.deepEqual(declared, [0x34, 0x50]);

		await byDefault.unbind();
		await asFive.unbind();
		await smpp.close();
	});
});

describe('sending', () => {
	test('delivers a simple SMS with the sender TON derived from the address', async () => {
		const smpp = await startServer();
		const incoming = once<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});
		const { session } = await connect(smpp);

		assert.ok(session);

		const [sms, sent] = await Promise.all([
			incoming.then(async received => {
				received.smsId = 'fixed-id';
				await received.sendResp();

				return received;
			}),
			session.sendSms({ from: 'MyBrand', message: 'hello world', to: '46709771337' }),
		]);

		assert.equal(sms.from, 'MyBrand');
		assert.equal(sms.to, '46709771337');
		assert.equal(sms.message, 'hello world');
		assert.equal(sms.dlr, false);
		assert.equal(sent.err, undefined);
		assert.deepEqual(sent.smsIds, ['fixed-id']);

		// 0.4.0 sent TON 1 for every sender, including alphanumeric ones, which require TON 5.
		const submitted = sms.pduObjs[0];

		assert.ok(submitted);
		assert.equal(submitted.params.source_addr_ton, 5);
		assert.equal(submitted.params.dest_addr_ton, 1);

		session.close();
		await smpp.close();
	});

	test('reassembles a long SMS and answers every segment', async () => {
		const smpp = await startServer();
		const message = 'Lorem ipsum dolor sit amet, '.repeat(20);
		const incoming = once<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});
		const { session } = await connect(smpp);

		assert.ok(session);

		const [sms, sent] = await Promise.all([
			incoming.then(async received => {
				received.smsId = 'long-id';
				await received.sendResp();

				return received;
			}),
			session.sendSms({ from: '46701113311', message, to: '46709771337' }),
		]);

		assert.equal(sms.message, message);
		assert.ok(sms.pduObjs.length > 1);
		assert.equal(sent.err, undefined);
		assert.deepEqual(sent.smsIds, ['long-id-1', 'long-id-2', 'long-id-3', 'long-id-4']);

		session.close();
		await smpp.close();
	});

	test('carries a UCS2 message through unchanged', async () => {
		const smpp = await startServer();
		const message = 'räksmörgås تست 一';
		const incoming = once<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});
		const { session } = await connect(smpp);

		assert.ok(session);

		const [sms] = await Promise.all([
			incoming.then(async received => {
				await received.sendResp();

				return received;
			}),
			session.sendSms({ from: '46701113311', message, to: '46709771337' }),
		]);

		assert.equal(sms.message, message);

		session.close();
		await smpp.close();
	});

	test('marks a flash message without losing the UCS2 alphabet', async () => {
		const smpp = await startServer();
		const incoming = once<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});
		const { session } = await connect(smpp);

		assert.ok(session);

		const [sms] = await Promise.all([
			incoming.then(async received => {
				await received.sendResp();

				return received;
			}),
			session.sendSms({ flash: true, from: '46701113311', message: 'تست', to: '46709771337' }),
		]);

		// 0.4.0 forced data_coding to 0x10, which discards UCS2 and mangles the message.
		assert.equal(sms.pduObjs[0]?.params.data_coding, 0x18);
		assert.equal(sms.message, 'تست');
		assert.ok(sms.flash);

		session.close();
		await smpp.close();
	});
});

describe('delivery reports', () => {
	test('reaches the sender as a dlr event', async () => {
		const smpp = await startServer();
		const incoming = once<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});
		const { session } = await connect(smpp);

		assert.ok(session);

		const dlr = once<{ smsId: string; statusMsg: string }>(resolve => {
			session.on('dlr', resolve);
		});

		const [sms] = await Promise.all([
			incoming.then(async received => {
				received.smsId = 'dlr-id';
				await received.sendResp();

				return received;
			}),
			session.sendSms({ dlr: true, from: '46701113311', message: 'hi', to: '46709771337' }),
		]);

		assert.ok(sms.dlr);
		await sms.sendDlr();

		const report = await dlr;

		assert.equal(report.smsId, 'dlr-id');
		assert.equal(report.statusMsg, 'DELIVERED');

		session.close();
		await smpp.close();
	});

	test('reports a failure with the spec status code', async () => {
		const smpp = await startServer();
		const incoming = once<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});
		const { session } = await connect(smpp);

		assert.ok(session);

		const dlr = once<{ statusMsg: string }>(resolve => { session.on('dlr', resolve); });
		const raw = once<string>(resolve => {
			session.on('incomingPduObj', pduObj => {
				const message = pduObj.params.short_message;

				if (typeof message === 'string') resolve(message);
			});
		});

		const [sms] = await Promise.all([
			incoming.then(async received => {
				received.smsId = 'fail-id';
				await received.sendResp();

				return received;
			}),
			session.sendSms({ dlr: true, from: '46701113311', message: 'hi', to: '46709771337' }),
		]);

		await sms.sendDlr('UNDELIVERABLE');

		assert.equal((await dlr).statusMsg, 'UNDELIVERABLE');
		// 0.4.0 wrote stat:UNDELIVERABLE, which is not the spec's seven-character field.
		assert.match(await raw, /stat:UNDELIV /);

		session.close();
		await smpp.close();
	});
});

describe('a session captured from Kannel', () => {
	// Four parts of one message, esm_class 0x43 — the UDH indicator combined with store-and-forward,
	// which 0.4.0 originally compared with === 0x40 and missed.
	const parts = [
		'000000de00000004000000000000003000050074657374000201313233343500430000003136303630373136333031333030302b00000000009f0500030204014c6f72656d20497073756d2069732073696d706c792064756d6d792074657874206f6620746865207072696e74696e6720616e64207479706573657474696e6720696e6475737472792e204c6f72656d20497073756d20686173206265656e2074686520696e6475737472792773207374616e646172642064756d6d79207465787420657665722073696e6365207468652031353030732c200426000101',
		'000000de00000004000000000000003100050074657374000201313233343500430000003136303630373136333031333030302b00000000009f0500030204027768656e20616e20756e6b6e6f776e207072696e74657220746f6f6b20612067616c6c6579206f66207479706520616e6420736372616d626c656420697420746f206d616b65206120747970652073706563696d656e20626f6f6b2e20497420686173207375727669766564206e6f74206f6e6c7920666976652063656e7475726965732c2062757420616c736f20746865206c65617020690426000101',
		'000000de00000004000000000000003200050074657374000201313233343500430000003136303630373136333031333030302b00000000009f0500030204036e746f20656c656374726f6e6963207479706573657474696e672c2072656d61696e696e6720657373656e7469616c6c7920756e6368616e6765642e2049742077617320706f70756c61726973656420696e207468652031393630732077697468207468652072656c65617365206f66204c657472617365742073686565747320636f6e7461696e696e67204c6f72656d20497073756d20700426000101',
		'000000b200000004000000000000003300050074657374000201313233343500430000003136303630373136333031333030302b000000000078050003020404617373616765732c20616e64206d6f726520726563656e746c792077697468206465736b746f70207075626c697368696e6720736f667477617265206c696b6520416c64757320506167654d616b657220696e636c7564696e672076657273696f6e73206f66204c6f72656d20497073756d',
	];

	const expected = 'Lorem Ipsum is simply dummy text of the printing and typesetting industry. Lorem Ipsum has been the industry\'s standard dummy text ever since the 1500s, when an unknown printer took a galley of type and scrambled it to make a type specimen book. It has survived not only five centuries, but also the leap into electronic typesetting, remaining essentially unchanged. It was popularised in the 1960s with the release of Letraset sheets containing Lorem Ipsum passages, and more recently with desktop publishing software like Aldus PageMaker including versions of Lorem Ipsum';

	async function replay(order: number[]): Promise<Sms> {
		const smpp = await startServer();
		const incoming = once<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});

		const sock = net.connect({ port: smpp.port }, () => {
			sock.write(Buffer.from('0000002100000009000000000000002f666f6f0062617200736d70700034000000', 'hex'));
		});

		let bound = false;

		sock.on('data', () => {
			if (bound) return;

			bound = true;

			for (const index of order) {
				const part = parts[index];

				if (part !== undefined) sock.write(Buffer.from(part, 'hex'));
			}
		});

		const sms = await incoming;

		await sms.sendResp();
		sock.destroy();
		await smpp.close();

		return sms;
	}

	test('reassembles four segments arriving in order', async () => {
		assert.equal((await replay([0, 1, 2, 3])).message, expected);
	});

	test('reassembles the same four segments arriving out of order', async () => {
		assert.equal((await replay([1, 0, 3, 2])).message, expected);
	});
});

describe('robustness', () => {
	// 0.4.0 registered a listener per sequence number and waited forever, leaking one per call.
	test('gives up on a peer that never answers', async () => {
		const accepted: net.Socket[] = [];
		// resume() so the socket drains; an unread socket never notices the peer hanging up.
		const silent = net.createServer(sock => { accepted.push(sock); sock.resume(); });

		await new Promise<void>(resolve => silent.listen(0, resolve));

		const address = silent.address();
		const port = typeof address === 'object' && address !== null ? address.port : 0;
		const started = Date.now();
		const { err } = await client({ port, responseTimeout: 150 });

		assert.ok(err instanceof Error);
		assert.ok(Date.now() - started < 5000, 'should have given up quickly');

		for (const sock of accepted) sock.destroy();

		await new Promise<void>(resolve => silent.close(() => { resolve(); }));
	});

	test('stops a connection attempt on an aborted signal', async () => {
		const controller = new AbortController();

		controller.abort();

		const { err } = await client({ port: 1, signal: controller.signal });

		assert.ok(err instanceof Error);
	});

	test('reports a refused connection rather than throwing', async () => {
		const { err, session } = await client({ port: 1 });

		assert.ok(err instanceof Error);
		assert.equal(session, undefined);
	});

	test('keeps at most maxOutstanding requests on the wire', async () => {
		const smpp = await startServer();
		let concurrent = 0;
		let peak = 0;

		smpp.on('session', session => {
			session.on('sms', sms => {
				concurrent++;
				peak = Math.max(peak, concurrent);
				setTimeout(() => {
					concurrent--;
					void sms.sendResp();
				}, 10);
			});
		});

		const { session } = await connect(smpp, { maxOutstanding: 2 });

		assert.ok(session);

		await Promise.all(Array.from({ length: 8 }, (_, index) => session.sendSms({
			from: '46701113311',
			message: `message ${String(index)}`,
			to: '46709771337',
		})));

		assert.ok(peak <= 2, `peak was ${String(peak)}`);

		session.close();
		await smpp.close();
	});
});
