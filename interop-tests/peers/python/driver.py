#!/usr/bin/env python3
"""HTTP-driven python-smpplib ESME: binds named sessions against the target SMPP server and
performs one action per request, answering with the result as JSON. Kept alive as one process so a
session survives across requests, the way jsmpp's Java driver does (see AGENTS.md)."""
import json
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import smpplib.client
import smpplib.consts
import smpplib.exceptions
import smpplib.gsm
import smpplib.smpp

TARGET_HOST = sys.argv[1] if len(sys.argv) > 1 else "node"
TARGET_PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 2775

GSM_TABLE = smpplib.gsm.GSM_CHARACTER_TABLE

MODES = {
	"receiver": "bind_receiver",
	"transceiver": "bind_transceiver",
	"transmitter": "bind_transmitter",
}


def as_text(value):
	return value.decode() if isinstance(value, bytes) else value


def gsm_decode(data: bytes) -> str:
	"""Inverse of smpplib's own gsm_encode(), through its own (vendor-specific) table - used to
	decode what this driver receives, so a mismatch against what was sent is smpplib's own table,
	not a guess at the real GSM 03.38 one."""
	chars = []
	i = 0
	while i < len(data):
		byte = data[i]
		if byte == 0x1B and i + 1 < len(data):
			chars.append(GSM_TABLE[0x80 + data[i + 1]])
			i += 2
		else:
			chars.append(GSM_TABLE[byte])
			i += 1
	return "".join(chars)


def decode_body(data: bytes, data_coding: int) -> str:
	if data_coding in (0, 1):
		return gsm_decode(data)
	if data_coding == 3:
		return data.decode("latin-1")
	if data_coding == 8:
		whole = len(data) - (len(data) % 2)
		return data[:whole].decode("utf-16-be")
	return data.hex()


class Session:
	def __init__(self, client):
		self.client = client
		self.send_lock = threading.Lock()
		self.received = []
		self.acks = {}
		self.ack_events = {}
		self.reader_thread = None
		self.reader_running = False
		self.reader_error = None

	def wait_ack(self, sequence, budget=8.0):
		event = self.ack_events.setdefault(sequence, threading.Event())
		event.wait(budget)
		return self.acks.get(sequence)


SESSIONS = {}
SESSIONS_LOCK = threading.Lock()


def session_for(name):
	with SESSIONS_LOCK:
		return SESSIONS[name]


def do_bind(body):
	name = body["name"]
	mode = body["mode"]
	timeout_secs = float(body.get("timeoutSecs", 5))

	client = smpplib.client.Client(TARGET_HOST, TARGET_PORT, timeout=timeout_secs, allow_unknown_opt_params=True)
	client.connect()

	kwargs = {"system_id": body["systemId"], "password": body["password"]}
	if body.get("interfaceVersion") is not None:
		kwargs["interface_version"] = int(body["interfaceVersion"])

	getattr(client, MODES[mode])(**kwargs)

	session = Session(client)

	def on_received(pdu, **_kwargs):
		data = pdu.short_message or b""
		session.received.append({
			"dataCoding": pdu.data_coding,
			"esmClass": pdu.esm_class,
			"from": as_text(pdu.source_addr),
			"hex": data.hex(),
			"text": decode_body(data, pdu.data_coding),
			"to": as_text(pdu.destination_addr),
		})
		return smpplib.consts.SMPP_ESME_ROK

	def on_sent(pdu, **_kwargs):
		session.acks[pdu.sequence] = {
			"messageId": as_text(getattr(pdu, "message_id", None)),
			"status": int(pdu.status),
		}
		session.ack_events.setdefault(pdu.sequence, threading.Event()).set()

	def on_error_pdu(pdu):
		# Overrides the default handler, which raises: a refusing status must reach
		# message_sent_handler like any other response, not tear down the read loop.
		if pdu.command == "submit_sm_resp":
			on_sent(pdu)

	client.set_message_received_handler(on_received)
	client.set_message_sent_handler(on_sent)
	client.set_error_pdu_handler(on_error_pdu)

	with SESSIONS_LOCK:
		SESSIONS[name] = session

	return {"ok": True}


def do_start_reader(body):
	session = session_for(body["name"])
	auto_send_enquire_link = bool(body.get("autoSendEnquireLink", True))

	if session.reader_running:
		return {"ok": True}

	def run():
		session.reader_running = True
		try:
			while True:
				session.client.read_once(auto_send_enquire_link=auto_send_enquire_link)
		except Exception as exc:  # noqa: BLE001 - recorded, not raised: this is a driver thread
			session.reader_error = f"{type(exc).__name__}: {exc}"
		finally:
			session.reader_running = False

	session.reader_thread = threading.Thread(target=run, daemon=True)
	session.reader_thread.start()

	return {"ok": True}


def encode_body(text, data_coding):
	if data_coding == 0:
		return smpplib.gsm.gsm_encode(text)
	if data_coding == 3:
		return text.encode("latin-1")
	if data_coding == 8:
		return text.encode("utf-16-be")
	raise ValueError(f"unsupported dataCoding {data_coding}")


