import type { PduObject, PduObjectInput } from './pdu.ts';
import type { PduTransport } from './pdu-transport.ts';
import type { Result, VoidResult } from './result.ts';
import type { SendOptions } from './session-options.ts';
import type { SmppLog } from './log.ts';
import { LinkGate } from './link-gate.ts';
import { PendingRequests } from './pending-requests.ts';
import { SendWindow } from './send-window.ts';
import { UnansweredError } from './unanswered-error.ts';
import { bindCommands } from './session-options.ts';
import { objToPdu } from './pdu.ts';

export type OutgoingRequestsOptions = {
	log: SmppLog;
	maxOutstanding: number;
	responseTimeout: number;
	transport: PduTransport;
};

/** `retryOnNextLink`: the write failed, so nothing reached the socket and another link may carry it. */
type Attempt = { result: Result<{ pduObj: PduObject }>; retryOnNextLink: boolean };

function abortedBeforeSend(): Error {
	return new Error('Aborted before the request was sent');
}

/** A response carries the request's sequence number, which only sendReturn() has. */
function misuse(input: PduObjectInput): Error | undefined {
	return input.cmdName.endsWith('_resp')
		? new Error(`Use sendReturn() for responses, not send(): ${input.cmdName}`)
		: undefined;
}

/** Everything this end asks of the peer: which link carries it, how many at once, and the answer. */
export class OutgoingRequests {
	private readonly gate: LinkGate;
	private readonly log: SmppLog;
	private readonly pending: PendingRequests;
	private readonly responseTimeout: number;
	private readonly transport: PduTransport;
	private readonly window: SendWindow;

	private draining = false;

	constructor(options: OutgoingRequestsOptions) {
		this.gate = new LinkGate({ log: options.log, timeout: options.responseTimeout });
		this.log = options.log;
		this.pending = new PendingRequests(options.log);
		this.responseTimeout = options.responseTimeout;
		this.transport = options.transport;
		this.window = new SendWindow(options.maxOutstanding);
	}

	/** Read through a method: a drop can land while a request is awaiting. */
	linkDown(): boolean {
		return !this.gate.isUp() || this.transport.sock.destroyed;
	}

	/** A link is up and bound, so everything held for one goes out on it. */
	linkUp(): void {
		this.gate.open();
	}

	/** The link is gone; `returning` says whether another one is on its way. */
	linkLost(returning: boolean): void {
		this.gate.shut(returning);
		this.pending.settleAll(new Error('Session closed before a response arrived'));
	}

	/** Hands a response to the request waiting for it. False means nothing was. */
	deliver(pduObj: PduObject): boolean {
		return this.pending.deliver(pduObj);
	}

	/** A response the codec refused settles its request instead of leaving it to time out. */
	settleRefused(seqNr: number, err: Error): void {
		this.pending.settle(seqNr, { err });
	}

	/** Sends a request and resolves with the peer's response. */
	request(input: PduObjectInput, options: SendOptions): Promise<Result<{ pduObj: PduObject }>> {
		// Ahead of the drain, so a misuse is named as one rather than blamed on the shutdown.
		const wrong = misuse(input);

		if (wrong) return Promise.resolve({ err: wrong });

		// A drain on a live link. A link that is down is the gate's answer, which says closed instead.
		if (this.draining && !this.linkDown()) {
			return Promise.resolve({ err: new Error('Session is shutting down') });
		}

		return this.pastDrain(input, options);
	}

	/** The same path without that refusal, which a receipt for a held message has to take. */
	async pastDrain(
		input: PduObjectInput,
		options: SendOptions,
	): Promise<Result<{ pduObj: PduObject }>> {
		const refused = this.refuse(input, options);

		if (refused) return { err: refused };

		// A bind is what makes a link usable, so it cannot wait for one: it takes the gate's answer now.
		if (bindCommands.includes(input.cmdName)) {
			const shut = this.gate.refusal();

			return shut ? { err: shut } : this.now(input, options);
		}

		const waitForLink = this.gate.hold(options.signal);

		for (;;) {
			const held = await waitForLink();

			if (held.err) return { err: held.err };

			await this.window.acquire();

			const attempt = await this.attempt(input, options).finally(() => { this.window.release(); });

			// Nothing reached the socket, so the next link carries it instead of the caller resending.
			if (!attempt.retryOnNextLink || this.gate.isUp() || this.gate.refusal()) return attempt.result;
		}
	}

	/** Past the gate, the window and a drain, for what has to go out either way. */
	async now(input: PduObjectInput, options: SendOptions = {}): Promise<Result<{ pduObj: PduObject }>> {
		return (await this.attempt(input, options)).result;
	}

	/** Refuses every request from here on, on a link that is already down as much as a live one. */
	stopAccepting(): void {
		this.draining = true;
	}

	/** Waits out the requests already on the wire, and says how many never finished. */
	async drain(timeout: number, signal: AbortSignal | undefined): Promise<VoidResult> {
		const unfinished = await this.window.idle(timeout, signal);

		if (unfinished === 0) return {};

		this.log.warn('outgoingRequests - shutting down with requests unfinished', { timeout, unfinished });

		return { err: new Error(`Shut down with ${String(unfinished)} request(s) unfinished`) };
	}

	/** Why a request cannot go out at all, as opposed to not yet. */
	private refuse(input: PduObjectInput, options: SendOptions): Error | undefined {
		// Before the gate and the window, or an aborted call waits for what it will never use.
		return misuse(input) ?? (options.signal?.aborted === true ? abortedBeforeSend() : undefined);
	}

	private async attempt(input: PduObjectInput, options: SendOptions): Promise<Attempt> {
		// pending.wait() alone settles the caller while the request still goes out to the peer.
		if (options.signal?.aborted === true) {
			return { result: { err: abortedBeforeSend() }, retryOnNextLink: false };
		}

		const seqNr = this.pending.nextSeqNr();
		const built = objToPdu({ ...input, seqNr });

		if (built.err) return { result: { err: built.err }, retryOnNextLink: false };

		const response = this.pending.wait(seqNr, {
			signal: options.signal,
			timeout: this.responseTimeout,
		});
		const written = this.transport.write(built.buffer);

		if (written.err) {
			this.pending.settle(seqNr, { err: written.err });

			return { result: { err: written.err }, retryOnNextLink: true };
		}

		const answered = await response;

		// It went out, so a failure now means the peer may have taken it and the answer was the loss.
		return { result: answered.err ? { err: new UnansweredError(answered.err) } : answered, retryOnNextLink: false };
	}
}
