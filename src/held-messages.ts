import type { PduObject } from './pdu.ts';
import type { SmppLog } from './log.ts';
import { ExpiringGroups } from './expiring-groups.ts';
import { IdleWaiters } from './idle-waiters.ts';

export type HeldMessagesOptions = {
	log: SmppLog;
	max: number;
	/** Injected so expiry can be exercised without a wall clock. */
	now?: (() => number) | undefined;
	timeout: number;
};

/** The peer's own sequence number, which is what our answer to this message will carry. */
function keyOf(pduObjs: PduObject[]): string | undefined {
	const first = pduObjs[0];

	return first ? String(first.seqNr) : undefined;
}

/** The messages handed to the application that it has not answered yet, held by their segments. */
export class HeldMessages {
	private readonly droppedWithLink = new WeakSet<PduObject[]>();
	private readonly held: ExpiringGroups<PduObject[]>;
	private readonly idleWaiters = new IdleWaiters();
	private readonly log: SmppLog;
	private readonly max: number;

	constructor(options: HeldMessagesOptions) {
		this.held = new ExpiringGroups({
			max: options.max,
			now: options.now,
			onSweep: () => { this.sweep(); },
			timeout: options.timeout,
		});
		this.log = options.log;
		this.max = options.max;
	}

	get size(): number {
		return this.held.size;
	}

	/** An application that answers no message at all may not grow this without end. */
	hold(pduObjs: PduObject[]): void {
		const key = keyOf(pduObjs);

		if (key === undefined) return;

		this.sweep();

		if (this.held.get(key)) {
			this.log.warn('heldMessages - replacing a message on a re-used sequence number', { seqNr: Number(key) });
		} else if (this.held.full) {
			this.dropOldest();
		}

		this.held.set(key, pduObjs);
	}

	/** Whether a drain is still waiting for this message to be answered. */
	has(pduObjs: PduObject[]): boolean {
		const key = keyOf(pduObjs);

		return key !== undefined && this.held.get(key) === pduObjs;
	}

	/** Whether this message's link went before it was answered, so no answer of ours correlates. */
	lostLink(pduObjs: PduObject[]): boolean {
		return this.droppedWithLink.has(pduObjs);
	}

	release(pduObjs: PduObject[]): void {
		const key = keyOf(pduObjs);

		// Identity, not the key: a wrapped sequence number must not release someone else's message.
		if (key === undefined || this.held.get(key) !== pduObjs) return;

		this.held.delete(key);
		this.settle();
	}

	/** Drops every message: their segments went with the link, so no answer of ours correlates now. */
	clear(): void {
		for (const [, pduObjs] of this.held.takeAll()) {
			this.droppedWithLink.add(pduObjs);
		}

		this.idleWaiters.settle();
	}

	/** Resolves 0 once every message has been answered, or with how many have not. */
	idle(timeout: number, signal: AbortSignal | undefined): Promise<number> {
		return this.idleWaiters.wait(() => this.held.size, timeout, signal);
	}

	private dropOldest(): void {
		const oldest = this.held.takeOldest();

		if (!oldest) return;

		const [seqNr] = oldest;

		this.log.warn('heldMessages - buffer full, dropping the oldest message', {
			max: this.max,
			seqNr: Number(seqNr),
		});
	}

	/** Drops every message past its deadline. Runs before each hold and on its own timer. */
	sweep(): void {
		const expired = this.held.takeExpired();

		if (expired.length === 0) return;

		this.log.warn('heldMessages - messages the application never answered', {
			messages: expired.length,
		});
		this.settle();
	}

	private settle(): void {
		if (this.held.size === 0) this.idleWaiters.settle();
	}
}
