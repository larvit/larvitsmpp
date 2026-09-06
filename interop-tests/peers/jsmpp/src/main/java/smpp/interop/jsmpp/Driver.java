package smpp.interop.jsmpp;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import org.jsmpp.InvalidResponseException;
import org.jsmpp.PDUException;
import org.jsmpp.bean.Alphabet;
import org.jsmpp.bean.AlertNotification;
import org.jsmpp.bean.BindType;
import org.jsmpp.bean.DataSm;
import org.jsmpp.bean.DeliverSm;
import org.jsmpp.bean.ESMClass;
import org.jsmpp.bean.GeneralDataCoding;
import org.jsmpp.bean.NumberingPlanIndicator;
import org.jsmpp.bean.OptionalParameter;
import org.jsmpp.bean.RegisteredDelivery;
import org.jsmpp.bean.SMSCDeliveryReceipt;
import org.jsmpp.bean.TypeOfNumber;
import org.jsmpp.bean.InterfaceVersion;
import org.jsmpp.extra.NegativeResponseException;
import org.jsmpp.extra.ProcessRequestException;
import org.jsmpp.extra.ResponseTimeoutException;
import org.jsmpp.session.BindParameter;
import org.jsmpp.session.MessageReceiverListener;
import org.jsmpp.session.QuerySmResult;
import org.jsmpp.session.SMPPSession;
import org.jsmpp.session.Session;
import org.jsmpp.session.SubmitSmResult;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * An HTTP-driven jsmpp ESME: each request binds (if needed), performs one scenario action against
 * the SMPP server named by host/port args, and answers with the result as JSON. Kept alive as one
 * process so a session can be reused across several requests, the way a real ESME would.
 */
public final class Driver {
	private static final Map<String, SMPPSession> sessions = new ConcurrentHashMap<>();
	private static final Map<String, Integer> requestedVersions = new ConcurrentHashMap<>();
	private static final Map<String, Socket> rawSockets = new ConcurrentHashMap<>();
	private static final Map<String, Integer> rawSeqNr = new ConcurrentHashMap<>();
	private static String host;
	private static int port;

	private Driver() { }

	public static void main(String[] args) throws IOException {
		host = args.length > 0 ? args[0] : "node";
		port = args.length > 1 ? Integer.parseInt(args[1]) : 2775;

		HttpServer server = HttpServer.create(new InetSocketAddress(8080), 0);
		server.createContext("/health", exchange -> respond(exchange, 200, "{\"ok\":true}"));
		server.createContext("/bind", Driver::handleBind);
		server.createContext("/unbind", Driver::handleUnbind);
		server.createContext("/enquireLink", Driver::handleEnquireLink);
		server.createContext("/submit", Driver::handleSubmit);
		server.createContext("/querySm", exchange -> handleUnhandledCommand(exchange, "query"));
		server.createContext("/cancelSm", exchange -> handleUnhandledCommand(exchange, "cancel"));
		server.createContext("/replaceSm", exchange -> handleUnhandledCommand(exchange, "replace"));
		server.createContext("/rawBind", Driver::handleRawBind);
		server.createContext("/rawUnknownCommand", exchange -> handleRawAction(exchange, RawSmpp::unknownCommandPdu));
		server.createContext("/rawTruncatedTlv", exchange -> handleRawAction(exchange, RawSmpp::truncatedTlvDeliverSmPdu));
		server.createContext("/rawShortBody", exchange -> handleRawAction(exchange, RawSmpp::shortBodyDeliverSmPdu));
		server.createContext("/rawEnquireLink", exchange -> handleRawAction(exchange, RawSmpp::enquireLinkPdu));
		server.setExecutor(null);
		server.start();
		System.out.println("jsmpp driver listening on 8080, target " + host + ":" + port);
	}

	// --- HTTP plumbing ---

