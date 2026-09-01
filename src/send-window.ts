import { IdleWaiters } from './idle-waiters.ts';

/** Caps how many requests are on the wire at once; anything past the limit waits its turn. */
export class SendWindow {
	private readonly idleWaiters = new IdleWaiters();
	private readonly limit: number;
	private readonly waiting: (() => void)[] = [];
	private inFlight = 0;

	constructor(limit: number) {
		this.limit = limit;
	}

	acquire(): Promise<void> {
		if (this.inFlight < this.limit) {
			this.inFlight++;

			return Promise.resolve();
		}

		return new Promise<void>(resolve => this.waiting.push(resolve));
	}

	release(): void {
		const next = this.waiting.shift();

		if (next) {
			next();

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
	idle(timeout: number, signal?: AbortSignal): Promise<number> {
		return this.idleWaiters.wait(() => this.unfinished(), timeout, signal);
	}
}
