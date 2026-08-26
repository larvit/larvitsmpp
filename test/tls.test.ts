import assert from 'node:assert/strict';
import net from 'node:net';
import test, { describe } from 'node:test';
import type { Sms } from '../src/sms.ts';
import type { SmppServer } from '../src/server.ts';
import { Log } from '@larvit/log';
import { TLSSocket } from 'node:tls';
import { client } from '../src/client.ts';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { server } from '../src/server.ts';

const host = 'localhost';

const oids = {
	basicConstraints: Buffer.from('551d13', 'hex'),
	commonName: Buffer.from('550403', 'hex'),
	ecdsaWithSha256: Buffer.from('2a8648ce3d040302', 'hex'),
	subjectAltName: Buffer.from('551d11', 'hex'),
};

function derLength(length: number): Buffer {
	if (length < 0x80) return Buffer.from([length]);

	const bytes: number[] = [];

	for (let rest = length; rest > 0; rest = Math.floor(rest / 0x100)) {
		bytes.unshift(rest % 0x100);
	}

	return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, ...parts: Buffer[]): Buffer {
	const body = Buffer.concat(parts);

	return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

function derBoolean(value: boolean): Buffer {
	return der(0x01, Buffer.from([value ? 0xff : 0x00]));
}

function derName(commonName: string): Buffer {
	return der(0x30, der(0x31, der(0x30,
		der(0x06, oids.commonName),
		der(0x0c, Buffer.from(commonName, 'utf8')),
	)));
}

function derExtension(id: Buffer, critical: boolean, value: Buffer): Buffer {
	return der(0x30, der(0x06, id), ...(critical ? [derBoolean(true)] : []), der(0x04, value));
}

function derUtcTime(date: Date): Buffer {
	const text = date.toISOString().replace(/[-:T]/g, '').replace(/\.\d{3}/, '').slice(2);

	return der(0x17, Buffer.from(text, 'ascii'));
}

function toPem(label: string, contents: Buffer): string {
	const lines = contents.toString('base64').match(/.{1,64}/g) ?? [];

	return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

// Built here rather than shelled out or committed: the image has no openssl, and a fixture key in a
// public repository leaks.
function createCertificate(): { cert: string; key: string } {
	const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
	const algorithm = der(0x30, der(0x06, oids.ecdsaWithSha256));
	const serial = randomBytes(8);
	const now = Date.now();

	serial.writeUInt8((serial.readUInt8(0) & 0x3f) | 0x40, 0);

	// RFC 5280 TBSCertificate — field order is wire order, never sort it.
	const tbs = der(0x30,
		der(0xa0, der(0x02, Buffer.from([0x02]))),
		der(0x02, serial),
		algorithm,
		derName(host),
		der(0x30, derUtcTime(new Date(now - 60_000)), derUtcTime(new Date(now + 3_600_000))),
		derName(host),
		publicKey.export({ format: 'der', type: 'spki' }),
		der(0xa3, der(0x30,
			derExtension(oids.basicConstraints, true, der(0x30, derBoolean(true))),
			derExtension(oids.subjectAltName, false, der(0x30, der(0x82, Buffer.from(host, 'ascii')))),
		)),
	);
	const certificate = der(0x30,
		tbs,
		algorithm,
		der(0x03, Buffer.from([0x00]), sign('sha256', tbs, privateKey)),
	);
	const key = privateKey.export({ format: 'pem', type: 'pkcs8' });

	return {
		cert: toPem('CERTIFICATE', certificate),
		key: typeof key === 'string' ? key : key.toString('utf8'),
	};
}

const certificate = createCertificate();

async function startServer(): Promise<SmppServer> {
	const { err, server: smpp } = await server({
		port: 0,
		tls: { cert: certificate.cert, key: certificate.key },
	});

	assert.equal(err, undefined);
	assert.ok(smpp);

	return smpp;
}

function once<T>(register: (resolve: (value: T) => void) => void): Promise<T> {
	return new Promise<T>(resolve => { register(resolve); });
}

describe('tls', () => {
	test('binds over a verified handshake and delivers an SMS', async () => {
		const smpp = await startServer();
		const incoming = once<Sms>(resolve => {
			smpp.on('session', session => session.on('sms', resolve));
		});
		const { err, session } = await client({
			host,
			port: smpp.port,
			tls: { ca: certificate.cert },
		});

		assert.equal(err, undefined);
		assert.ok(session);
		assert.ok(session.loggedIn);

		const sock = session.sock;

		assert.ok(sock instanceof TLSSocket);
		assert.ok(sock.authorized);
		assert.equal(sock.getPeerCertificate().subject.CN, host);

		const [sms, sent] = await Promise.all([
			incoming.then(async received => {
				received.smsId = 'tls-id';
				await received.sendResp();

				return received;
			}),
			session.sendSms({ from: 'MyBrand', message: 'hello over tls', to: '46709771337' }),
		]);

		assert.equal(sms.message, 'hello over tls');
		assert.equal(sms.to, '46709771337');
		assert.equal(sent.err, undefined);
		assert.deepEqual(sent.smsIds, ['tls-id']);

		assert.deepEqual(await session.unbind(), {});
		await smpp.close();
	});

	test('returns an error rather than throwing when the certificate is not trusted', async () => {
		const smpp = await startServer();
		const { err, session } = await client({ host, port: smpp.port, tls: {} });

		assert.ok(err instanceof Error);
		assert.match(err.message, /self.signed certificate/);
		assert.equal(session, undefined);

		await smpp.close();
	});

	test('returns an error when the certificate does not cover the host', async () => {
		const smpp = await startServer();
		const { err, session } = await client({
			host: '127.0.0.1',
			port: smpp.port,
			tls: { ca: certificate.cert },
		});

		assert.ok(err instanceof Error);
		assert.match(err.message, /altnames/);
		assert.equal(session, undefined);

		await smpp.close();
	});

	test('refuses to listen over tls without a certificate', async () => {
		const { err, server: smpp } = await server({ port: 0, tls: true });

		assert.ok(err instanceof Error);
		assert.equal(smpp, undefined);
	});

	test('logs a handshake the server turned away', async () => {
		const warned = once<string>(resolve => {
			const log = new Log({ logLevel: 'warn', stderr: resolve, stdout: resolve });

			void server({ log, port: 0, tls: { cert: certificate.cert, key: certificate.key } })
				.then(({ server: smpp }) => {
					assert.ok(smpp);

					const sock = net.connect({ port: smpp.port }, () => {
						sock.end('not a client hello');
					});

					sock.on('close', () => { void smpp.close(); });
					sock.resume();
				});
		});

		assert.match(await warned, /client handshake failed/);
	});
});
