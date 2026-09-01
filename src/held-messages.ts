import type { PduObject } from './pdu.ts';
import { IdleWaiters } from './idle-waiters.ts';

/** The messages handed to the application that it has not answered yet, held by their segments. */
export class HeldMessages {
	private readonly held = new Set<PduObject[]>();
	private readonly idleWaiters = new IdleWaiters();

	hold(pduObjs: PduObject[]): void {
		this.held.add(pduObjs);
	}

	release(pduObjs: PduObject[]): void {
		if (!this.held.delete(pduObjs)) return;

		if (this.held.size === 0) this.idleWaiters.settle();
	}

	/** Drops every message: their segments went with the link, so no answer of ours correlates now. */
	clear(): void {
		this.held.clear();
		this.idleWaiters.settle();
	}

	/** Resolves 0 once every message has been answered, or with how many have not. */
	idle(timeout: number, signal?: AbortSignal): Promise<number> {
		return this.idleWaiters.wait(() => this.held.size, timeout, signal);
	}
}
