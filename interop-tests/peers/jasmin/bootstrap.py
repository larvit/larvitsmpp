#!/usr/bin/env python3
"""Boot-time jcli bootstrap for one Jasmin instance: group, users, an smppc connector pointing at
our own server(), and the MT/MO routes that wire it up. jcli (port 8990) is a Twisted telnet
console: no negotiation reply is needed, the server proceeds regardless (confirmed empirically)."""
import os
import socket
import sys
import time

JCLI_HOST = os.environ.get('JCLI_HOST', 'jasmin')
JCLI_PORT = int(os.environ.get('JCLI_PORT', '8990'))
JCLI_USER = os.environ.get('JCLI_USER', 'jcliadmin')
JCLI_PASS = os.environ.get('JCLI_PASS', 'jclipwd')

GROUP = os.environ.get('GROUP', 'clients')
ESME_UID = os.environ.get('ESME_UID', 'esme1')
ESME_PASSWORD = os.environ.get('ESME_PASSWORD', 'esme1pw')
ESME2_UID = os.environ.get('ESME2_UID', 'esme2')
ESME2_PASSWORD = os.environ.get('ESME2_PASSWORD', 'esme2pw')
ESME2_THROUGHPUT = os.environ.get('ESME2_THROUGHPUT', '0.1')

CONNECTOR_CID = os.environ.get('CONNECTOR_CID', 'upstream')
CONNECTOR_HOST = os.environ.get('CONNECTOR_HOST', 'node')
CONNECTOR_PORT = os.environ.get('CONNECTOR_PORT', '2777')
CONNECTOR_USERNAME = os.environ.get('CONNECTOR_USERNAME', 'upstreamesme')
# <=8 chars: SMPP's password is a C-octet-string with an 8-char + NUL wire maximum, which Jasmin's
# own smpp.pdu encoder enforces strictly when it builds the connector's own bind PDU (unlike our
# library's encoder, which is permissive) - a longer one throws mid-bind on every single attempt.
CONNECTOR_PASSWORD = os.environ.get('CONNECTOR_PASSWORD', 'upstrmpw')


class Jcli:
	def __init__(self, host, port):
		last_err = None
		for _ in range(60):
			try:
				self.sock = socket.create_connection((host, port), timeout=5)
				self.sock.settimeout(5)
				self._drain()
				return
			except OSError as err:
				last_err = err
				time.sleep(1)
		raise RuntimeError(f'could not reach jcli at {host}:{port}: {last_err}')

	def _drain(self, wait=0.4):
		time.sleep(wait)
		buf = b''
		try:
			while True:
				chunk = self.sock.recv(65536)
				if not chunk:
					break
				buf += chunk
		except socket.timeout:
			pass
		return buf

	def send(self, line, wait=0.4):
		self.sock.sendall(line.encode() + b'\r\n')
		return self._drain(wait).decode(errors='replace')

	def login(self, user, password):
		self._drain()
		self.send(user)
		reply = self.send(password)
		if 'Welcome to Jasmin' not in reply:
			raise RuntimeError(f'jcli login failed: {reply!r}')

	def run(self, *lines, label=''):
		"""Sends a sequence ending in 'ok' and fails loudly if Jasmin refused it. Checking only for
		keywords missed 'Failed adding connector, check log for details' once, which left the
		session stuck at the '>' sub-prompt and every later command misread as a key inside it - so
		this also insists the last reply lands back on the top-level 'jcli :' prompt."""
		out = []
		for line in lines:
			out.append(self.send(line))
		joined = '\n'.join(out)
		last = out[-1] if out else ''
		back_at_top = last.rstrip().endswith('jcli :')
		keyword_hit = any(word in joined.lower() for word in ('error', 'must set', 'unknown', 'invalid', 'failed'))
		if keyword_hit or not back_at_top:
			raise RuntimeError(f'{label} failed (last reply {last!r}):\n{joined}')
		return joined


def main() -> int:
	jcli = Jcli(JCLI_HOST, JCLI_PORT)
	jcli.login(JCLI_USER, JCLI_PASS)

	print(jcli.run('group -a', f'gid {GROUP}', 'ok', label='group'))

	print(jcli.run(
		'user -a', f'uid {ESME_UID}', f'gid {GROUP}', f'username {ESME_UID}', f'password {ESME_PASSWORD}', 'ok',
		label='user esme1',
	))

	print(jcli.run(
		'user -a', f'uid {ESME2_UID}', f'gid {GROUP}', f'username {ESME2_UID}', f'password {ESME2_PASSWORD}', 'ok',
		label='user esme2',
	))
	print(jcli.run(
		f'user -u {ESME2_UID}', f'mt_messaging_cred quota smpps_throughput {ESME2_THROUGHPUT}', 'ok',
		label='user esme2 throughput quota',
	))

	print(jcli.run(
		'smppccm -a',
		f'cid {CONNECTOR_CID}',
		f'host {CONNECTOR_HOST}',
		f'port {CONNECTOR_PORT}',
		f'username {CONNECTOR_USERNAME}',
		f'password {CONNECTOR_PASSWORD}',
		'bind transceiver',
		'con_fail_delay 2',
		'con_loss_delay 2',
		# The connector's own default (1) is 1 msg/s - a second submit while the first is still
		# in flight (a message's 2nd segment, or a 2nd message sent right after) then never reaches
		# the connector's peer at all inside any sane test budget; see findings/03-jasmin.md.
		'submit_throughput 0',
		'ok',
		label='smppccm',
	))
	started = jcli.send(f'smppccm -1 {CONNECTOR_CID}')
	print(started)
	if 'Successfully started' not in started:
		raise RuntimeError(f'smppccm -1 {CONNECTOR_CID} failed: {started!r}')

	print(jcli.run(
		'mtrouter -a', 'type DefaultRoute', 'order 0', f'connector smppc({CONNECTOR_CID})', 'rate 0.0', 'ok',
		label='mtrouter',
	))
	print(jcli.run(
		'morouter -a', 'type DefaultRoute', 'order 0', f'connector smpps({ESME_UID})', 'ok',
		label='morouter',
	))

	jcli.send('persist')
	jcli.send('quit', wait=0.2)
	print('jasmin bootstrap complete')

	return 0


if __name__ == '__main__':
	sys.exit(main())
