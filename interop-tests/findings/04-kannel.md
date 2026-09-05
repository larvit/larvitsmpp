# 04 kannel

Date: 2026-09-05. Repo commit: `9c4939f` (working tree, phase 4 changes uncommitted on top).
Host Docker: 29.6.2. Images: `interop-kannel:1.4.5-12` (`debian:bookworm-20260824-slim` +
`kannel=1.4.5-12`, four config variants), `nicolaka/netshoot:v0.16` (capture sidecar and tshark),
`node:24.18.0-bookworm-slim` (test runner, from the root `compose.yaml`).

## Setup

Four `bearerbox`+`smsbox` pairs, one Docker image, four config variants under
`interop-tests/peers/kannel/` (`main.conf`, `iv33.conf`, `maxpending1.conf`,
`notransceiver.conf`), all dialling the same `node:2775`. Only the `main` variant's link is
captured (each container only sees its own veth). Submits go in over `smsbox`'s `sendsms` HTTP API;
MO and DLR callbacks come out to a tiny HTTP receiver in `kannel.test.ts` (`/mo`, `/mo/iv33`,
`/mo/maxp1`, `/mo/notrx`, `/dlr`).

Two snags fixed while building the harness, both in the compose/config layer, not the peer:

- `smsbox`'s HTTP client to the `sms-service` `get-url` and to `dlr-url` occasionally lost the
  connect race under this sandbox's networking ("Socket not connected", no retry by default).
  Added `http-request-retry = 3` / `http-queue-delay = 1` to every `smsbox` group.
- 1.4.5-12 refuses one `group = smsc` block that sets both `port` and `receive-port` ("deprecated"
  option combination) - `notransceiver.conf`'s separate TX/RX bind needs **two** `group = smsc`
  blocks sharing one `smsc-id`, one with `port`, one with `receive-port`, not one block with both.

Two runs of `./interop-tests/run.py kannel`, back to back, both exit 0, both `tests 21, pass 21,
fail 0`:

```
run 1: frames 60,  submit_sm 11/submit_sm_resp 8, deliver_sm 11/11, enquire_link 8/8,  generic_nack 1
run 2: frames 66,  submit_sm 11/submit_sm_resp 8, deliver_sm 12/12, enquire_link 10/10, generic_nack 1
```

malformed: 0, expert errors: 0, both runs. `submit_sm` outrunning `submit_sm_resp` and the varying
`enquire_link` count are the wait-ack-expiry scenario (below), not a defect - it deliberately holds
a response past Kannel's `wait-ack` window and lets Kannel reconnect.

## Scenarios (PLAN.md)

