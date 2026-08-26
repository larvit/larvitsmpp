import type { ConcatInfo } from './udh.ts';
import type { LogInt } from '@larvit/log';
import type { ParamValue } from './defs/types.ts';
import type { PduObject } from './pdu.ts';
import { decodeMessage } from './message.ts';
import { paramText } from './defs/types.ts';

export type ReassemblerOptions = {
	log: LogInt;
	max: number;
	/** Injected so expiry can be exercised without a wall clock. */
	now?: (() => number) | undefined;
	timeout: number;
};

type Group = {
	deadline: number;
	parts: Map<number, PduObject>;
	total: number;
};

function groupKey(pduObj: PduObject, reference: number): string {
	return [
		paramText(pduObj.params.source_addr),
		paramText(pduObj.params.destination_addr),
		String(reference),
	].join('_');
}

function numberOr(value: ParamValue | undefined, fallback: number): number {
	return typeof value === 'number' ? value : fallback;
}

/** The text of a message, joining its segments in the order they were reassembled. */
export function decodeSegments(pduObjs: PduObject[]): string {
	let message = '';

	for (const pduObj of pduObjs) {
		const part = pduObj.params.short_message;

		message += Buffer.isBuffer(part)
			? decodeMessage(
				part,
				numberOr(pduObj.params.data_coding, 0),
				numberOr(pduObj.params.esm_class, 0),
			).message
			: paramText(part);
	}

	return message;
}

/** Holds the segments of incomplete multipart messages until they are whole, capped and expiring. */
export class Reassembler {
	private readonly groups = new Map<string, Group>();
	private readonly log: LogInt;
	private readonly max: number;
	private readonly now: () => number;
	private readonly timeout: number;
	private sweeper: NodeJS.Timeout | undefined;

	constructor(options: ReassemblerOptions) {
		this.log = options.log;
		this.max = options.max;
		this.now = options.now ?? Date.now;
		this.timeout = options.timeout;
	}

	get size(): number {
		return this.groups.size;
	}

	/** Every segment in order, on the one that completes the message; nothing while it is short. */
	collect(pduObj: PduObject, concat: ConcatInfo): PduObject[] | undefined {
		this.sweep();

		const key = groupKey(pduObj, concat.reference);
		const group = this.groups.get(key) ?? this.open(key, concat.total);

		group.parts.set(concat.part, pduObj);

		if (group.parts.size < group.total) return undefined;

		this.groups.delete(key);
		this.idle();

		return [...group.parts.entries()].sort(([a], [b]) => a - b).map(([, part]) => part);
	}

	clear(): void {
		this.groups.clear();
		this.idle();
	}

	/** Drops every group past its deadline. Runs before each collect and on its own timer. */
	sweep(): void {
		const now = this.now();

		for (const [key, group] of this.groups) {
			if (group.deadline > now) continue;

			this.log.info('reassembler - incomplete message expired', { key, total: group.total });
			this.groups.delete(key);
		}

		this.idle();
	}

	private open(key: string, total: number): Group {
		if (this.groups.size >= this.max) this.dropOldest();

		const group: Group = { deadline: this.now() + this.timeout, parts: new Map(), total };

		this.groups.set(key, group);

		if (!this.sweeper) {
			this.sweeper = setInterval(() => { this.sweep(); }, this.timeout);
			this.sweeper.unref();
		}

		return group;
	}

	private dropOldest(): void {
		const oldest = this.groups.keys().next();

		if (oldest.done) return;

		this.log.warn('reassembler - buffer full, dropping the oldest message', { max: this.max });
		this.groups.delete(oldest.value);
	}

	private idle(): void {
		if (!this.sweeper || this.groups.size > 0) return;

		clearInterval(this.sweeper);
		this.sweeper = undefined;
	}
}
