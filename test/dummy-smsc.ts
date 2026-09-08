import assert from 'node:assert/strict';
import net from 'node:net';
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
};

export type DummySmscOptions = {
	/** The id each submit is answered with, in order; a spent list answers with none, as Telesign does. */
	messageIds?: readonly string[];
};

/**
 * An SMSC that answers every request the ESME sends and starts nothing of its own. It exists for the
 * peers `server()` cannot be — one whose message ids the test chooses, or one that answers a request
 * differently from how this library would. A test that answers the peer's requests itself wants
 * `smscPeer()` in `session.test.ts` instead, which answers the bind and hands over the rest.
 */
export async function dummySmsc(t: TestContext, options: DummySmscOptions = {}): Promise<DummySmsc> {
	const octets: Buffer[] = [];
	const sockets: net.Socket[] = [];
	let answered = 0;
	let delivered = 0;
	const nextId = (): string => (options.messageIds ? options.messageIds[answered++] ?? '' : uuidv7());
	const listener = net.createServer(sock => {
		const framer = new PduFramer();

		sockets.push(sock);
		sock.on('data', chunk => {
			framer.push(chunk);

			for (const pdu of framer.next().pdus ?? []) {
				const { pduObj } = pduToObj(pdu);

				// A response answers nothing; the ESME's deliver_sm_resp is the one that arrives here.
				if (!pduObj || pduObj.cmdName.endsWith('_resp')) continue;

				// Only a submit takes an id from the list; a bind answered off it shifts every fixture.
				const answer = pduObj.cmdName === 'submit_sm'
					? pduReturn(pduObj, 'ESME_ROK', { message_id: nextId() })
					: pduReturn(pduObj, 'ESME_ROK', { system_id: 'dummy' });

				if (pduObj.cmdName === 'submit_sm') octets.push(pdu);

				// Writing nothing leaves the test waiting out its own timeout with nothing naming why.
				assert.ok(answer.buffer, `the dummy SMSC has no answer for ${pduObj.cmdName}`);
				sock.write(answer.buffer);
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
