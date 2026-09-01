import type { PduObject } from './pdu.ts';
import type { Result } from './result.ts';
import type { SmppLog } from './log.ts';
import { maxSeqNr } from './pdu.ts';

export type WaitOptions = {
	signal?: AbortSignal | undefined;
	timeout: number;
};

type Pending = {
	settle: (result: Result<{ pduObj: PduObject }>) => void;
};

/** Hands out sequence numbers and matches responses to the requests waiting for them. */
export class PendingRequests {
	private readonly log: SmppLog;
	private readonly pending = new Map<number, Pending>();
	private ourSeqNr = 1;

	constructor(log: SmppLog) {
		this.log = log;
	}

	nextSeqNr(): number {
		const seqNr = this.ourSeqNr;

		this.ourSeqNr = this.ourSeqNr >= maxSeqNr ? 1 : this.ourSeqNr + 1;

		return seqNr;
	}

	wait(seqNr: number, options: WaitOptions): Promise<Result<{ pduObj: PduObject }>> {
		const { signal, timeout } = options;

		return new Promise(resolve => {
			const abort = (): void => {
				this.settle(seqNr, { err: new Error('Aborted before a response arrived') });
			};
			const timer = timeout > 0 ? this.expire(seqNr, timeout) : undefined;

			this.pending.set(seqNr, {
				settle: result => {
					if (timer) clearTimeout(timer);

					signal?.removeEventListener('abort', abort);
					this.pending.delete(seqNr);
					resolve(result);
				},
			});

			if (signal?.aborted === true) abort();
			else signal?.addEventListener('abort', abort, { once: true });
		});
	}

	/** Hands a response to whoever is waiting for it. False means nobody was. */
	deliver(pduObj: PduObject): boolean {
		const pending = this.pending.get(pduObj.seqNr);

		if (!pending) return false;

		pending.settle({ pduObj });

		return true;
	}

	settle(seqNr: number, result: Result<{ pduObj: PduObject }>): void {
		this.pending.get(seqNr)?.settle(result);
	}

	settleAll(err: Error): void {
		for (const [seqNr] of this.pending) {
			this.settle(seqNr, { err });
		}
	}

	private expire(seqNr: number, timeout: number): NodeJS.Timeout {
		const timer = setTimeout(() => {
			this.log.warn('pendingRequests - no response before the timeout', { seqNr, timeout });
			this.settle(seqNr, { err: new Error(`No response to seqNr ${String(seqNr)}`) });
		}, timeout);

		timer.unref();

		return timer;
	}
}
