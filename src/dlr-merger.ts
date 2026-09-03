import type { Dlr } from './dlr.ts';
import type { MessageState } from './defs/constants.ts';
import type { SmppLog } from './log.ts';
import { ExpiringGroups } from './expiring-groups.ts';

export type MessageDlr = Dlr & { segments: Dlr[]; smsId: string };

export type DlrMergerOptions = {
	log: SmppLog;
	max: number;
	/** Injected so expiry can be exercised without a wall clock. */
	now?: (() => number) | undefined;
	timeout: number;
};

type Group = {
	expected: number;
	parts: Map<number, Dlr>;
};

const numbered = /^(.*)-(\d+)$/;

/**
 * MESSAGE_STATE is a flat enum, not a ranking — ACCEPTED is 6 where UNDELIVERABLE is 5 — so reducing
 * on the wire value reports a part-failed message as delivered. Rank it deliberately instead.
 */
const severity: Record<MessageState, number> = {
	DELIVERED: 0,
	ACCEPTED: 1,
	ENROUTE: 2,
	SCHEDULED: 3,
	SKIPPED: 4,
	UNKNOWN: 5,
	EXPIRED: 6,
	DELETED: 7,
	REJECTED: 8,
	UNDELIVERABLE: 9,
};

/**
 * Merges the per-segment receipts of a multipart message into one report, but only when the peer
 * numbered its ids `<base>-<n>` off one base — the convention this library's own server follows. An
 * SMSC that hands out unrelated ids per segment cannot be merged, so nothing is reported for it.
 * A base is merged at most once: a reused id cannot be told apart from a straggler, and a report the
 * peer marked intermediate is never counted — it would fill a slot before the real receipt arrives.
 */
export class DlrMerger {
	private readonly groups: ExpiringGroups<Group>;
	private readonly log: SmppLog;
	private readonly max: number;
	private readonly spent: ExpiringGroups<true>;

	constructor(options: DlrMergerOptions) {
		this.groups = new ExpiringGroups<Group>({
			max: options.max,
			now: options.now,
			onSweep: () => { this.sweep(); },
			timeout: options.timeout,
		});
		this.log = options.log;
		this.max = options.max;
		this.spent = new ExpiringGroups<true>({
			max: options.max,
			now: options.now,
			onSweep: () => { this.spent.takeExpired(); },
			timeout: options.timeout,
		});
	}

	get size(): number {
		return this.groups.size;
	}

	/** Registers the ids one multipart send got back, so their receipts can be merged. */
	expect(smsIds: string[]): void {
		if (smsIds.length < 2) return;

		const bases = new Set<string>();

		for (const smsId of smsIds) {
			const base = numbered.exec(smsId)?.[1];

			if (base === undefined || base === '') return;

			bases.add(base);
		}

		if (bases.size !== 1) return;

		for (const base of bases) {
			this.open(base, smsIds.length);
		}
	}

	/** The whole message's report, on the receipt that completes it. */
	collect(dlr: Dlr): MessageDlr | undefined {
		this.sweep();

		if (dlr.intermediate || dlr.smsId === undefined) return undefined;

		const match = numbered.exec(dlr.smsId);
		const base = match?.[1];
		const part = match?.[2];

		if (base === undefined || part === undefined) return undefined;

		const group = this.groups.get(base);

		if (!group) return undefined;

		group.parts.set(Number(part), dlr);

		if (group.parts.size < group.expected) return undefined;

		this.close(base);

		const segments = [...group.parts.entries()].sort(([a], [b]) => a - b).map(([, one]) => one);
		const worst = segments.reduce((carry, one) => (severity[one.statusMsg] > severity[carry.statusMsg] ? one : carry));

		return { ...worst, segments, smsId: base };
	}

	clear(): void {
		this.groups.clear();
		this.spent.clear();
	}

	/** Drops every group past its deadline. Runs before each collect and on its own timer. */
	sweep(): void {
		for (const [base, group] of this.groups.takeExpired()) {
			this.close(base);
			this.log.info('dlrMerger - incomplete receipts expired', { base, expected: group.expected });
		}
	}

	private open(base: string, expected: number): void {
		this.spent.takeExpired();

		if (this.groups.get(base) !== undefined || this.spent.get(base) === true) {
			this.close(base);
			this.log.info('dlrMerger - message id handed out again, leaving its receipts unmerged', { base });

			return;
		}

		if (this.groups.full) this.dropOldest();

		this.groups.set(base, { expected, parts: new Map() });
	}

	private close(base: string): void {
		this.groups.delete(base);
		this.spent.delete(base);

		if (this.spent.full) this.spent.takeOldest();

		this.spent.set(base, true);
	}

	private dropOldest(): void {
		const oldest = this.groups.takeOldest();

		if (!oldest) return;

		const [base] = oldest;

		this.close(base);
		this.log.warn('dlrMerger - buffer full, dropping the oldest message', { base, max: this.max });
	}
}
