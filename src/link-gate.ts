import type { SmppLog } from './log.ts';
import type { VoidResult } from './result.ts';

export type LinkGateOptions = {
	log: SmppLog;
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

/** Where a request with no link to go out on waits for the next one. */
export class LinkGate {
	private readonly log: SmppLog;
	private readonly now: () => number;
	private readonly timeout: number;
	private readonly waiting = new Set<Waiter>();
	private returning = false;
	private up = true;

	constructor(options: LinkGateOptions) {
		this.log = options.log;
		this.now = options.now ?? Date.now;
		this.timeout = options.timeout;
	}

	/** Whether a request can go out right now. A link that is attached but not yet bound cannot. */
	isUp(): boolean {
		return this.up;
	}

	/** Why the gate will never admit a request, or undefined while one may still get through. */
	refusal(): Error | undefined {
		return this.up || this.returning ? undefined : over();
	}

	/** One budget for a request, however many links it waits through. 0 never gives up. */
	hold(signal: AbortSignal | undefined): () => Promise<VoidResult> {
		const deadline = this.timeout > 0 ? this.now() + this.timeout : 0;

		return () => this.wait(deadline, signal);
	}

	/** A link is up and bound: everything held goes out on it. */
	open(): void {
		this.up = true;
		this.returning = false;

		if (this.waiting.size > 0) {
			this.log.verbose('linkGate - sending what was held for a link', { held: this.waiting.size });
		}

		this.release({});
	}

	/** The link is gone. `returning` says whether another one is on its way. */
	shut(returning: boolean): void {
		this.up = false;
		this.returning = returning;

		if (!returning) this.release({ err: over() });
	}

	/** Resolves once a link can carry the request, or with the reason none ever will. */
	private wait(deadline: number, signal: AbortSignal | undefined): Promise<VoidResult> {
		if (this.up) return Promise.resolve({});

		const refused = this.refusal();

		if (refused) return Promise.resolve({ err: refused });

		if (signal?.aborted === true) return Promise.resolve({ err: aborted() });

		const left = deadline === 0 ? 0 : deadline - this.now();

		if (deadline !== 0 && left <= 0) return Promise.resolve({ err: expired() });

		return this.waitForLink(left, signal);
	}

	private waitForLink(left: number, signal: AbortSignal | undefined): Promise<VoidResult> {
		this.log.verbose('linkGate - holding a request until a link is back', { timeout: left });

		return new Promise<VoidResult>(resolve => {
			let timer: NodeJS.Timeout | undefined = undefined;
			const settle = (result: VoidResult): void => {
				if (timer) clearTimeout(timer);

				signal?.removeEventListener('abort', onAbort);
				this.waiting.delete(settle);
				resolve(result);
			};
			const giveUp = (): void => {
				this.log.warn('linkGate - no link came back in time', { timeout: left });
				settle({ err: expired() });
			};

			function onAbort(): void {
				settle({ err: aborted() });
			}

			// Not unref()'d: a held request is awaited with no other handle, so the process would exit unsettled.
			if (left > 0) timer = setTimeout(giveUp, left);

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