	private static Map<String, String> queryParams(HttpExchange exchange) {
		Map<String, String> params = new LinkedHashMap<>();
		String query = exchange.getRequestURI().getRawQuery();

		if (query == null) return params;

		for (String pair : query.split("&")) {
			int eq = pair.indexOf('=');
			String key = eq < 0 ? pair : pair.substring(0, eq);
			String value = eq < 0 ? "" : URLDecoder.decode(pair.substring(eq + 1), StandardCharsets.UTF_8);
			params.put(key, value);
		}

		return params;
	}

	private static void respond(HttpExchange exchange, int status, String body) {
		try {
			byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
			exchange.getResponseHeaders().add("Content-Type", "application/json");
			exchange.sendResponseHeaders(status, bytes.length);

			try (OutputStream out = exchange.getResponseBody()) {
				out.write(bytes);
			}
		} catch (IOException e) {
			// The client gave up reading; nothing left to answer.
		}
	}

	private static void respondOk(HttpExchange exchange, Map<String, Object> result) {
		respond(exchange, 200, Json.write(result));
	}

	private static void respondErr(HttpExchange exchange, Exception e) {
		Map<String, Object> result = new LinkedHashMap<>();
		result.put("ok", false);
		result.put("errorClass", e.getClass().getName());
		result.put("error", String.valueOf(e.getMessage()));

		if (e instanceof NegativeResponseException nre) {
			result.put("commandStatus", nre.getCommandStatus());
			result.put("commandStatusHex", "0x" + Integer.toHexString(nre.getCommandStatus()));
		}

		respond(exchange, 200, Json.write(result));
	}

	// --- jsmpp-backed handlers ---

	private static void handleBind(HttpExchange exchange) {
		Map<String, String> p = queryParams(exchange);
		String name = p.getOrDefault("session", "default");

		try {
			SMPPSession session = new SMPPSession();
			session.setMessageReceiverListener(new NoopListener());

			String type = p.getOrDefault("type", "transceiver");
			BindType bindType = switch (type) {
				case "receiver" -> BindType.BIND_RX;
				case "transmitter" -> BindType.BIND_TX;
				default -> BindType.BIND_TRX;
			};

			int ifVersion = Integer.parseInt(p.getOrDefault("interfaceVersion", "52"));
			InterfaceVersion interfaceVersion = InterfaceVersion.valueOf((byte) ifVersion);

			String systemId = p.getOrDefault("systemId", "jsmpp");
			String password = p.getOrDefault("password", "jsmpppw");

			BindParameter bindParameter = new BindParameter(bindType, systemId, password, "interop",
				TypeOfNumber.UNKNOWN, NumberingPlanIndicator.UNKNOWN, null, interfaceVersion);

			String scSystemId = session.connectAndBind(host, port, bindParameter);

			sessions.put(name, session);
			requestedVersions.put(name, ifVersion);

			Map<String, Object> result = new LinkedHashMap<>();
			result.put("ok", true);
			result.put("scSystemId", scSystemId);
			result.put("requestedInterfaceVersion", ifVersion);
			result.put("negotiatedInterfaceVersion", session.getInterfaceVersion().value() & 0xFF);
			respondOk(exchange, result);
		} catch (Exception e) {
			respondErr(exchange, e);
		}
	}

	private static void handleUnbind(HttpExchange exchange) {
		Map<String, String> p = queryParams(exchange);
		SMPPSession session = sessions.remove(p.getOrDefault("session", "default"));

		try {
			if (session != null) session.unbindAndClose();

			Map<String, Object> result = new LinkedHashMap<>();
			result.put("ok", true);
			respondOk(exchange, result);
		} catch (Exception e) {
			respondErr(exchange, e);
		}
	}

	private static void handleEnquireLink(HttpExchange exchange) {
		Map<String, String> p = queryParams(exchange);
		SMPPSession session = sessions.get(p.getOrDefault("session", "default"));

		Map<String, Object> result = new LinkedHashMap<>();

		if (session == null) {
			result.put("ok", false);
			result.put("error", "no such session");
			respondOk(exchange, result);

			return;
		}

		result.put("ok", true);
		result.put("sessionState", session.getSessionState().name());
		respondOk(exchange, result);
	}

