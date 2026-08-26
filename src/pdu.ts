import type { CommandName, PduParams, PduParamsInput } from './defs/commands.ts';
import type { ErrorName } from './defs/errors.ts';
import type { ParamValue } from './defs/types.ts';
import type { Result } from './result.ts';
import type { Tlv } from './defs/tlvs.ts';
import { cmds, commandNameById, isCommandName } from './defs/commands.ts';
import { consts } from './defs/constants.ts';
import { decodeMessage, encodeMessage } from './message.ts';
import { detect, encodingByDataCoding } from './defs/encodings.ts';
import { errorNameById, errors, isErrorName } from './defs/errors.ts';
import { tlvDefault, tlvs, tlvsById } from './defs/tlvs.ts';

/** Sequence numbers are a 31-bit field; 0x7fffffff is reserved. */
export const maxSeqNr = 2147483646;

/** A hostile peer must not be able to make us allocate arbitrarily. */
export const maxPduLength = 1024 * 1024;

export type TlvInput = {
	/** Resolved from the record key; pass it for a tag the TLV table does not define. */
	tagId?: number | undefined;
	tagValue: ParamValue;
};

export type PduObjectInput<C extends CommandName = CommandName> = {
	cmdName: C;
	cmdStatus?: ErrorName;
	params?: PduParamsInput<C>;
	seqNr?: number;
	tlvs?: Record<string, TlvInput> | undefined;
};

/**
 * A parsed PDU. `params` is loosely typed because the command is only known at runtime — narrow it
 * with `isCommand()` to get the parameters of a specific command.
 */
export type PduObject = {
	cmdId: number;
	cmdLength: number;
	cmdName: CommandName;
	cmdStatus: ErrorName | undefined;
	cmdStatusId: number;
	params: Record<string, ParamValue>;
	seqNr: number;
	tlvs: Record<string, Tlv>;
};

export function isResp(pduObj: Pick<PduObject, 'cmdId'>): boolean {
	return pduObj.cmdId >= 0x80000000;
}

/**
 * Narrows a parsed PDU to one command, giving its parameters their real types. The parser fills
 * every parameter the command declares with the type that command declares, which is what makes
 * this sound.
 */
export function isCommand<C extends CommandName>(
	pduObj: PduObject,
	cmdName: C,
): pduObj is PduObject & { cmdName: C; params: PduParams<C> } {
	return pduObj.cmdName === cmdName;
}

function numberOr(value: ParamValue | undefined, fallback: number): number {
	return typeof value === 'number' ? value : fallback;
}

function tagIdOf(name: string, input: TlvInput): Result<{ tagId: number }> {
	const tagId = input.tagId ?? tlvs[name]?.id;

	if (tagId === undefined) {
		return { err: new Error(`TLV "${name}": unknown tag name, give it a tagId`) };
	}

	if (!Number.isInteger(tagId) || tagId < 0 || tagId > 0xFFFF) {
		return { err: new Error(`TLV "${name}": tagId ${String(tagId)} out of range 0-65535`) };
	}

	return { tagId };
}

