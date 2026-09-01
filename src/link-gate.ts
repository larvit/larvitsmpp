import type { VoidResult } from './result.ts';

export type LinkGateOptions = {
	/** Whether the link can carry nothing right now. */
	isDown: () => boolean;
	/** How long a request may wait for a link. 0 waits for as long as one may still arrive. */
	timeout: number;
	/** Whether a link that is down will be brought back. */
	willReturn: () => boolean;
};

type Waiter = (result: VoidResult) => void;

function expired(): Error {
	return new Error('The link did not come back in time');
}

/** Where a request with no link to go out on waits for the next one. */
export class LinkGate {
	private readonly options: LinkGateOptions;
	private readonly waiting = new Set<Waiter>();

	constructor(options: LinkGateOptions) {
		this.options = options;
	}

	/** When a hold starting now has to give up. 0 never does. */
	deadline(): number {
		return this.options.timeout > 0 ? Date.now() + this.options.timeout : 0;
	}

	/** Resolves once a link can carry the request, or with the reason none ever will. */
	wait(deadline: number, signal: AbortSignal | undefined): Promise<VoidResult> {
		if (!this.options.isDown()) return Promise.resolve({});

		if (!this.options.willReturn()) return Promise.resolve({ err: new Error('Session is closed') });

		const left = deadline === 0 ? 0 : deadline - Date.now();

		if (deadline !== 0 && left <= 0) return Promise.resolve({ err: expired() });

		return this.hold(left, signal);
	}

	/** A link is up: everything held goes out on it. */
	open(): void {
		this.release({});
	}

	/** No link is coming, and this is why. */
	shut(err: Error): void {
		this.release({ err });
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
				settle({ err: new Error('Aborted while waiting for a link') });
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