	private static byte[] encode(String text, String encoding) {
		return switch (encoding) {
			case "ucs2" -> text.getBytes(StandardCharsets.UTF_16BE);
			case "latin1" -> text.getBytes(StandardCharsets.ISO_8859_1);
			default -> text.getBytes(StandardCharsets.US_ASCII);
		};
	}

	private static GeneralDataCoding dataCoding(String encoding) {
		Alphabet alphabet = switch (encoding) {
			case "ucs2" -> Alphabet.ALPHA_UCS2;
			case "latin1" -> Alphabet.ALPHA_LATIN1;
			default -> Alphabet.ALPHA_DEFAULT;
		};

		return new GeneralDataCoding(alphabet, null, false);
	}

	/** Chunk size chosen well under any segment limit for every encoding this driver sends. */
	private static final int CHUNK_CHARS = 130;

	private static void handleSubmit(HttpExchange exchange) {
		Map<String, String> p = queryParams(exchange);
		SMPPSession session = sessions.get(p.getOrDefault("session", "default"));

		if (session == null) {
			respond(exchange, 200, Json.write(Map.of("ok", false, "error", "no such session")));

			return;
		}

		String from = p.getOrDefault("from", "12345");
		String to = p.getOrDefault("to", "67890");
		String text = p.getOrDefault("text", "hello");
		String mode = p.getOrDefault("mode", "plain");
		String encoding = p.getOrDefault("encoding", "gsm7");

		try {
			java.util.List<Map<String, Object>> segments = new java.util.ArrayList<>();

			switch (mode) {
				case "udh8" -> submitUdh(session, from, to, text, encoding, false, segments);
				case "udh16" -> submitUdh(session, from, to, text, encoding, true, segments);
				case "sar" -> submitSar(session, from, to, text, encoding, segments);
				case "payload" -> submitPayload(session, from, to, text, encoding, segments);
				default -> submitPlain(session, from, to, text, encoding, segments);
			}

			Map<String, Object> result = new LinkedHashMap<>();
			result.put("ok", true);
			result.put("segments", segments);
			respondOk(exchange, result);
		} catch (NegativeResponseException e) {
			Map<String, Object> result = new LinkedHashMap<>();
			result.put("ok", true);
			result.put("refused", true);
			result.put("commandStatus", e.getCommandStatus());
			result.put("commandStatusHex", "0x" + Integer.toHexString(e.getCommandStatus()));
			respondOk(exchange, result);
		} catch (Exception e) {
			respondErr(exchange, e);
		}
	}

	private static void submitPlain(SMPPSession session, String from, String to, String text, String encoding,
			java.util.List<Map<String, Object>> segments) throws Exception {
		SubmitSmResult r = session.submitShortMessage("CMT",
			TypeOfNumber.INTERNATIONAL, NumberingPlanIndicator.UNKNOWN, from,
			TypeOfNumber.INTERNATIONAL, NumberingPlanIndicator.UNKNOWN, to,
			new ESMClass(), (byte) 0, (byte) 1, null, null,
			new RegisteredDelivery(SMSCDeliveryReceipt.DEFAULT), (byte) 0, dataCoding(encoding), (byte) 0,
			encode(text, encoding));
		segments.add(Map.of("messageId", r.getMessageId()));
	}

	private static java.util.List<String> chunk(String text, int size) {
		java.util.List<String> out = new java.util.ArrayList<>();

		for (int i = 0; i < text.length(); i += size) {
			out.add(text.substring(i, Math.min(text.length(), i + size)));
		}

		return out;
	}

