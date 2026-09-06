import type { ConcatInfo } from './udh.ts';
import type { ParamValue } from './defs/types.ts';
import type { PduObject } from './pdu.ts';
import type { SmppLog } from './log.ts';
import type { Tlv } from './defs/tlvs.ts';
import { ExpiringGroups } from './expiring-groups.ts';
import { decodeMessage } from './message.ts';
import { paramNumber, paramText } from './defs/types.ts';
import { uuidv7 } from './uuid.ts';

/** A concatenated message given up on, whose segments the peer has already been answered for. */
export type LostGroup = {
	parts: number;
	reason: 'evicted' | 'expired' | 'linkGone';
	smsId: string;
	total: number;
};

export type ReassemblerOptions = {
	log: SmppLog;
	max: number;
	maxOctets?: number | undefined;
	/** Injected so the ids a group is answered with can be read back in a test. */
	newId?: (() => string) | undefined;
	/** Injected so expiry can be exercised without a wall clock. */
	now?: (() => number) | undefined;
	onLost: (lost: LostGroup) => void;
	timeout: number;
};

/** Why a segment was not kept: its header joins no message here, or the store had no room for it. */
export type Refusal = 'full' | 'unplaceable';

/** What a segment did to its group. */
export type Collected =
	| { kept: false; refusal: Refusal }
	| {
		kept: true;
		/** The id base the group's segments are answered with. */
		smsId: string;
		/** Every segment in order, on the one that completes the message. */
		whole?: PduObject[] | undefined;
	};

const defaultMaxOctets = 64 * 1024 * 1024;

type Group = {
	octets: number;
	parts: Map<number, PduObject>;
	smsId: string;
	total: number;
};

/** Wire reads hand back views, so retaining one segment would pin the whole PDU it arrived in. */
function detach(pduObj: PduObject): PduObject {
	const params: Record<string, ParamValue> = {};
	const tlvs: Record<string, Tlv> = {};

	for (const [name, value] of Object.entries(pduObj.params)) {
		params[name] = Buffer.isBuffer(value) ? Buffer.from(value) : value;
	}

	for (const [name, tlv] of Object.entries(pduObj.tlvs)) {
		tlvs[name] = Buffer.isBuffer(tlv.tagValue)
			? { ...tlv, tagValue: Buffer.from(tlv.tagValue) }
			: tlv;
	}

	// short_message holds the same octets wherever it was not decoded, so one copy covers both.
	const octets = Buffer.isBuffer(params.short_message)
		? params.short_message
		: pduObj.shortMessageOctets && Buffer.from(pduObj.shortMessageOctets);

	return { ...pduObj, params, shortMessageOctets: octets, tlvs };
}

// A cstring param arrives as a string, and source_addr alone can carry most of a 1 MiB PDU.
function sizeOf(value: unknown): number {
	if (Buffer.isBuffer(value)) return value.length;

	return typeof value === 'string' ? value.length : 0;
}

function octetsOf(pduObj: PduObject): number {
	let octets = 0;

	for (const value of Object.values(pduObj.params)) {
		octets += sizeOf(value);
	}

	for (const tlv of Object.values(pduObj.tlvs)) {
		octets += sizeOf(tlv.tagValue);
	}

	return octets;
}

function groupKey(pduObj: PduObject, reference: number): string {
	return [
		paramText(pduObj.params.source_addr),
		paramText(pduObj.params.destination_addr),
		String(reference),
	].join('_');
}

/** The text of a message, joining its segments in the order they were reassembled. */
export function decodeSegments(pduObjs: PduObject[]): string {
	let message = '';

	for (const pduObj of pduObjs) {
		const part = pduObj.params.short_message;

		message += Buffer.isBuffer(part)
			? decodeMessage(
				part,
				paramNumber(pduObj.params.data_coding, 0),
				paramNumber(pduObj.params.esm_class, 0),
			).message
			: paramText(part);
	}

	return message;
}

/** Holds the segments of incomplete multipart messages until they are whole, capped and expiring. */
export class Reassembler {
	private readonly groups: ExpiringGroups<Group>;
	private readonly log: SmppLog;
	private readonly max: number;
	private readonly maxOctets: number;
	private readonly newId: () => string;
	private readonly onLost: (lost: LostGroup) => void;
	private octets = 0;

