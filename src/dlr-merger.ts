import type { Dlr } from './dlr.ts';
import type { MessageState } from './defs/constants.ts';
import type { LogInt } from '@larvit/log';
import { ExpiringGroups } from './expiring-groups.ts';

export type MessageDlr = Dlr & { segments: Dlr[] };

export type DlrMergerOptions = {
	log: LogInt;
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
 * Merges the per-segment receipts of a multipart message into one report, but only when the peer
 * numbered its ids `<base>-<n>` off one base — the convention this library's own server follows. An
 * SMSC that hands out unrelated ids per segment cannot be merged, so nothing is reported for it.
 */
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

function severityOf(dlr: Dlr): number {
	const ranked: Record<string, number | undefined> = severity;

	return ranked[dlr.statusMsg] ?? severity.UNKNOWN;
}

export class DlrMerger {
	private readonly groups: ExpiringGroups<Group>;
	private readonly log: LogInt;
	private readonly max: number;

	constructor(options: DlrMergerOptions) {
		this.groups = new ExpiringGroups<Group>({
			max: options.max,
			now: options.now,
			onSweep: () => { this.sweep(); },
			timeout: options.timeout,
		});
		this.log = options.log;
		this.max = options.max;
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

		const match = numbered.exec(dlr.smsId);
		const base = match?.[1];
		const part = match?.[2];

		if (base === undefined || part === undefined) return undefined;

		const group = this.groups.get(base);

		if (!group) return undefined;

		group.parts.set(Number(part), dlr);

		if (group.parts.size < group.expected) return undefined;

		this.groups.delete(base);

		const segments = [...group.parts.entries()].sort(([a], [b]) => a - b).map(([, one]) => one);
		const worst = segments.reduce((carry, one) => (severityOf(one) > severityOf(carry) ? one : carry));

		return { ...worst, segments, smsId: base };
	}

	clear(): void {
		this.groups.clear();
	}

	/** Drops every group past its deadline. Runs before each collect and on its own timer. */
	sweep(): void {
		for (const [base, group] of this.groups.takeExpired()) {
			this.log.info('dlrMerger - incomplete receipts expired', { base, expected: group.expected });
		}
	}

	private open(base: string, expected: number): void {
		if (this.groups.full) this.dropOldest();

		this.groups.set(base, { expected, parts: new Map() });
	}

	private dropOldest(): void {
		if (!this.groups.takeOldest()) return;

		this.log.warn('dlrMerger - buffer full, dropping the oldest message', { max: this.max });
	}
}
