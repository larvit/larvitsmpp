# 06 python-php

Date: 2026-09-06. Repo commit: `ab93833` (working tree, phase 6 changes uncommitted on top). Host
Docker: 29.6.2. Images: `interop-python:2.2.4-3.12.14` (`python:3.12.14-slim-bookworm` +
`pip install smpplib==2.2.4`), `interop-php:8.4.25-1d3b53c` (php-smpp,
`alexandr-mironov/php-smpp`, cloned at commit `1d3b53c2d2b63d51ab70009d956914b7f8903118`, built on
`php:8.4.25-cli`), `nicolaka/netshoot:v0.16` (capture sidecar), `node:24.18.0-bookworm-slim` (test
runner, from the root `compose.yaml`).

## Setup

Each peer is a small driver (`interop-tests/peers/<peer>/driver.{py,php}`) exposing an HTTP command
channel the node test file drives, the same shape as the Java drivers in phase 5 - one long-lived
process per peer holding named client sessions open across requests.

- **python**: `driver.py` runs a `ThreadingHTTPServer`; each named session is a `smpplib.client.Client`
  plus a background thread calling `read_once()` in a loop once `/startReader` is called. A plain
  `submit_sm` is answered by `@larvit/smpp` only once the application calls `sms.sendResp()` (README,
  Server), so `/submit` sends and returns the sequence number immediately rather than blocking for
  the ack - a synchronous wait here deadlocks against the node test's own "wait for the sms, then
  answer it" flow. `/ack?name=&sequence=` polls the result afterwards. A multipart submit is
  answered automatically by the library on arrival, so `/submitLong` keeps its per-part
  `wait_ack()`, unaffected by the same deadlock.