	constructor(options: ReassemblerOptions) {
		this.groups = new ExpiringGroups<Group>({
			max: options.max,
			now: options.now,
			onSweep: () => { this.sweep(); },
			timeout: options.timeout,
		});
		this.log = options.log;
		this.max = options.max;
		this.maxOctets = options.maxOctets ?? defaultMaxOctets;
		this.newId = options.newId ?? uuidv7;
		this.onLost = options.onLost;
	}

	get size(): number {
		return this.groups.size;
	}

	/** The group the segment joined, and always an answer for it: an unanswered one stalls a peer. */
	collect(pduObj: PduObject, concat: ConcatInfo): Collected {
		this.sweep();

		const key = groupKey(pduObj, concat.reference);
		const existing = this.groups.get(key);

		if (!this.placeable(concat, existing)) return { kept: false, refusal: 'unplaceable' };

		const group = existing ?? this.open(key, concat.total);
		const replaced = group.parts.get(concat.part);
		const segment = detach(pduObj);
		const delta = octetsOf(segment) - (replaced === undefined ? 0 : octetsOf(replaced));

		group.parts.set(concat.part, segment);
		group.octets += delta;
		this.octets += delta;

		if (group.parts.size < group.total) {
			this.trim(key);

			// Its own arrival overran the octet cap, so the peer keeps it rather than being told we did.
			if (this.groups.get(key) !== group) return { kept: false, refusal: 'full' };

			return { kept: true, smsId: group.smsId };
		}

		this.groups.delete(key);
		this.octets -= group.octets;

		return {
			kept: true,
			smsId: group.smsId,
			whole: [...group.parts.entries()].sort(([a], [b]) => a - b).map(([, part]) => part),
		};
	}

	clear(): void {
		for (const [, group] of this.groups.takeAll()) {
			this.lost(group, 'linkGone');
		}

		this.octets = 0;
	}

	/** Drops every group past its deadline. Runs before each collect and on its own timer. */
	sweep(): void {
		for (const [, group] of this.groups.takeExpired()) {
			this.octets -= group.octets;
			this.lost(group, 'expired');
		}
	}

	/** Whether a segment's UDH can join a group at all: its own numbering, and the group's total. */
	private placeable(concat: ConcatInfo, existing: Group | undefined): boolean {
		if (concat.part < 1 || concat.total < 1 || concat.part > concat.total) {
			this.log.warn('reassembler - dropping a segment the UDH numbers impossibly', {
				part: concat.part,
				total: concat.total,
			});

			return false;
		}

		// Parts 1/2 and 2/3 would otherwise complete the stored two-part group as a truncated message.
		if (existing && existing.total !== concat.total) {
			this.log.warn('reassembler - dropping a segment with an inconsistent UDH total', {
				existingTotal: existing.total,
				part: concat.part,
				total: concat.total,
			});

			return false;
		}

		return true;
	}

	private open(key: string, total: number): Group {
		if (this.groups.full) this.dropOldest();

		const group: Group = { octets: 0, parts: new Map(), smsId: this.newId(), total };

		this.groups.set(key, group);

		return group;
	}

	/** Drops the oldest groups until the retained payload is back under the octet cap. */
	private trim(current: string): void {
		while (this.octets > this.maxOctets) {
			const oldest = this.takeOldest();

			if (!oldest) return;

			// The refused segment is in the group but stays with the peer, so it is none of the loss.
			const answered = oldest[0] === current ? oldest[1].parts.size - 1 : oldest[1].parts.size;

			if (answered > 0) this.lost(oldest[1], 'evicted', answered);
		}
	}

	private takeOldest(): [string, Group] | undefined {
		const oldest = this.groups.takeOldest();

		if (oldest) this.octets -= oldest[1].octets;

		return oldest;
	}

	private dropOldest(): void {
		const oldest = this.takeOldest();

		if (oldest) this.lost(oldest[1], 'evicted');
	}

	/** Its segments are answered, so the peer will not send them again: this is traffic gone. */
	private lost(group: Group, reason: LostGroup['reason'], parts = group.parts.size): void {
		const lost: LostGroup = { parts, reason, smsId: group.smsId, total: group.total };

		this.log.warn('reassembler - gave up a concatenated message', {
			...lost,
			max: this.max,
			maxOctets: this.maxOctets,
			octets: this.octets,
		});
		this.onLost(lost);
	}
}
