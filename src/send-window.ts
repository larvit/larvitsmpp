/** Caps how many requests are on the wire at once; anything past the limit waits its turn. */
export class SendWindow {
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
	}
}