- **php**: `driver.php` is a hand-rolled single-connection-at-a-time HTTP server (no framework),
  since php-smpp itself is fully synchronous - every send blocks reading its own response on the
  same call. This means a plain submit deadlocks against `sendResp()` exactly as above, but there is
  no background thread to poll afterwards, so the fix is the opposite one: the node test's global
  `session.on('sms', ...)` handler calls `sendResp()` immediately for every arrived sms (the same
  pattern `kannel.test.ts` uses for its "maxp1" burst, generalised here to the whole file). A
  `deliver_sm` built by hand from the node side and read via `/receive` (php's blocking `readSMS()`)
  has the same shape in reverse: the `/receive` call has to be in flight before the `deliver_sm`
  goes out, or `session.send()`'s own wait for `deliver_sm_resp` has nothing to unblock it yet.

Build snags, fixed in the Dockerfile, not in `src/`:

- **PHP 8's `sockets` extension returns a `Socket` object from `socket_create()`, not a resource.**
  This fork's `Socket::isOpen()` (written pre-PHP8) checks `is_resource($this->socket)` alone, so it
  is always `false` on PHP 8.x, and every guarded call - `bindReceiver()`, `bindTransmitter()`,
  `bindTransceiver()`, `close()`, `sendCommand()` - throws `SocketTransportException('Socket is not
  open')` immediately, regardless of the actual connection. The whole library is unusable on PHP 8+
  without this. Patched with a build-time `sed` on `src/transport/Socket.php` (also accept
  `$this->socket instanceof \Socket`), not in the vendored source itself.
- `mbstring` needs `libonig-dev` on this base image; the official image warns "mbstring is already
  loaded" (it is bundled but not built as a shared extension), harmless.

Two runs each of `./interop-tests/run.py python` and `./interop-tests/run.py php`, all four stable:
python 13/13 both times (frames 449/450, `enquire_link` ~185, `submit_sm`/`submit_sm_resp` 24/24,
`deliver_sm`/`_resp` 3/3, malformed 0, expert errors 0); php 9/9 both times (frames 42,
`bind_transmitter`/`bind_receiver`/`bind_transceiver` and their resps all matched, `submit_sm`/`_resp`
11/11, `deliver_sm`/`_resp` 1/1, malformed 0, expert errors 0).

## Scenarios (PLAN.md)

| Id | Result | Evidence |
| --- | --- | --- |
| S11 GSM 03.38 basic table + extension table (python) | pass, one peer-side quirk | `python.test.ts` "GSM 03.38 basic table + extension table round trip": whole 127-char table (minus the escape character itself) plus `€[]{}\|~^` round-trips exactly |
| S11 form feed (python) | pass, one peer-side quirk | `python.test.ts` "form feed (0x1B 0x0A)...": raw `1b 0a` appended after `gsm_encode()`'s own bytes decodes to `\f` |
| S11 Latin-1 (python) | pass | `python.test.ts` "Latin-1 round trip" |
| S11 UCS-2 with 一 and an emoji (python) | pass | `python.test.ts` "UCS-2 with 一 and an emoji round trip" |
| S11 reverse direction, GSM and UCS-2 (python) | pass | `python.test.ts` "reverse direction: server sends ... text back, python decodes it the same way" (both) |
| S11 the 0x5F quirk, both ways | pass (documents the peer's own table, not asserted as our defect) | `python.test.ts` "peer quirk, documented both ways: byte 0x5F..." |
| S2 UDH 2/3/10 segments (python) | pass | `python.test.ts` "S2 - long messages", one `sms` per size, `answeredOnArrival` true, ids `<base>-1..N` |
| S2 `CSMS_16BIT_TAGS`, `CSMS_PAYLOAD`, `CSMS_8BIT_UDH` (php) | pass, all three | `php.test.ts` "S2 - long messages (php-smpp, three CSMS spellings)" |
| S4 separate TX/RX binds (php) | pass | `php.test.ts` "S4 - bind direction": `boundAs`/`bindAllows()` both ways, `submit_sm` on RX → `ESME_RINVBNDSTS` (status 4) and the peer keeps working, `submit_sm` on TX unaffected, `deliver_sm` reaches RX only (TX's own `/receive` times out) |
| Keepalive, reactive `enquire_link` (python) | pass | `python.test.ts` "Keepalive...": silent past 40s idleTimeout → session closes; `auto_send_enquire_link` with a 10s client timeout → survives the same 45s |
| Refusal via `onRequest` (python, php) | pass, both peers | `python.test.ts`/`php.test.ts` "Refusals via onRequest": `ESME_RTHROTTLED` surfaced as the ack status (python) or a caught `SmppException` code (php); `enquire_link` and a follow-up submit both still work |

## Defects in @larvit/smpp

None found. Every encoding, both directions, every long-message spelling from both peers, the
bind-direction enforcement, the idle/keepalive behaviour, and the `onRequest` refusal path all
matched the README and the spec.

## Peer quirks

- **python-smpplib's `gsm.GSM_CHARACTER_TABLE` disagrees with GSM 03.38 (and this library) at one
  code point: 0x5F.** The real table's value there is SECTION SIGN (§); smpplib's own table (its
  `gsm.py` docstring already calls it "vendor-specific and not recommended for use") has a backtick
  instead. Encoding a literal backtick through `gsm.gsm_encode()` sends byte `0x5F`, which this
  library correctly decodes to §; sending §'s own byte back and decoding it through smpplib's table
  (as the driver's `gsm_decode()` deliberately does, to compare like for like) reads a backtick, not
  a §. Both directions reproduced in `python.test.ts`'s "peer quirk" test. Confirmed by diffing
  `smpplib.gsm.GSM_CHARACTER_TABLE[:128]` against this library's own `gsmChars` table (identical at
  every other of the 128 positions).
- **`gsm.gsm_encode()` cannot produce a form feed at all.** The character table represents that
  extension-table slot with a placeholder backtick, not the literal `\x0c` character, so
  `GSM_CHARACTER_TABLE.index('\x0c')` raises `ValueError` (wrapped as `UnicodeError`) for any attempt
  to encode one. The driver builds the `1b 0a` byte pair by hand for that one character (see
  `python.test.ts`'s "form feed" test) rather than through the library's own encoder.
- **`auto_send_enquire_link` defaults to `True`**, on `read_once()`/`poll()`/`listen()` - not opt-in,
  correcting `research/esme-clients-and-validators.md`'s A4 note. The driver passes it explicitly
  either way so both keepalive scenarios are deliberate.
- **php-smpp's `GsmEncoderHelper::utf8_to_gsm0338()` has no dictionary entry for ¤ (CURRENCY SIGN,
  U+00A4, GSM 03.38 code `0x24`).** `strtr()` only rewrites characters present in its dict; ¤ passes
  through as its raw two-byte UTF-8 sequence (`c2 a4`), which this library's GSM decoder (correctly,
  since neither byte is in the 128-entry table) renders as two spaces. Reproduced manually (not
  asserted in `php.test.ts`, to keep that suite's own assertions unambiguous): submitting
  `"price:¤100"` at `data_coding` 0 arrives as `"price:  100"`.
- **This php-smpp fork's `bindTransceiver()` actually works**, against both the plan's premise and
  the fork's own inherited README ("You can't connect as a transceiver, otherwise supported by SMPP
  v.3.4" - upstream OnlineCity text, unchanged by this fork despite `Client.php` plainly implementing
  `bindTransceiver()`). Confirmed directly: `php.test.ts`'s "Peer quirk: bindTransceiver() actually
  works" binds one against `server()` and gets `boundAs === 'transceiver'`. `php.test.ts`'s S4
  scenarios still use separate TX/RX binds deliberately, since that is the shape target 8 needs
  regardless of whether TRX also happens to work.
- **This fork's `composer.json` declares `"license": "LGPL-2.0-or-later"`**, though no top-level
  `LICENSE` file exists in the repo - correcting the plan's "no licence declared" for this specific
  fork (true of the field, not true of the declaration). Still test-only per the phase brief; not
  vendored into this repo either way.
- **`submit_sm()`'s returned message id carries a trailing NUL byte** (`unpack("a*msgid", ...)`
  keeps it, unlike PHP's `A`-format unpack which would trim it) - cosmetic, not asserted against in
  `php.test.ts`.

## Open questions

- Whether php-smpp's other `is_resource()`-adjacent assumptions (none found beyond `isOpen()` in this
  version) would surface on a longer-running session than these scenarios exercise.
- Whether smpplib's `0x5F` table quirk affects any other vendor beyond this one - not checked against
  a second Python client, since none of comparable maturity was in scope for this phase.
