import assert from 'node:assert/strict';
import net from 'node:net';
import type { PduObject } from '../src/pdu.ts';
import type { Session } from '../src/session.ts';
import type { TestContext } from 'node:test';
import { PduFramer } from '../src/pdu-framer.ts';
import { client } from '../src/client.ts';
import { closeAfter, closeListenerAfter } from './teardown.ts';
import { consts } from '../src/defs/constants.ts';
import { objToPdu, pduReturn, pduToObj } from '../src/pdu.ts';
import { uuidv7 } from '../src/uuid.ts';

export type DummySmsc = {
	/** Writes a delivery receipt to the ESME, its body spelled as the test names it. */
	deliver: (body: string) => void;
	/** Every submit_sm the ESME wrote, exactly as it arrived on the socket. */
	octets: Buffer[];
	port: number;
	submits: PduObject[];
};

export type DummySmscOptions = {
	/** The id each submit is answered with, in order; a spent list answers with none, as Telesign does. */
	messageIds?: readonly string[];
};

/**
 * An SMSC that answers every request the ESME sends and starts nothing of its own, so a test says
 * what the peer does by driving it rather than by configuring it. Where `server()` would do, use
 * that instead: this exists for the peers `server()` cannot be — one whose message ids the test
 * chooses, or one that answers a request differently from how this library would.
 */
export async function dummySmsc(t: TestContext, options: DummySmscOptions = {}): Promise<DummySmsc> {
	const octets: Buffer[] = [];
	const sockets: net.Socket[] = [];
	const submits: PduObject[] = [];
	let answered = 0;
	let delivered = 0;
	const listener = net.createServer(sock => {
		const framer = new PduFramer();

		sockets.push(sock);
		sock.on('data', chunk => {
			framer.push(chunk);

			for (const pdu of framer.next().pdus ?? []) {
				const { pduObj } = pduToObj(pdu);

				// A response answers nothing; the ESME's deliver_sm_resp is the one that arrives here.
				if (!pduObj || pduObj.cmdName.endsWith('_resp')) continue;

				if (pduObj.cmdName !== 'submit_sm') {
					const other = pduReturn(pduObj, 'ESME_ROK', { system_id: 'dummy' });

					if (other.buffer) sock.write(other.buffer);

					continue;
				}

				octets.push(pdu);
				submits.push(pduObj);

				const messageId = options.messageIds ? options.messageIds[answered++] ?? '' : uuidv7();
				const taken = pduReturn(pduObj, 'ESME_ROK', { message_id: messageId });

				if (taken.buffer) sock.write(taken.buffer);
			}
		});
	});

	closeListenerAfter(t, listener, sockets);
	await new Promise<void>(resolve => { listener.listen(0, resolve); });

	const address = listener.address();

	return {
		deliver: (body: string) => {
			const { buffer } = objToPdu({
				cmdName: 'deliver_sm',
				params: {
					destination_addr: '46701113311',
					esm_class: consts.ESM_CLASS.MC_DELIVERY_RECEIPT,
					short_message: body,
					source_addr: '46709771337',
				},
				seqNr: ++delivered,
			});

			assert.ok(buffer);
			sockets[sockets.length - 1]?.write(buffer);
		},
		octets,
		port: typeof address === 'object' && address !== null ? address.port : 0,
		submits,
	};
}

/** A client bound to one of the above, torn down with the test. */
export async function bindToSmsc(
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
