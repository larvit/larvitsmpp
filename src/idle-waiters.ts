/** What is left of a budget, in the shape a wait takes it: 0 waits forever. */
export function leftOf(deadline: number): number {
	return deadline === 0 ? 0 : Math.max(1, deadline - Date.now());
}

/** Everything waiting for a count to fall to zero, and how such a wait is cut short. */
export class IdleWaiters {
	private readonly waiting: (() => void)[] = [];

	/** Wakes everything waiting, whatever the count reads now. */
	settle(): void {
		for (const resolve of this.waiting.splice(0)) {
			resolve();
		}
	}

	/**
	 * Resolves 0 once nothing is left, or with what still is when the timeout or the signal cuts the
	 * wait short. A timeout of 0 waits forever.
	 */
	wait(remaining: () => number, timeout: number, signal: AbortSignal | undefined): Promise<number> {
		if (remaining() === 0) return Promise.resolve(0);

		if (signal?.aborted === true) return Promise.resolve(remaining());

		return new Promise<number>(resolve => {
			let timer: NodeJS.Timeout | undefined = undefined;
			const done = (): void => {
				const index = this.waiting.indexOf(done);

				if (timer) clearTimeout(timer);
				if (index !== -1) this.waiting.splice(index, 1);

				signal?.removeEventListener('abort', done);
				resolve(remaining());
			};

			if (timeout > 0) {
				timer = setTimeout(done, timeout);
				timer.unref();
			}

			signal?.addEventListener('abort', done, { once: true });
			this.waiting.push(done);
		});
	}
}