function buildPdu(
	cmdName: CommandName,
	cmdStatus: ErrorName,
	seqNr: number,
	params: Record<string, ParamValue | undefined>,
	tlvs: Record<string, TlvInput> | undefined,
): Result<{ buffer: Buffer }> {
	const definition = cmds[cmdName];

	if (!definition) {
		return { err: new Error(`Invalid cmdName: ${JSON.stringify(cmdName)}`) };
	}

	if (!isErrorName(cmdStatus)) {
		return { err: new Error(`Invalid cmdStatus: ${JSON.stringify(cmdStatus)}`) };
	}

	if (!Number.isInteger(seqNr) || seqNr < 0 || seqNr > maxSeqNr) {
		return { err: new Error(`Invalid seqNr: ${JSON.stringify(seqNr)}`) };
	}

	const resolved = { ...params };
	const message = resolved.short_message;

	// A string short_message is encoded here, which also settles data_coding and sm_length.
	if (typeof message === 'string') {
		const dataCoding = resolved.data_coding;
		const encoding = typeof dataCoding === 'number'
			? encodingByDataCoding(dataCoding)
			: detect(message);
		const encoded = encodeMessage(message, encoding);

		resolved.short_message = encoded.buffer;
		resolved.sm_length = encoded.buffer.length;

		if (typeof dataCoding !== 'number') {
			resolved.data_coding = consts.ENCODING[encoded.encoding];
		}
	}

	const chunks: Buffer[] = [];

	for (const [name, type] of Object.entries(definition.params ?? {})) {
		const value = resolved[name] ?? type.default;
		const sized = type.size(value);

		if (sized.err) {
			return { err: new Error(`Parameter "${name}" of "${cmdName}": ${sized.err.message}`) };
		}

		const chunk = Buffer.alloc(sized.size);
		const written = type.write(value, chunk, 0);

		if (written.err) {
			return { err: new Error(`Parameter "${name}" of "${cmdName}": ${written.err.message}`) };
		}

		chunks.push(chunk);
	}

	for (const [name, tlv] of Object.entries(tlvs ?? {})) {
		const tag = tagIdOf(name, tlv);

		if (tag.err) return { err: tag.err };

		const type = tlvsById[tag.tagId]?.type ?? tlvDefault;
		const sized = type.size(tlv.tagValue);

		if (sized.err) {
			return { err: new Error(`TLV "${name}": ${sized.err.message}`) };
		}

		if (sized.size > 0xffff) {
			return { err: new Error(`TLV "${name}": ${String(sized.size)} octets overflow the two octet length`) };
		}

		const chunk = Buffer.alloc(sized.size + 4);

		chunk.writeUInt16BE(tag.tagId, 0);
		chunk.writeUInt16BE(sized.size, 2);

		const written = type.write(tlv.tagValue, chunk, 4);

		if (written.err) {
			return { err: new Error(`TLV "${name}": ${written.err.message}`) };
		}

		chunks.push(chunk);
	}

	const body = Buffer.concat(chunks);
	const header = Buffer.alloc(16);

	header.writeUInt32BE(body.length + 16, 0);
	header.writeUInt32BE(definition.id, 4);
	header.writeUInt32BE(errors[cmdStatus], 8);
	header.writeUInt32BE(seqNr, 12);

	return { buffer: Buffer.concat([header, body]) };
}

export function objToPdu<C extends CommandName>(obj: PduObjectInput<C>): Result<{ buffer: Buffer }> {
	return buildPdu(
		obj.cmdName,
		obj.cmdStatus ?? 'ESME_ROK',
		obj.seqNr ?? 1,
		{ ...obj.params },
		obj.tlvs,
	);
}

function parseTlvs(
	pdu: Buffer,
	start: number,
	cmdLength: number,
): Result<{ offset: number; tlvs: Record<string, Tlv> }> {
	const tlvs: Record<string, Tlv> = {};
	let offset = start;

	while (offset + 4 <= cmdLength) {
		const tagId = pdu.readUInt16BE(offset);
		const tagLength = pdu.readUInt16BE(offset + 2);

		if (offset + 4 + tagLength > cmdLength) {
			return { err: new Error(`TLV ${String(tagId)} runs past the end of the PDU`) };
		}

		const definition = tlvsById[tagId];
		const read = (definition?.type ?? tlvDefault).read(pdu, offset + 4, tagLength);

		if (read.err) return { err: read.err };

		tlvs[definition?.tag ?? tagId.toString()] = {
			tagId,
			tagName: definition?.tag,
			tagValue: read.value,
		};

		offset += 4 + tagLength;
	}

	return { offset, tlvs };
}

