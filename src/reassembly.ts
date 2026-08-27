import type { ConcatInfo } from './udh.ts';
import type { LogInt } from '@larvit/log';
import type { ParamValue } from './defs/types.ts';
import type { PduObject } from './pdu.ts';
import type { Tlv } from './defs/tlvs.ts';
import { ExpiringGroups } from './expiring-groups.ts';
import { decodeMessage } from './message.ts';
import { paramText } from './defs/types.ts';

export type ReassemblerOptions = {
	log: LogInt;
	max: number;
	maxOctets?: number | undefined;
	/** Injected so expiry can be exercised without a wall clock. */
	now?: (() => number) | undefined;
	timeout: number;
};

const defaultMaxOctets = 64 * 1024 * 1024;

type Group = {
	octets: number;
	parts: Map<number, PduObject>;
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

	return { ...pduObj, params, tlvs };
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
	private readonly groups: ExpiringGroups<Group>;
	private readonly log: LogInt;
	private readonly max: number;
	private readonly maxOctets: number;
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
	}

	get size(): number {
		return this.groups.size;
	}

	/** Every segment in order, on the one that completes the message; nothing while it is short. */
	collect(pduObj: PduObject, concat: ConcatInfo): PduObject[] | undefined {
		this.sweep();

		if (concat.part < 1 || concat.total < 1 || concat.part > concat.total) {
			this.log.warn('reassembler - dropping a segment the UDH numbers impossibly', {
				part: concat.part,
				total: concat.total,
			});

			return undefined;
		}

		const key = groupKey(pduObj, concat.reference);
		const group = this.groups.get(key) ?? this.open(key, concat.total);
		const replaced = group.parts.get(concat.part);
		const segment = detach(pduObj);
		const delta = octetsOf(segment) - (replaced === undefined ? 0 : octetsOf(replaced));

		group.parts.set(concat.part, segment);
		group.octets += delta;
		this.octets += delta;

		if (group.parts.size < group.total) {
			this.trim();

			return undefined;
		}

		this.groups.delete(key);
		this.octets -= group.octets;

		return [...group.parts.entries()].sort(([a], [b]) => a - b).map(([, part]) => part);
	}

	clear(): void {
		this.groups.clear();
		this.octets = 0;
	}

	/** Drops every group past its deadline. Runs before each collect and on its own timer. */
	sweep(): void {
		for (const [key, group] of this.groups.takeExpired()) {
			this.log.info('reassembler - incomplete message expired', { key, total: group.total });
			this.octets -= group.octets;
		}
	}

	private open(key: string, total: number): Group {
		if (this.groups.full) this.dropOldest();

		const group: Group = { octets: 0, parts: new Map(), total };

		this.groups.set(key, group);

		return group;
	}

	/** Drops the oldest groups until the retained payload is back under the octet cap. */
	private trim(): void {
		while (this.octets > this.maxOctets && this.groups.size > 0) {
			this.dropOldest();
		}
	}

	private dropOldest(): void {
		const oldest = this.groups.takeOldest();

		if (!oldest) return;

		const [, group] = oldest;

		this.log.warn('reassembler - buffer full, dropping the oldest message', {
			max: this.max,
			maxOctets: this.maxOctets,
			octets: this.octets,
		});
		this.octets -= group.octets;
	}
}
