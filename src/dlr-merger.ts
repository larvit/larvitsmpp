import type { Dlr } from './dlr.ts';

export type MessageDlr = Dlr & { segments: Dlr[] };

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
export class DlrMerger {
	private readonly groups = new Map<string, Group>();

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
			this.groups.set(base, { expected: smsIds.length, parts: new Map() });
		}
	}

	/** The whole message's report, on the receipt that completes it. */
	collect(dlr: Dlr): MessageDlr | undefined {
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
		const worst = segments.reduce((carry, one) => (one.statusId > carry.statusId ? one : carry));

		return { ...worst, segments, smsId: base };
	}
}