	private static void submitUdh(SMPPSession session, String from, String to, String text, String encoding,
			boolean sixteenBit, java.util.List<Map<String, Object>> segments) throws Exception {
		java.util.List<String> chunks = chunk(text, CHUNK_CHARS);
		int reference = sixteenBit ? 0x1234 : 0x42;
		int total = chunks.size();

		for (int i = 0; i < chunks.size(); i++) {
			byte[] chunkBytes = encode(chunks.get(i), encoding);
			byte[] udh = sixteenBit
				? new byte[] { 0x06, 0x08, 0x04, (byte) ((reference >> 8) & 0xFF), (byte) (reference & 0xFF), (byte) total, (byte) (i + 1) }
				: new byte[] { 0x05, 0x00, 0x03, (byte) reference, (byte) total, (byte) (i + 1) };
			byte[] shortMessage = new byte[udh.length + chunkBytes.length];
			System.arraycopy(udh, 0, shortMessage, 0, udh.length);
			System.arraycopy(chunkBytes, 0, shortMessage, udh.length, chunkBytes.length);

			SubmitSmResult r = session.submitShortMessage("CMT",
				TypeOfNumber.INTERNATIONAL, NumberingPlanIndicator.UNKNOWN, from,
				TypeOfNumber.INTERNATIONAL, NumberingPlanIndicator.UNKNOWN, to,
				new ESMClass(0x40), (byte) 0, (byte) 1, null, null,
				new RegisteredDelivery(SMSCDeliveryReceipt.DEFAULT), (byte) 0, dataCoding(encoding), (byte) 0,
				shortMessage);
			segments.add(Map.of("messageId", r.getMessageId(), "part", i + 1, "total", total));
		}
	}

	private static void submitSar(SMPPSession session, String from, String to, String text, String encoding,
			java.util.List<Map<String, Object>> segments) throws Exception {
		java.util.List<String> chunks = chunk(text, CHUNK_CHARS);
		int reference = 0x77;
		int total = chunks.size();

		for (int i = 0; i < chunks.size(); i++) {
			byte[] chunkBytes = encode(chunks.get(i), encoding);
			OptionalParameter refNum = new OptionalParameter.Sar_msg_ref_num((short) reference);
			OptionalParameter totalSegments = new OptionalParameter.Sar_total_segments((byte) total);
			OptionalParameter seqNum = new OptionalParameter.Sar_segment_seqnum((byte) (i + 1));

			SubmitSmResult r = session.submitShortMessage("CMT",
				TypeOfNumber.INTERNATIONAL, NumberingPlanIndicator.UNKNOWN, from,
				TypeOfNumber.INTERNATIONAL, NumberingPlanIndicator.UNKNOWN, to,
				new ESMClass(), (byte) 0, (byte) 1, null, null,
				new RegisteredDelivery(SMSCDeliveryReceipt.DEFAULT), (byte) 0, dataCoding(encoding), (byte) 0,
				chunkBytes, refNum, totalSegments, seqNum);
			segments.add(Map.of("messageId", r.getMessageId(), "part", i + 1, "total", total));
		}
	}

	private static void submitPayload(SMPPSession session, String from, String to, String text, String encoding,
			java.util.List<Map<String, Object>> segments) throws Exception {
		byte[] payload = encode(text, encoding);
		OptionalParameter messagePayload = new OptionalParameter.Message_payload(payload);

		SubmitSmResult r = session.submitShortMessage("CMT",
			TypeOfNumber.INTERNATIONAL, NumberingPlanIndicator.UNKNOWN, from,
			TypeOfNumber.INTERNATIONAL, NumberingPlanIndicator.UNKNOWN, to,
			new ESMClass(), (byte) 0, (byte) 1, null, null,
			new RegisteredDelivery(SMSCDeliveryReceipt.DEFAULT), (byte) 0, dataCoding(encoding), (byte) 0,
			new byte[0], messagePayload);
		segments.add(Map.of("messageId", r.getMessageId()));
	}

