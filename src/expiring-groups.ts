export type ExpiringGroupsOptions = {
	max: number;
	/** Injected so expiry can be exercised without a wall clock. */
	now?: (() => number) | undefined;
	/** Runs on the sweeper's own timer; the owner reports whatever it takes out. */
	onSweep: () => void;
	timeout: number;
};

type Entry<T> = {
	deadline: number;
	group: T;
};

/**
 * A capped store of groups that expire. Nothing is dropped silently: the owner takes the expired
 * and the evicted out itself, so the accounting and the log line stay where the group is understood.
 */
export class ExpiringGroups<T> {
	private readonly entries = new Map<string, Entry<T>>();
	private readonly max: number;
	private readonly now: () => number;
	private readonly onSweep: () => void;
	private readonly timeout: number;
	private sweeper: NodeJS.Timeout | undefined;

	constructor(options: ExpiringGroupsOptions) {
		this.max = options.max;
		this.now = options.now ?? Date.now;
		this.onSweep = options.onSweep;
		this.timeout = options.timeout;
	}

	get full(): boolean {
		return this.entries.size >= this.max;
	}

	get size(): number {
		return this.entries.size;
	}

	get(key: string): T | undefined {
		return this.entries.get(key)?.group;
	}

	/** Starts the group's deadline, and the sweeper if this is the only group held. */
	set(key: string, group: T): void {
		this.entries.set(key, { deadline: this.now() + this.timeout, group });

		if (this.sweeper) return;

		this.sweeper = setInterval(() => { this.onSweep(); }, this.timeout);
		this.sweeper.unref();
	}

	delete(key: string): void {
		this.entries.delete(key);
		this.idle();
	}

	clear(): void {
		this.entries.clear();
		this.idle();
	}

	/** Removes every group past its deadline and hands them over. */
	takeExpired(): [string, T][] {
		const now = this.now();
		const taken: [string, T][] = [];

		for (const [key, entry] of this.entries) {
			if (entry.deadline > now) continue;

			taken.push([key, entry.group]);
			this.entries.delete(key);
		}

		this.idle();

		return taken;
	}

	/** Removes the group held longest and hands it over. Undefined means there was none. */
	takeOldest(): [string, T] | undefined {
		const oldest = this.entries.entries().next();

		if (oldest.done) return undefined;

		const [key, entry] = oldest.value;

		this.delete(key);

		return [key, entry.group];
	}

	private idle(): void {
		if (!this.sweeper || this.entries.size > 0) return;

		clearInterval(this.sweeper);
		this.sweeper = undefined;
	}
}
