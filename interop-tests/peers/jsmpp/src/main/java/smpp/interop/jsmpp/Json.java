package smpp.interop.jsmpp;

import java.util.List;
import java.util.Map;

/** A minimal JSON writer for the driver's own controlled output - no parsing needed. */
final class Json {
	private Json() { }

	static String write(Object value) {
		StringBuilder sb = new StringBuilder();
		writeValue(sb, value);
		return sb.toString();
	}

	@SuppressWarnings("unchecked")
	private static void writeValue(StringBuilder sb, Object value) {
		if (value == null) {
			sb.append("null");
		} else if (value instanceof String s) {
			writeString(sb, s);
		} else if (value instanceof Boolean || value instanceof Integer || value instanceof Long) {
			sb.append(value);
		} else if (value instanceof Map<?, ?> map) {
			sb.append('{');
			boolean first = true;
			for (Map.Entry<?, ?> entry : map.entrySet()) {
				if (!first) sb.append(',');
				first = false;
				writeString(sb, String.valueOf(entry.getKey()));
				sb.append(':');
				writeValue(sb, entry.getValue());
			}
			sb.append('}');
		} else if (value instanceof List<?> list) {
			sb.append('[');
			boolean first = true;
			for (Object item : list) {
				if (!first) sb.append(',');
				first = false;
				writeValue(sb, item);
			}
			sb.append(']');
		} else if (value instanceof byte[] bytes) {
			writeString(sb, hex(bytes));
		} else {
			writeString(sb, String.valueOf(value));
		}
	}

	private static void writeString(StringBuilder sb, String s) {
		sb.append('"');
		for (int i = 0; i < s.length(); i++) {
			char c = s.charAt(i);
			switch (c) {
				case '"' -> sb.append("\\\"");
				case '\\' -> sb.append("\\\\");
				case '\n' -> sb.append("\\n");
				case '\r' -> sb.append("\\r");
				case '\t' -> sb.append("\\t");
				default -> {
					if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
					else sb.append(c);
				}
			}
		}
		sb.append('"');
	}

	static String hex(byte[] bytes) {
		StringBuilder sb = new StringBuilder(bytes.length * 2);
		for (byte b : bytes) sb.append(String.format("%02x", b));
		return sb.toString();
	}
}
