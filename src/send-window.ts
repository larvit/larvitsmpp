/** Caps how many requests are on the wire at once; anything past the limit waits its turn. */
export class SendWindow {
	private readonly limit: number;
	private readonly waiting: (() => void)[] = [];
	private readonly waitingForIdle: (() => void)[] = [];
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

		for (const resolve of this.waitingForIdle.splice(0)) {
			resolve();
		}
	}

	/** Everything the caller is still owed: on the wire, plus queued behind a full window. */
	unfinished(): number {
		return this.inFlight + this.waiting.length;
	}

	/**
	 * Resolves 0 once nothing is left, or with what still is when the timeout or the signal cuts the
	 * wait short. A timeout of 0 waits forever.
	 */
	idle(timeout: number, signal?: AbortSignal): Promise<number> {
		if (this.inFlight === 0) return Promise.resolve(0);

		if (signal?.aborted === true) return Promise.resolve(this.unfinished());

		return new Promise<number>(resolve => {
			let timer: NodeJS.Timeout | undefined = undefined;
			const done = (): void => {
				const index = this.waitingForIdle.indexOf(done);

				if (timer) clearTimeout(timer);
				if (index !== -1) this.waitingForIdle.splice(index, 1);

				signal?.removeEventListener('abort', done);
				resolve(this.unfinished());
			};

			if (timeout > 0) {
				timer = setTimeout(done, timeout);
				timer.unref();
			}

			signal?.addEventListener('abort', done, { once: true });
			this.waitingForIdle.push(done);
		});
	}
}
