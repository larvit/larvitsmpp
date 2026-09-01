import type { VoidResult } from './result.ts';

export type LinkGateOptions = {
	now?: (() => number) | undefined;
	/** How long a request may wait for a link. 0 waits for as long as one may still arrive. */
	timeout: number;
};

type Waiter = (result: VoidResult) => void;

function aborted(): Error {
	return new Error('Aborted while waiting for a link');
}

function expired(): Error {
	return new Error('The link did not come back in time');
}

function over(): Error {
	return new Error('Session is closed');
}

/**
 * Where a request with no link to go out on waits for the next one. The owner reports what became of
 * the link; nothing here reads back into the owner to find out.
 */
export class LinkGate {
	private readonly now: () => number;
	private readonly timeout: number;
	private readonly waiting = new Set<Waiter>();
	private returning = false;
	private up = true;

	constructor(options: LinkGateOptions) {
		this.now = options.now ?? Date.now;
		this.timeout = options.timeout;
	}

	/** Whether a request can go out right now. A link that is attached but not yet bound cannot. */
	isUp(): boolean {
		return this.up;
	}

	/** When a hold starting now has to give up. 0 never does. */
	deadline(): number {
		return this.timeout > 0 ? this.now() + this.timeout : 0;
	}

	/** A link is up and bound: everything held goes out on it. */
	open(): void {
		this.up = true;
		this.returning = false;
		this.release({});
	}

	/** The link is gone. `returning` says whether another one is on its way. */
	shut(returning: boolean): void {
		this.up = false;
		this.returning = returning;

		if (!returning) this.release({ err: over() });
	}

	/** Resolves once a link can carry the request, or with the reason none ever will. */
	wait(deadline: number, signal: AbortSignal | undefined): Promise<VoidResult> {
		if (this.up) return Promise.resolve({});

		if (!this.returning) return Promise.resolve({ err: over() });

		if (signal?.aborted === true) return Promise.resolve({ err: aborted() });

		const left = deadline === 0 ? 0 : deadline - this.now();

		if (deadline !== 0 && left <= 0) return Promise.resolve({ err: expired() });

		return this.hold(left, signal);
	}

	private hold(left: number, signal: AbortSignal | undefined): Promise<VoidResult> {
		return new Promise<VoidResult>(resolve => {
			let timer: NodeJS.Timeout | undefined = undefined;
			const settle = (result: VoidResult): void => {
				if (timer) clearTimeout(timer);

				signal?.removeEventListener('abort', onAbort);
				this.waiting.delete(settle);
				resolve(result);
			};

			function onAbort(): void {
				settle({ err: aborted() });
			}

			if (left > 0) {
				timer = setTimeout(() => { settle({ err: expired() }); }, left);
				timer.unref();
			}

			signal?.addEventListener('abort', onAbort, { once: true });
			this.waiting.add(settle);
		});
	}

	private release(result: VoidResult): void {
		for (const settle of [...this.waiting]) {
			settle(result);
		}
	}
}