function parseOnce(pdu: Buffer, trailingNull: boolean): Result<{ aligned: boolean; pduObj: PduObject }> {
	const cmdLength = pdu.readUInt32BE(0);
	const cmdId = pdu.readUInt32BE(4);
	const cmdName = commandNameById(cmdId);

	if (!cmdName) {
		return { err: new Error(`Unknown PDU command id: ${String(cmdId)}`) };
	}

	const cmdStatusId = pdu.readUInt32BE(8);
	const seqNr = pdu.readUInt32BE(12);

	if (seqNr > maxSeqNr) {
		return { err: new Error(`Invalid seqNr, exceeds ${String(maxSeqNr)}: ${String(seqNr)}`) };
	}

	const params: Record<string, ParamValue> = {};
	let offset = 16;

	for (const [name, type] of Object.entries(cmds[cmdName]?.params ?? {})) {
		const read = type.read(pdu, offset, numberOr(params.sm_length, 0));

		if (read.err) {
			return { err: new Error(`Parameter "${name}" of "${cmdName}": ${read.err.message}`) };
		}

		params[name] = read.value;
		offset += read.bytesRead;

		if (name === 'short_message' && trailingNull) offset++;
	}

	const parsed = parseTlvs(pdu, offset, cmdLength);

	if (parsed.err) return { err: parsed.err };

	const message = params.short_message;
	const esmClass = numberOr(params.esm_class, 0);

	// A message carrying a UDH stays a buffer; the session needs the header intact to reassemble.
	if (Buffer.isBuffer(message) && (esmClass & consts.ESM_CLASS.UDH_INDICATOR) !== consts.ESM_CLASS.UDH_INDICATOR) {
		params.short_message = decodeMessage(message, numberOr(params.data_coding, 0)).message;
	}

	return {
		aligned: parsed.offset === cmdLength,
		pduObj: {
			cmdId,
			cmdLength,
			cmdName,
			cmdStatus: errorNameById(cmdStatusId),
			cmdStatusId,
			params,
			seqNr,
			tlvs: parsed.tlvs,
		},
	};
}

export function pduToObj(pdu: Buffer): Result<{ pduObj: PduObject }> {
	if (pdu.length < 16) {
		return { err: new Error(`PDU is too short, minimum is 16 octets, got ${String(pdu.length)}`) };
	}

	const cmdLength = pdu.readUInt32BE(0);

	if (cmdLength < 16 || cmdLength > maxPduLength) {
		return { err: new Error(`Refusing a cmd_length of ${String(cmdLength)}`) };
	}

	if (cmdLength > pdu.length) {
		return { err: new Error(`cmd_length ${String(cmdLength)} exceeds the ${String(pdu.length)} octets given`) };
	}

	const plain = parseOnce(pdu, false);

	if (!plain.err && plain.aligned) return { pduObj: plain.pduObj };

	// Some peers append a NULL octet after short_message; allow for it before giving up.
	const padded = parseOnce(pdu, true);

	if (!padded.err && padded.aligned) return { pduObj: padded.pduObj };
	if (!plain.err) return { pduObj: plain.pduObj };
	if (!padded.err) return { pduObj: padded.pduObj };

	return { err: plain.err };
}

export function pduReturn(
	pdu: Buffer | PduObject,
	status: ErrorName = 'ESME_ROK',
	params: Record<string, ParamValue> = {},
	tlvs?: Record<string, TlvInput>,
): Result<{ buffer: Buffer }> {
	if (Buffer.isBuffer(pdu)) {
		const parsed = pduToObj(pdu);

		return parsed.err ? { err: parsed.err } : pduReturn(parsed.pduObj, status, params, tlvs);
	}

	const respName = `${pdu.cmdName}_resp`;

	if (!isCommandName(respName)) {
		return { err: new Error(`"${pdu.cmdName}" has no response command`) };
	}

	const respParams: Record<string, ParamValue> = { ...params };

	// Fields the response shares with the request are echoed back unless the caller overrode them.
	for (const name of Object.keys(cmds[respName]?.params ?? {})) {
		const value = pdu.params[name];

		if (respParams[name] === undefined && value !== undefined) {
			respParams[name] = value;
		}
	}

	return buildPdu(respName, status, pdu.seqNr, respParams, tlvs);
}