def do_submit(body):
	# Does not wait for the submit_sm_resp: a single-segment message is only answered once the
	# caller's own "sms" handler calls sendResp(), which the caller can only do after seeing this
	# call return - waiting here would deadlock exactly that handshake. Poll /ack for the result.
	session = session_for(body["name"])
	data_coding = int(body["dataCoding"])
	payload = encode_body(body.get("text", ""), data_coding) if "text" in body else b""

	if body.get("extraHex"):
		payload += bytes.fromhex(body["extraHex"])

	with session.send_lock:
		pdu = session.client.send_message(
			source_addr=body["from"],
			destination_addr=body["to"],
			short_message=payload,
			data_coding=data_coding,
			esm_class=int(body.get("esmClass", 0)),
		)
		sequence = pdu.sequence

	return {"ok": True, "sequence": sequence}


def do_ack(query):
	session = session_for(query["name"][0])
	sequence = int(query["sequence"][0])
	ack = session.acks.get(sequence)

	if ack is None:
		return {"found": False, "ok": True}

	return {"found": True, "messageId": ack["messageId"], "ok": True, "status": ack["status"]}


def do_submit_long(body):
	session = session_for(body["name"])
	data_coding = int(body["dataCoding"])
	parts, encoding, esm_class = smpplib.gsm.make_parts(body["text"], encoding=data_coding, use_udhi=True)

	results = []

	for part in parts:
		with session.send_lock:
			pdu = session.client.send_message(
				source_addr=body["from"],
				destination_addr=body["to"],
				short_message=part,
				data_coding=encoding,
				esm_class=esm_class,
			)
			sequence = pdu.sequence

		ack = session.wait_ack(sequence, budget=8)
		results.append(ack)

	return {"ok": all(results), "parts": len(parts), "results": results}


def do_enquire_link(body):
	session = session_for(body["name"])

	with session.send_lock:
		pdu = smpplib.smpp.make_pdu("enquire_link", client=session.client)
		session.client.send_pdu(pdu)

	return {"ok": True}


def do_received(name):
	session = session_for(name)

	return {"ok": True, "received": session.received}


def do_status(name):
	session = session_for(name)

	return {
		"ok": True,
		"readerError": session.reader_error,
		"readerRunning": session.reader_running,
		"receivedCount": len(session.received),
	}


def do_idle_silent(body):
	"""Sleeps `seconds` sending nothing at all - no reader thread, no enquire_link - then does one
	read attempt to say whether the peer (our server) closed the link while it was silent."""
	session = session_for(body["name"])
	time.sleep(float(body["seconds"]))

	session.client._socket.settimeout(2)

	try:
		session.client.read_pdu()

		return {"closed": False, "ok": True}
	except socket.timeout:
		return {"closed": False, "ok": True}
	except smpplib.exceptions.ConnectionError:
		return {"closed": True, "ok": True}


def do_unbind(body):
	session = session_for(body["name"])

	try:
		session.client.unbind()
	except Exception:  # noqa: BLE001 - best-effort teardown
		pass

	session.client.disconnect()

	with SESSIONS_LOCK:
		del SESSIONS[body["name"]]

	return {"ok": True}


ROUTES = {
	"/bind": lambda body, _query: do_bind(body),
	"/enquireLink": lambda body, _query: do_enquire_link(body),
	"/idleSilent": lambda body, _query: do_idle_silent(body),
	"/startReader": lambda body, _query: do_start_reader(body),
	"/submit": lambda body, _query: do_submit(body),
	"/submitLong": lambda body, _query: do_submit_long(body),
	"/unbind": lambda body, _query: do_unbind(body),
}

GET_ROUTES = {
	"/ack": do_ack,
	"/received": lambda query: do_received(query["name"][0]),
	"/status": lambda query: do_status(query["name"][0]),
}


class Handler(BaseHTTPRequestHandler):
	def log_message(self, fmt, *args):
		sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

	def _respond(self, status, payload):
		body = json.dumps(payload).encode()
		self.send_response(status)
		self.send_header("Content-Type", "application/json")
		self.send_header("Content-Length", str(len(body)))
		self.end_headers()
		self.wfile.write(body)

	def do_GET(self):
		if self.path == "/health":
			self._respond(200, {"ok": True})
			return

		parsed = urlparse(self.path)
		handler = GET_ROUTES.get(parsed.path)

		if handler is None:
			self._respond(404, {"error": "no such route"})
			return

		try:
			self._respond(200, handler(parse_qs(parsed.query)))
		except Exception as exc:  # noqa: BLE001 - surfaced to the caller, not the process
			self._respond(500, {"error": f"{type(exc).__name__}: {exc}"})

	def do_POST(self):
		handler = ROUTES.get(self.path)

		if handler is None:
			self._respond(404, {"error": "no such route"})
			return

		length = int(self.headers.get("Content-Length", 0))
		raw = self.rfile.read(length) if length else b"{}"
		body = json.loads(raw or b"{}")

		try:
			self._respond(200, handler(body, None))
		except Exception as exc:  # noqa: BLE001 - surfaced to the caller, not the process
			self._respond(500, {"error": f"{type(exc).__name__}: {exc}"})


def main():
	server = ThreadingHTTPServer(("0.0.0.0", 8080), Handler)
	print(f"python-smpplib driver listening on 8080, target {TARGET_HOST}:{TARGET_PORT}", file=sys.stderr)
	server.serve_forever()


if __name__ == "__main__":
	main()
