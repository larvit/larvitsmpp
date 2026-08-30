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

	/** Resolves once nothing is in flight, or on the timeout with how many still are. 0 never times out. */
	idle(timeout: number): Promise<number> {
		if (this.inFlight === 0) return Promise.resolve(0);

		return new Promise<number>(resolve => {
			let timer: NodeJS.Timeout | undefined = undefined;
			const done = (): void => {
				const index = this.waitingForIdle.indexOf(done);

				if (timer) clearTimeout(timer);
				if (index !== -1) this.waitingForIdle.splice(index, 1);

				resolve(this.inFlight);
			};

			if (timeout > 0) {
				timer = setTimeout(done, timeout);
				timer.unref();
			}

			this.waitingForIdle.push(done);
		});
	}
}
