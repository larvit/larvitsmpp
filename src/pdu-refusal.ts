import type { CommandName } from './defs/commands.ts';
import type { ErrorName } from './defs/errors.ts';
import { respNameFor } from './defs/commands.ts';

/** A hostile peer must not be able to make us allocate arbitrarily. */
export const maxPduLength = 1024 * 1024;

/** The 16 octets a framed PDU always has, whatever its body turns out to be. */
export type PduHeader = {
	cmdId: number;
	cmdLength: number;
	cmdName: CommandName | undefined;
	cmdStatusId: number;
	seqNr: number;
};

/** Which part of a PDU the codec could not read. */
export type PduRefusalReason = 'body' | 'command' | 'tlvs';

/** A PDU refused with the stream still in sync, so only this one PDU is lost. */
export class PduRefusedError extends Error {
	readonly header: PduHeader;
	readonly reason: PduRefusalReason;

	constructor(header: PduHeader, reason: PduRefusalReason, cause: Error) {
		const named = header.cmdName ?? `command id ${String(header.cmdId)}`;

		super(`Refused ${named} with seqNr ${String(header.seqNr)}: ${cause.message}`, { cause });
		this.header = header;
		this.name = 'PduRefusedError';
		this.reason = reason;
	}
}

// ESME_RINVTLVSTREAM is SMPP 5.0's name for 0xC0, which SMPP 3.4 spells ESME_RINVOPTPARSTREAM.
const refusalStatus = {
	body: 'ESME_RINVCMDLEN',
	command: 'ESME_RINVCMDID',
	tlvs: 'ESME_RINVTLVSTREAM',
} as const satisfies Record<PduRefusalReason, ErrorName>;

/** Why a command_length cannot frame a stream: past it nothing can say where the next PDU starts. */
export function framingRefusal(cmdLength: number): Error | undefined {
	if (cmdLength < 16 || cmdLength > maxPduLength) {
		return new Error(`Refusing a cmd_length of ${String(cmdLength)}`);
	}

	return undefined;
}

/** SMPP 3.4 4.3: a PDU whose command has no response of its own is refused with generic_nack. */
export function refusalAnswer(refused: PduRefusedError): { cmdName: CommandName; cmdStatus: ErrorName } {
	return {
		cmdName: respNameFor(refused.header.cmdName) ?? 'generic_nack',
		cmdStatus: refusalStatus[refused.reason],
	};
}
