package smpp.interop.jsmpp;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * A hand-rolled SMPP encoder over a plain socket, for the malformed PDUs jsmpp's own typed API
 * cannot construct (target 1: unknown command id, a truncated TLV stream, a body shorter than it
 * declares). Only what these scenarios need - a bind and the malformed shapes - not a real client.
 */
final class RawSmpp {
	private RawSmpp() { }

	private static void u8(ByteArrayOutputStream out, int v) {
		out.write(v & 0xFF);
	}

	private static void u32(ByteArrayOutputStream out, long v) {
		out.write((int) ((v >> 24) & 0xFF));
		out.write((int) ((v >> 16) & 0xFF));
		out.write((int) ((v >> 8) & 0xFF));
		out.write((int) (v & 0xFF));
	}

	private static void cstring(ByteArrayOutputStream out, String s) {
		if (s != null && !s.isEmpty()) out.writeBytes(s.getBytes(StandardCharsets.ISO_8859_1));
		out.write(0);
	}

	private static byte[] pdu(int cmdId, int status, int seqNr, byte[] body) {
		ByteArrayOutputStream out = new ByteArrayOutputStream();
		u32(out, 16L + body.length);
		u32(out, cmdId);
		u32(out, status);
		u32(out, seqNr);
		out.writeBytes(body);
		return out.toByteArray();
	}

	static byte[] bindTransceiverPdu(String systemId, String password, int interfaceVersion, int seqNr) {
		ByteArrayOutputStream body = new ByteArrayOutputStream();
		cstring(body, systemId);
		cstring(body, password);
		cstring(body, "");
		u8(body, interfaceVersion);
		u8(body, 0);
		u8(body, 0);
		cstring(body, "");
		return pdu(0x00000009, 0, seqNr, body.toByteArray());
	}

	/** command_id 0x00050001 names no SMPP 3.4 command - an empty body is a well-framed PDU. */
	static byte[] unknownCommandPdu(int seqNr) {
		return pdu(0x00050001, 0, seqNr, new byte[0]);
	}

	/**
	 * A deliver_sm whose mandatory fields are all present and correct, followed by one TLV header
	 * whose declared length (200) runs past cmd_length - the codec's parseTlvs() refuses this with
	 * reason 'tlvs'.
	 */
	static byte[] truncatedTlvDeliverSmPdu(int seqNr) {
		ByteArrayOutputStream body = deliverSmMandatory("raw-from", "raw-to", "truncated tlv probe");
		// Tag 0x001D (any tag id serves), declared length 200, only 4 value octets actually follow.
		// A full 8-byte tail (not a bare 4-byte header) so the codec's trailing-NUL retry - which
		// shifts the TLV region by one octet looking for a padded short_message - still finds an
		// overrunning length rather than silently swallowing an unparsed remainder as alignment slack.
		body.write(0x00);
		body.write(0x1D);
		body.write(0x00);
		body.write(0xC8);
		body.write(0x41);
		body.write(0x41);
		body.write(0x41);
		body.write(0x41);
		return pdu(0x00000005, 0, seqNr, body.toByteArray());
	}

	/** A deliver_sm whose sm_length declares 200 octets while only 5 are actually present. */
	static byte[] shortBodyDeliverSmPdu(int seqNr) {
		ByteArrayOutputStream body = new ByteArrayOutputStream();
		cstring(body, "");
		u8(body, 0);
		u8(body, 0);
		cstring(body, "raw-from");
		u8(body, 0);
		u8(body, 0);
		cstring(body, "raw-to");
		u8(body, 0);
		u8(body, 0);
		u8(body, 0);
		cstring(body, "");
		cstring(body, "");
		u8(body, 0);
		u8(body, 0);
		u8(body, 0);
		u8(body, 0);
		u8(body, 200); // sm_length declares 200 octets
		body.writeBytes("short".getBytes(StandardCharsets.ISO_8859_1)); // only 5 actually follow
		return pdu(0x00000005, 0, seqNr, body.toByteArray());
	}

	static byte[] enquireLinkPdu(int seqNr) {
		return pdu(0x00000015, 0, seqNr, new byte[0]);
	}

	private static ByteArrayOutputStream deliverSmMandatory(String from, String to, String text) {
		ByteArrayOutputStream body = new ByteArrayOutputStream();
		cstring(body, "");
		u8(body, 0);
		u8(body, 0);
		cstring(body, from);
		u8(body, 0);
		u8(body, 0);
		cstring(body, to);
		u8(body, 0);
		u8(body, 0);
		u8(body, 0);
		cstring(body, "");
		cstring(body, "");
		u8(body, 0);
		u8(body, 0);
		u8(body, 0);
		u8(body, 0);
		byte[] textBytes = text.getBytes(StandardCharsets.ISO_8859_1);
		u8(body, textBytes.length);
		body.writeBytes(textBytes);
		return body;
	}

	static void write(Socket sock, byte[] pdu) throws IOException {
		OutputStream out = sock.getOutputStream();
		out.write(pdu);
		out.flush();
	}

	/** Reads exactly one PDU (command_length-framed) and parses its 16-octet header. */
	static Map<String, Object> readOne(Socket sock, int timeoutMs) throws IOException {
		sock.setSoTimeout(timeoutMs);
		DataInputStream in = new DataInputStream(sock.getInputStream());
		byte[] lenBytes = new byte[4];
		in.readFully(lenBytes);
		long cmdLength = ((long) (lenBytes[0] & 0xFF) << 24) | ((lenBytes[1] & 0xFF) << 16)
			| ((lenBytes[2] & 0xFF) << 8) | (lenBytes[3] & 0xFF);
		byte[] rest = new byte[(int) cmdLength - 4];
		in.readFully(rest);

		int cmdId = b32(rest, 0);
		int status = b32(rest, 4);
		int seqNr = b32(rest, 8);

		Map<String, Object> result = new LinkedHashMap<>();
		result.put("cmdId", cmdId);
		result.put("cmdIdHex", "0x" + Integer.toHexString(cmdId));
		result.put("cmdStatus", status);
		result.put("cmdStatusHex", "0x" + Integer.toHexString(status));
		result.put("seqNr", seqNr);
		byte[] full = new byte[4 + rest.length];
		System.arraycopy(lenBytes, 0, full, 0, 4);
		System.arraycopy(rest, 0, full, 4, rest.length);
		result.put("hex", Json.hex(full));

		return result;
	}

	private static int b32(byte[] b, int offset) {
		return ((b[offset] & 0xFF) << 24) | ((b[offset + 1] & 0xFF) << 16)
			| ((b[offset + 2] & 0xFF) << 8) | (b[offset + 3] & 0xFF);
	}
}