| Id | Result | Evidence |
| --- | --- | --- |
| S1 (binds 34, submits, receipts, MO) | pass | `kannel main variant - bind`; `S1 - MT from Kannel with delivery reports` (DELIVERED/UNDELIVERABLE/EXPIRED/ENROUTE); `MO to Kannel` |
| S1 (interface_version 0x33 sub-case, target 8) | pass | `iv33 variant - interface_version 0x33`: binds at 33, no TLVs on the receipt, still correlates |
| S6 (idle/keepalive) | pass | `S6 - wait-ack expiry and keepalive`: `enquire_link` every 5s keeps a 40s `idleTimeout` session alive; a deliberately-late `sendResp()` past `wait-ack` (5s) is recorded, not asserted against (Kannel's own choice, see below) |
| S11 (encodings, target 12) | pass | `€ [ ] ~ round trip through Kannel unpacked GSM7`; long GSM and UCS-2 (with 一 and an emoji) MT reassembly |
| target 11 (window) | pass | `maxp1 variant - max-pending-submits 1`: 20 sendsms calls, `max-pending-submits = 1`, all 20 arrive in order, none dropped or duplicated |
| target 8 (separate TX/RX) | pass | `notrx variant - separate TX and RX binds`: transmitter + receiver binds; submit_sm and MO/receipt only ever cross the intended bind |

## Wire facts

- **`dlr-mask=31`'s `%d` is not one code per SMPP state.** Kannel fires two HTTP callbacks per
  settled message: `type=8` off the `submit_sm_resp` alone (before any receipt, `answer=ACK/`),
  then a final one. DELIVERED is `type=1`, ENROUTE is `type=4`, UNDELIVERABLE is `type=2` - but
  EXPIRED is `type=34` (`32|2`), its own bit, not folded into the generic failure code. A receiver
  keying only on `1`/`2`/`4`/`8` will misfile an expired message as unhandled.
- **`%P` (destination) is smsbox's own `global-sender`, not the message's real destination.** With
  no `my-number` set on the `smsc` group, an MO's `%P` reports the `smsbox` group's
  `global-sender` value verbatim (here `46700000000`), not the `deliver_sm`'s `destination_addr`.
  `%p` (source) additionally gets a `+` prepended for an international-TON address even though the
  wire address carried none; `%P` gets no such `+`.
- **`%a` (MO text) is decoded for GSM but raw for UCS-2.** For a GSM-coded MO, `%a` is the decoded
  human-readable string, safe to percent-decode as UTF-8. For UCS-2 (`coding=2`), `%a` is the
  **raw big-endian UCS-2 bytes**, percent-escaped byte-for-byte (`一` → `%4E%00`, a lone surrogate
  half → `%D8%3D` etc.) - not re-encoded as UTF-8 first. A receiver that runs
  `URLSearchParams.get('text')` (or any UTF-8-aware percent-decoder) on a `coding=2` callback gets
  mojibake, since those bytes are not valid UTF-8. The receiver must percent-decode to a raw byte
  buffer and UCS-2-decode it itself, branching on `coding`. (This tripped the test harness itself
  first - `kannel.test.ts`'s MO receiver now does exactly this via `moText()`/`percentDecodeBytes()`.)
- **A `submit_sm` in the wrong direction gets `generic_nack`, not a mismatched `*_resp`.** Calling
  `session.sendSms()` on a link where Kannel is the ESME (submit_sm only flows ESME→SMSC) gets
  answered with `generic_nack` carrying `ESME_RINVCMDID` - not a `submit_sm_resp`. Confirmed in the
  capture (frame with `command_id 0x80000000` immediately answering a `0x00000004`).
  `session.sendSms()`'s result surfaces this the same way it would a `submit_sm_resp` error
  (`result.err.message` matches `ESME_RINVCMDID`), so nothing here needed different handling - but
  a caller matching on response command id specifically would need to accept both.
- **`interface-version = "33"` negotiates cleanly.** No TLVs sent either way, receipts still carry
  `id:`/`stat:` text and still correlate to the right `smsId`.
- **`wait-ack` expiry disconnects and reconnects, it does not retry in place.** Holding a
  `submit_sm` response past Kannel's `wait-ack` (5s here) makes bearerbox log an I/O error and
  redial; the late response lands on a session Kannel has already abandoned and is harmlessly
  ignored. Kannel's own reaction, not a length this suite enforces.
- **`max-pending-submits = 1` is a strict one-at-a-time link.** A burst of sendsms calls all still
  arrive, in the order smsbox forwarded them, but only as fast as this side answers each
  `submit_sm` - the whole burst stalls behind an unanswered first message. Answering immediately
  (not batching responses) is required to observe the burst complete at all.

## Defects in @larvit/smpp

None found against Kannel across two clean runs (21/21 both times). Two bugs surfaced during this
phase were both in the test harness, not `src/`, and are already fixed in `kannel.test.ts`:

1. The MO-text UTF-8-vs-raw-UCS2 decoding gap described above (`moText`/`percentDecodeBytes`).
2. The `max-pending-submits=1` burst test originally deferred every `sendResp()` to the end of the
   test; under a window of 1, Kannel can't advance past the first unanswered `submit_sm`, so the
   burst never arrived. Fixed by answering each `sms` as it lands.

## Open questions

- Whether `type=34` for EXPIRED is Kannel-version-specific, or whether REJECTD/DELETED have their
  own similarly-unfolded bits - only EXPIRED was exercised here.
- Whether the raw-bytes-for-UCS2 `%a` behaviour also applies to `dlr-url`'s equivalent fields, or
  is MO-specific - not exercised here (this suite's `dlr-url` never carries message text).
