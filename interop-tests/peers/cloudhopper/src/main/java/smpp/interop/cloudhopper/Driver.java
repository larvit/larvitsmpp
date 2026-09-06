package smpp.interop.cloudhopper;

import com.cloudhopper.smpp.SmppBindType;
import com.cloudhopper.smpp.SmppSession;
import com.cloudhopper.smpp.SmppSessionConfiguration;
import com.cloudhopper.smpp.impl.DefaultSmppClient;
import com.cloudhopper.smpp.impl.DefaultSmppSessionHandler;
import com.cloudhopper.smpp.pdu.PduRequest;
import com.cloudhopper.smpp.pdu.SubmitSm;
import com.cloudhopper.smpp.pdu.SubmitSmResp;
import com.cloudhopper.smpp.ssl.SslConfiguration;
import com.cloudhopper.smpp.type.Address;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * An HTTP-driven Cloudhopper ESME: bind with a chosen window configuration, then fire concurrent
 * submits against our (possibly deliberately slow) server and report per-request outcomes and the
 * observed send-window occupancy, so the node test file can assert none lost, none duplicated.
 */
public final class Driver {
	private static final Logger log = LoggerFactory.getLogger(Driver.class);
	private static final Map<String, SmppSession> sessions = new ConcurrentHashMap<>();
	private static final AtomicInteger expiredCount = new AtomicInteger(0);
	private static DefaultSmppClient client;
	private static ScheduledThreadPoolExecutor monitorExecutor;
	private static ExecutorService ioExecutor;
	private static String host;
	private static int port;

	private Driver() { }

	public static void main(String[] args) throws IOException {
		host = args.length > 0 ? args[0] : "node";
		port = args.length > 1 ? Integer.parseInt(args[1]) : 2775;

		ioExecutor = Executors.newCachedThreadPool();
		monitorExecutor = new ScheduledThreadPoolExecutor(2);
		client = new DefaultSmppClient(Executors.newCachedThreadPool(), 50, monitorExecutor);

		HttpServer server = HttpServer.create(new InetSocketAddress(8080), 0);
		server.createContext("/health", exchange -> respond(exchange, 200, "{\"ok\":true}"));
		server.createContext("/bind", Driver::handleBind);
		server.createContext("/unbind", Driver::handleUnbind);
		server.createContext("/submit", Driver::handleSubmit);
		server.createContext("/windowBurst", Driver::handleWindowBurst);
		server.createContext("/sendWindowSize", Driver::handleSendWindowSize);
		server.setExecutor(null);
		server.start();
		System.out.println("cloudhopper driver listening on 8080, target " + host + ":" + port);
	}

