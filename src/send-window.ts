import type { SmppLog } from './log.ts';
import type { VoidResult } from './result.ts';
import { IdleWaiters } from './idle-waiters.ts';

export type SendWindowOptions = {
	limit: number;
	log: SmppLog;
};

type Waiter = (result: VoidResult) => void;

function aborted(): Error {
	return new Error('Aborted while waiting for a send window slot');
}

/** Caps how many requests are on the wire at once; anything past the limit waits its turn. */
export class SendWindow {
	private readonly idleWaiters = new IdleWaiters();
	private readonly limit: number;
	private readonly log: SmppLog;
	private readonly waiting: Waiter[] = [];
	private inFlight = 0;

	constructor(options: SendWindowOptions) {
		this.limit = options.limit;
		this.log = options.log;
	}

	/** Resolves once a slot is the caller's, or with the reason it stopped waiting for one. */
	acquire(signal: AbortSignal | undefined): Promise<VoidResult> {
		if (this.inFlight < this.limit) {
			this.inFlight++;

			return Promise.resolve({});
		}

		if (signal?.aborted === true) return Promise.resolve({ err: aborted() });

		return this.queue(signal);
	}

	release(): void {
		const next = this.waiting.shift();

		if (next) {
			next({});

			return;
		}

		this.inFlight--;

		if (this.inFlight > 0) return;

		this.idleWaiters.settle();
	}

	/** Everything the caller is still owed: on the wire, plus queued behind a full window. */
	unfinished(): number {
		return this.inFlight + this.waiting.length;
	}

	/** Resolves 0 once nothing is left on the wire, or with what still is. */
	idle(timeout: number, signal: AbortSignal | undefined): Promise<number> {
		return this.idleWaiters.wait(() => this.unfinished(), timeout, signal);
	}

	/** A waiter leaves the queue as it settles, so release() can only hand a slot to one still in it. */
	private queue(signal: AbortSignal | undefined): Promise<VoidResult> {
		this.log.verbose('sendWindow - queueing a request behind a full window', {
			limit: this.limit,
			queued: this.waiting.length + 1,
		});

		return new Promise<VoidResult>(resolve => {
			const settle = (result: VoidResult): void => {
				const index = this.waiting.indexOf(settle);

				if (index !== -1) this.waiting.splice(index, 1);

				signal?.removeEventListener('abort', onAbort);
				resolve(result);
			};

			function onAbort(): void {
				settle({ err: aborted() });
			}

			signal?.addEventListener('abort', onAbort, { once: true });
			this.waiting.push(settle);
		});
	}
}
