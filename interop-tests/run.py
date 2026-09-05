#!/usr/bin/env python3
import argparse
import collections
import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
CAPTURES_DIR = REPO_ROOT / "interop-tests" / "captures"
NETSHOOT_IMAGE = "nicolaka/netshoot:v0.16"
EXPERT_SEVERITY_ERROR = "8388608"

# The SMPP port each peer's compose overlay exposes its SMSC on.
PORT_BY_PEER = {
	"kannel": 2775,
	"smppsim": 2775,
	"smscsim": 2775,
}

# The 33 SMPP commands (SMPP 3.4), by numeric command_id, for the tshark histogram.
COMMAND_NAMES = {
	0x00000001: "bind_receiver",
	0x00000002: "bind_transmitter",
	0x00000003: "query_sm",
	0x00000004: "submit_sm",
	0x00000005: "deliver_sm",
	0x00000006: "unbind",
	0x00000007: "replace_sm",
	0x00000008: "cancel_sm",
	0x00000009: "bind_transceiver",
	0x0000000B: "outbind",
	0x00000015: "enquire_link",
	0x00000021: "submit_multi",
	0x00000102: "alert_notification",
	0x00000103: "data_sm",
	0x00000111: "broadcast_sm",
	0x00000112: "query_broadcast_sm",
	0x00000113: "cancel_broadcast_sm",
	0x80000000: "generic_nack",
	0x80000001: "bind_receiver_resp",
	0x80000002: "bind_transmitter_resp",
	0x80000003: "query_sm_resp",
	0x80000004: "submit_sm_resp",
	0x80000005: "deliver_sm_resp",
	0x80000006: "unbind_resp",
	0x80000007: "replace_sm_resp",
	0x80000008: "cancel_sm_resp",
	0x80000009: "bind_transceiver_resp",
	0x80000015: "enquire_link_resp",
	0x80000021: "submit_multi_resp",
	0x80000103: "data_sm_resp",
	0x80000111: "broadcast_sm_resp",
	0x80000112: "query_broadcast_sm_resp",
	0x80000113: "cancel_broadcast_sm_resp",
}


def sh(cmd: list[str], **kwargs: object) -> subprocess.CompletedProcess:
	print("+", " ".join(cmd), file=sys.stderr)
	return subprocess.run(cmd, cwd=REPO_ROOT, check=False, **kwargs)


def compose_cmd(peer: str, *args: str) -> list[str]:
	return [
		"docker", "compose",
		"-f", "compose.yaml",
		"-f", f"interop-tests/compose.{peer}.yaml",
		*args,
	]


def fix_capture_ownership() -> None:
	# dumpcap's own file permissions (0750, root:root) mean the sidecar has to run as root, so
	# captures/ comes out root-owned; fixed up here rather than with host sudo. The directory is
	# left world-writable so the next run's root-owned dumpcap can still create files in it.
	sh(["docker", "run", "--rm", "-v", f"{CAPTURES_DIR}:/captures", "--entrypoint", "chown", NETSHOOT_IMAGE, "-R", "1000:1000", "/captures"])
	sh(["docker", "run", "--rm", "-v", f"{CAPTURES_DIR}:/captures", "--entrypoint", "chmod", NETSHOOT_IMAGE, "0777", "/captures"])


def walk(node: object):
	if isinstance(node, dict):
		yield node
		for value in node.values():
			yield from walk(value)
	elif isinstance(node, list):
		for item in node:
			yield from walk(item)


def collect(node: object, key: str) -> list[object]:
	return [item[key] for item in walk(node) if isinstance(item, dict) and key in item]


def analyse_capture(peer: str, port: int) -> tuple[int, dict[str, object]]:
	pcap = CAPTURES_DIR / f"{peer}.pcapng"

	if not pcap.exists():
		print(f"no capture file at {pcap}", file=sys.stderr)

		return 1, {}

	decoded = sh([
		"docker", "run", "--rm", "-v", f"{CAPTURES_DIR}:/captures", NETSHOOT_IMAGE,
		"tshark", "-r", f"/captures/{peer}.pcapng",
		"-d", f"tcp.port=={port},smpp",
		"-Y", "smpp",
		"-T", "json",
	], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

	if decoded.returncode != 0:
		print(decoded.stderr, file=sys.stderr)

		return 1, {}

	frames = json.loads(decoded.stdout or "[]")
	(CAPTURES_DIR / f"{peer}.json").write_text(decoded.stdout)

	histogram: collections.Counter = collections.Counter()
	malformed = 0
	expert_errors = 0

	for frame in frames:
		for command_id in collect(frame, "smpp.command_id"):
			name = COMMAND_NAMES.get(int(str(command_id), 16), str(command_id))
			histogram[name] += 1

		if collect(frame, "_ws.malformed"):
			malformed += 1

		expert_errors += sum(
			1 for severity in collect(frame, "_ws.expert.severity") if severity == EXPERT_SEVERITY_ERROR
		)

	print(f"frames: {len(frames)}")
	print("commands:")
	for name, count in sorted(histogram.items()):
		print(f"  {name}: {count}")
	print(f"malformed: {malformed}")
	print(f"expert errors: {expert_errors}")

	status = 1 if malformed > 0 or expert_errors > 0 else 0

	return status, {
		"commands": dict(histogram),
		"expertErrors": expert_errors,
		"frames": len(frames),
		"malformed": malformed,
	}


def main() -> int:
	parser = argparse.ArgumentParser()
	parser.add_argument("peer")
	parser.add_argument("--keep", action="store_true", help="leave the peer up for a manual look")
	args = parser.parse_args()

	port = PORT_BY_PEER.get(args.peer)

	if port is None:
		print(f"no SMPP port known for peer {args.peer!r}; add it to PORT_BY_PEER in run.py", file=sys.stderr)

		return 2

	# dumpcap can't be given 1000:1000 (see fix_capture_ownership), so it creates this file as
	# root; overwriting one from a previous run then fails, since root here has no DAC override
	# either - so the stale file has to go before a fresh one can be written in its place.
	(CAPTURES_DIR / f"{args.peer}.pcapng").unlink(missing_ok=True)

	tests = sh(compose_cmd(
		args.peer, "run", "--rm", "--use-aliases", "node",
		"node", "--test", f"interop-tests/{args.peer}.test.ts",
	))
	sh(compose_cmd(args.peer, "stop", "capture"))
	fix_capture_ownership()

	analysis_status, _ = analyse_capture(args.peer, port)

	if not args.keep:
		sh(compose_cmd(args.peer, "down", "-v"))

	return 1 if tests.returncode != 0 else analysis_status


if __name__ == "__main__":
	sys.exit(main())