	// --- HTTP plumbing (same shape as the jsmpp driver's, kept independent on purpose) ---

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
		respond(exchange, 200, Json.write(result));
	}

	// --- handlers ---

	private static void handleBind(HttpExchange exchange) {
		Map<String, String> p = queryParams(exchange);
		String name = p.getOrDefault("session", "default");

		try {
			SmppSessionConfiguration config = new SmppSessionConfiguration();
			config.setName(name);
			config.setType(SmppBindType.TRANSCEIVER);
			config.setHost(p.getOrDefault("host", host));
			config.setPort(Integer.parseInt(p.getOrDefault("port", String.valueOf(port))));
			config.setConnectTimeout(10_000);
			config.setSystemId(p.getOrDefault("systemId", "cloudhopper"));
			config.setPassword(p.getOrDefault("password", "chpw"));
			config.setWindowSize(Integer.parseInt(p.getOrDefault("windowSize", "1")));
			config.setRequestExpiryTimeout(Long.parseLong(p.getOrDefault("requestExpiryTimeout", "30000")));
			config.setWindowMonitorInterval(Long.parseLong(p.getOrDefault("windowMonitorInterval", "15000")));
			config.setCountersEnabled(true);

			if (Boolean.parseBoolean(p.getOrDefault("useSsl", "false"))) {
				// Cloudhopper's SslContextFactory only skips keystore loading when *neither* store is
				// configured - a trust-store-only client falls through to loadKeyStore() with a null
				// path and fails, so the build-time self-signed cert also gets used as the (otherwise
				// unneeded) client keystore.
				SslConfiguration ssl = new SslConfiguration();
				ssl.setTrustStorePath("/certs/truststore.jks");
				ssl.setTrustStorePassword("changeit");
				ssl.setKeyStorePath("/certs/keystore.p12");
				ssl.setKeyStorePassword("changeit");
				ssl.setKeyStoreType("PKCS12");
				config.setUseSsl(true);
				config.setSslConfiguration(ssl);
			}

			DefaultSmppSessionHandler handler = new DefaultSmppSessionHandler(log) {
				@Override
				public void firePduRequestExpired(PduRequest pduRequest) {
					expiredCount.incrementAndGet();
					log.warn("PDU request expired in window monitor: {}", pduRequest);
				}
			};

			SmppSession session = client.bind(config, handler);
			sessions.put(name, session);

			Map<String, Object> result = new LinkedHashMap<>();
			result.put("ok", true);
			respondOk(exchange, result);
		} catch (Exception e) {
			respondErr(exchange, e);
		}
	}

	private static void handleUnbind(HttpExchange exchange) {
		Map<String, String> p = queryParams(exchange);
		SmppSession session = sessions.remove(p.getOrDefault("session", "default"));

		try {
			if (session != null) {
				session.unbind(5000);
				session.destroy();
			}

			respondOk(exchange, Map.of("ok", true));
		} catch (Exception e) {
			respondErr(exchange, e);
		}
	}

	private static SubmitSm buildSubmit(String from, String to, String text)
			throws com.cloudhopper.smpp.type.SmppInvalidArgumentException {
		SubmitSm submit = new SubmitSm();
		submit.setSourceAddress(new Address((byte) 0x01, (byte) 0x01, from));
		submit.setDestAddress(new Address((byte) 0x01, (byte) 0x01, to));
		submit.setShortMessage(text.getBytes(StandardCharsets.US_ASCII));

		return submit;
	}

	private static void handleSubmit(HttpExchange exchange) {
		Map<String, String> p = queryParams(exchange);
		SmppSession session = sessions.get(p.getOrDefault("session", "default"));

		if (session == null) {
			respond(exchange, 200, Json.write(Map.of("ok", false, "error", "no such session")));

			return;
		}

		try {
			long timeoutMs = Long.parseLong(p.getOrDefault("timeoutMs", "10000"));
			long start = System.currentTimeMillis();
			SubmitSmResp resp = session.submit(
				buildSubmit(p.getOrDefault("from", "1000"), p.getOrDefault("to", "2000"), p.getOrDefault("text", "hi")),
				timeoutMs);
			long elapsed = System.currentTimeMillis() - start;

			Map<String, Object> result = new LinkedHashMap<>();
			result.put("ok", true);
			result.put("messageId", resp.getMessageId());
			result.put("commandStatus", resp.getCommandStatus());
			result.put("elapsedMs", (int) elapsed);
			respondOk(exchange, result);
		} catch (Exception e) {
			respondErr(exchange, e);
		}
	}

	/** Fires `count` submits at once, each tagged by index in its text, to probe window pressure. */
	private static void handleWindowBurst(HttpExchange exchange) {
		Map<String, String> p = queryParams(exchange);
		SmppSession session = sessions.get(p.getOrDefault("session", "default"));

		if (session == null) {
			respond(exchange, 200, Json.write(Map.of("ok", false, "error", "no such session")));

			return;
		}

		int count = Integer.parseInt(p.getOrDefault("count", "10"));
		long timeoutMs = Long.parseLong(p.getOrDefault("timeoutMs", "60000"));
		String from = p.getOrDefault("from", "1000");
		String to = p.getOrDefault("to", "2000");
		String prefix = p.getOrDefault("prefix", "burst");

		AtomicInteger peakWindow = new AtomicInteger(0);
		Thread sampler = new Thread(() -> {
			while (!Thread.currentThread().isInterrupted()) {
				try {
					int size = session.getSendWindow().getSize();
					peakWindow.updateAndGet(prev -> Math.max(prev, size));
					Thread.sleep(10);
				} catch (InterruptedException e) {
					Thread.currentThread().interrupt();
				}
			}
		});
		sampler.setDaemon(true);
		sampler.start();

		List<Future<Map<String, Object>>> futures = new ArrayList<>();

		for (int i = 0; i < count; i++) {
			int index = i;
			futures.add(ioExecutor.submit((Callable<Map<String, Object>>) () -> {
				Map<String, Object> entry = new LinkedHashMap<>();
				entry.put("index", index);

				try {
					long start = System.currentTimeMillis();
					SubmitSmResp resp = session.submit(buildSubmit(from, to, prefix + "-" + index), timeoutMs);
					entry.put("ok", true);
					entry.put("messageId", resp.getMessageId());
					entry.put("elapsedMs", (int) (System.currentTimeMillis() - start));
				} catch (Exception e) {
					entry.put("ok", false);
					entry.put("errorClass", e.getClass().getSimpleName());
					entry.put("error", String.valueOf(e.getMessage()));
				}

				return entry;
			}));
		}

		List<Object> results = new ArrayList<>();

		for (Future<Map<String, Object>> f : futures) {
			try {
				results.add(f.get());
			} catch (Exception e) {
				results.add(Map.of("ok", false, "error", String.valueOf(e.getMessage())));
			}
		}

		sampler.interrupt();

		Map<String, Object> result = new LinkedHashMap<>();
		result.put("ok", true);
		result.put("results", results);
		result.put("peakWindowSize", peakWindow.get());
		result.put("expiredCount", expiredCount.get());
		respondOk(exchange, result);
	}

	private static void handleSendWindowSize(HttpExchange exchange) {
		Map<String, String> p = queryParams(exchange);
		SmppSession session = sessions.get(p.getOrDefault("session", "default"));

		if (session == null) {
			respond(exchange, 200, Json.write(Map.of("ok", false, "error", "no such session")));

			return;
		}

		respondOk(exchange, Map.of("ok", true, "size", session.getSendWindow().getSize()));
	}
}