	private static void handleUnhandledCommand(HttpExchange exchange, String which) {
		Map<String, String> p = queryParams(exchange);
		SMPPSession session = sessions.get(p.getOrDefault("session", "default"));
		String messageId = p.getOrDefault("messageId", "0");

		if (session == null) {
			respond(exchange, 200, Json.write(Map.of("ok", false, "error", "no such session")));

			return;
		}

		try {
			switch (which) {
				case "query" -> {
					QuerySmResult r = session.queryShortMessage(messageId, TypeOfNumber.INTERNATIONAL,
						NumberingPlanIndicator.UNKNOWN, "12345");
					respondOk(exchange, Map.of("ok", true, "refused", false, "finalDate", String.valueOf(r.getFinalDate())));
				}
				case "cancel" -> {
					session.cancelShortMessage("CMT", messageId, TypeOfNumber.INTERNATIONAL,
						NumberingPlanIndicator.UNKNOWN, "12345", TypeOfNumber.INTERNATIONAL,
						NumberingPlanIndicator.UNKNOWN, "67890");
					respondOk(exchange, Map.of("ok", true, "refused", false));
				}
				case "replace" -> {
					session.replaceShortMessage(messageId, TypeOfNumber.INTERNATIONAL,
						NumberingPlanIndicator.UNKNOWN, "12345", null, null,
						new RegisteredDelivery(SMSCDeliveryReceipt.DEFAULT), (byte) 0, "replacement".getBytes(StandardCharsets.US_ASCII));
					respondOk(exchange, Map.of("ok", true, "refused", false));
				}
				default -> respond(exchange, 400, "{}");
			}
		} catch (NegativeResponseException e) {
			Map<String, Object> result = new LinkedHashMap<>();
			result.put("ok", true);
			result.put("refused", true);
			result.put("commandStatus", e.getCommandStatus());
			result.put("commandStatusHex", "0x" + Integer.toHexString(e.getCommandStatus()));
			respondOk(exchange, result);
		} catch (Exception e) {
			respondErr(exchange, e);
		}
	}

	// --- raw-socket handlers, for PDUs jsmpp's typed API cannot construct ---

	private static void handleRawBind(HttpExchange exchange) {
		Map<String, String> p = queryParams(exchange);
		String name = p.getOrDefault("raw", "default");

		try {
			Socket sock = new Socket();
			sock.connect(new InetSocketAddress(host, port), 5000);

			int ifVersion = Integer.parseInt(p.getOrDefault("interfaceVersion", "52"));
			int seqNr = 1;
			RawSmpp.write(sock, RawSmpp.bindTransceiverPdu(
				p.getOrDefault("systemId", "rawjsmpp"), p.getOrDefault("password", "rawpw"), ifVersion, seqNr));

			Map<String, Object> resp = RawSmpp.readOne(sock, 5000);
			rawSockets.put(name, sock);
			rawSeqNr.put(name, seqNr + 1);

			Map<String, Object> result = new LinkedHashMap<>();
			result.put("ok", true);
			result.put("bindResp", resp);
			respondOk(exchange, result);
		} catch (Exception e) {
			respondErr(exchange, e);
		}
	}

	private interface PduBuilder {
		byte[] build(int seqNr);
	}

	private static void handleRawAction(HttpExchange exchange, PduBuilder builder) {
		Map<String, String> p = queryParams(exchange);
		String name = p.getOrDefault("raw", "default");
		Socket sock = rawSockets.get(name);

		if (sock == null) {
			respond(exchange, 200, Json.write(Map.of("ok", false, "error", "no such raw socket - call rawBind first")));

			return;
		}

		try {
			int seqNr = rawSeqNr.getOrDefault(name, 1);
			RawSmpp.write(sock, builder.build(seqNr));
			rawSeqNr.put(name, seqNr + 1);

			Map<String, Object> resp = RawSmpp.readOne(sock, 5000);
			Map<String, Object> result = new LinkedHashMap<>();
			result.put("ok", true);
			result.put("response", resp);
			respondOk(exchange, result);
		} catch (Exception e) {
			respondErr(exchange, e);
		}
	}

	private static final class NoopListener implements MessageReceiverListener {
		@Override
		public void onAcceptDeliverSm(DeliverSm deliverSm) throws ProcessRequestException {
			// This phase's scenarios never have the SMSC push a deliver_sm to jsmpp.
		}

		@Override
		public void onAcceptAlertNotification(AlertNotification alertNotification) {
			// Nothing to do: no scenario here sends one.
		}

		@Override
		public org.jsmpp.session.DataSmResult onAcceptDataSm(DataSm dataSm, Session source)
				throws ProcessRequestException {
			throw new ProcessRequestException("data_sm not supported by this driver", 3);
		}
	}
}
