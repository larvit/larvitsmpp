/**
 * Just enough of the reference implementation (farhadi/node-smpp) to cross-check the wire format.
 * It ships no types of its own and is a dev dependency only.
 */
declare module 'smpp' {
	type ReferencePdu = {
		command: string;
		command_status: number;
		data_coding?: number;
		destination_addr?: string;
		esm_class?: number;
		interface_version?: number;
		message_id?: string;
		message_state?: number;
		password?: string;
		receipted_message_id?: string;
		sequence_number: number;
		short_message?: { message: Buffer | string };
		source_addr?: string;
		system_id?: string;
		toBuffer: () => Buffer;
	};

	type ReferenceSession = {
		bind_transceiver: (options: Record<string, unknown>, cb: (pdu: ReferencePdu) => void) => void;
		bind_transceiver_resp: (options: Record<string, unknown>) => void;
		close: () => void;
		on: (event: string, listener: (pdu: ReferencePdu) => void) => void;
		submit_sm: (options: Record<string, unknown>, cb?: (pdu: ReferencePdu) => void) => void;
		submit_sm_resp: (options: Record<string, unknown>) => void;
	};

	type ReferenceServer = {
		address: () => { port: number } | null;
		close: (cb?: () => void) => void;
		listen: (port: number, cb?: () => void) => void;
	};

	const smpp: {
		PDU: {
			new (command: string, fields?: Record<string, unknown>): ReferencePdu;
			fromBuffer: (buffer: Buffer) => ReferencePdu | false;
		};
		connect: (options: Record<string, unknown>, cb?: () => void) => ReferenceSession;
		createServer: (
			options: Record<string, unknown>,
			handler: (session: ReferenceSession) => void,
		) => ReferenceServer;
	};

	export default smpp;
	export type { ReferencePdu, ReferenceServer, ReferenceSession };
}
