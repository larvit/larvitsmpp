# 01 smscsim

Date: 2026-09-05. Repo commit: `7d855cf` (working tree, phase 0+1 changes uncommitted on top).
Host Docker: 29.6.2. Images: `ukarim/smscsim:0.2.0` (peer, both `smscsim` and `smscsim-failing`),
`nicolaka/netshoot:v0.16` (capture sidecar and tshark), `node:24.18.0-bookworm-slim` (test runner,
from the root `compose.yaml`).

## Setup

Worked as designed: `interop-tests/run.py smscsim` brings up `smscsim`, `smscsim-failing` and
`capture` via `interop-tests/compose.smscsim.yaml`, waits on their healthchecks (`netstat -lnt |
grep -q :2775`, both images have a busybox shell), runs `interop-tests/smscsim.test.ts` in the
`node` service, stops the capture, decodes it with tshark, and tears down.

Two snags fixed while building the harness, both in `run.py`/the compose overlay, not the peer:

- `dumpcap`'s binary is mode `0750` root:root inside `nicolaka/netshoot:v0.16`, so the `capture`
  service has to run as root (the default) rather than `1000:1000` - matching the "otherwise fix
  ownership from run.py" fallback the brief anticipated. `run.py` chowns and chmods
  `interop-tests/captures/` to `1000:1000`/`0777` through a throwaway container after every run.
- This sandbox's Docker does not give a root container DAC-override: it can create a new file in a
  `1000:1000`-owned `0777` directory, but not overwrite an existing `1000:1000`-owned file there
  (dumpcap's own file mode, `0600`, blocks it). `run.py` now unlinks the previous
  `<peer>.pcapng` itself before every run, so `dumpcap` always creates a fresh file.
- The research notes and PLAN.md's knobs column say `FAILED_SUBMITS=1`; `main.go` actually checks
  `"true" == os.Getenv("FAILED_SUBMITS")`, so `1` is silently ignored (never fails anything). The
  compose overlay sets `FAILED_SUBMITS: "true"`.

Two runs of `./interop-tests/run.py smscsim`, back to back, both exit 0:

```
frames: 114
commands:
  bind_receiver: 1        bind_receiver_resp: 1
  bind_transceiver: 12    bind_transceiver_resp: 12
  bind_transmitter: 1     bind_transmitter_resp: 1
  deliver_sm: 20          deliver_sm_resp: 10
  enquire_link: 6         enquire_link_resp: 6
  submit_sm: 19           submit_sm_resp: 19
  unbind: 3               unbind_resp: 3
malformed: 0
expert errors: 0
```

(identical both times). `bind_transceiver` is 12, not the 5 a reconnect-free run would show (C1's
one transceiver bind + single-SMS + GSM-multipart + UCS2-multipart + MO, one each) - the extra 7
are the client's own reconnects after the defect below tears the link down; `deliver_sm_resp` is
half of `deliver_sm` for the same reason (below).

## Scenarios

| Id (from PLAN.md) | Result | Evidence |
| --- | --- | --- |
| C1 (bind transceiver/transmitter/receiver, keepalive, clean unbind) | pass | `smscsim - C1 bind, keepalive, unbind`, all 3 bind types; no `sessionError`, one `close` each |
| smoke: single SMS + DLR | pass | `smscsim - a single SMS`; DLR `statusMsg` `DELIVERED`, `smsId` matches the `submit_sm_resp` id |
| smoke: 2-segment GSM long MT | pass | `smscsim - multipart segments › a 2-segment GSM message…`; 2 ids, 2 DLRs (via retry - see defect) |
| smoke: 2-segment UCS2 long MT (一 + emoji) | pass | `smscsim - multipart segments › a 2-segment UCS2 message…`; 2 ids, 2 DLRs (via retry) |
| smoke: MO injection via web UI | pass | `smscsim - MO injection…`; `sms.from`/`to`/`message` match the posted form, `sendResp()` clean |
| C12 (smscsim part: refusal + undeliverable DLR) | pass | `smscsim-failing - C12 refusals`; refused sends name `ESME_RSYSERR`, accepted ones' DLRs name `UNDELIVERABLE`; session stayed bound throughout (`enquire_link` answered after) |

Every scenario passed both runs, but the multipart, single-SMS and MO scenarios only pass because
they retry past the defect below (`DLR_MAX_ATTEMPTS = 20` in `smscsim.test.ts`) - see Defects.

## Defects in @larvit/smpp

### An out-of-range `deliver_sm` sequence_number drops the whole link, not just that PDU

**What happened.** `smscsim` signs every `deliver_sm` it sends unprompted - a delivery receipt or
an injected MO - with a raw `rand.Int()` truncated to `uint32` for `sequence_number`
(`smsc.go`'s `deliverSmPDU`, called from both `deliveryReceiptPDU` and `SendMoMessage`), so about
half the time the value is `>= 0x80000000`. `pdu.ts`'s `parseOnce` rejects that with `Invalid
seqNr, exceeds 2147483646: <n>`, and `pdu-transport.ts`'s `read()` routes *every* `pduToObj` error -
this one included - to `onUnreadable`, which `session.ts` wires to `sessionError` +
`teardown()`. `teardown()` destroys the socket outright; with the client's default `reconnect: true`
the session then reconnects (invisibly to the caller: `sendSms()` on a mid-reconnect session just
queues until the new link is bound), but the `deliver_sm` that triggered it - and its answer, since
none is ever sent - are gone. Confirmed live: binding, then sending a 2-segment message with `dlr:
true` against a real `smscsim`, printed `SESSION ERROR Invalid seqNr, exceeds 2147483646:
4085734660` for the second segment's receipt, no `dlr` event fired for it, and the capture showed
the peer's two `deliver_sm` PDUs answered by only one `deliver_sm_resp`.

**What the spec says.** SMPP 3.4 §4.7.1: `sequence_number` is `0x00000001` to `0x7FFFFFFF`; a
value outside it is certainly not a request this library ever intends to send and arguably not
one it must answer either. But target 1 in PLAN.md is exactly this shape: "`pdu-transport.ts`
routes every codec error... to the teardown a framing error takes, although `command_length` was
honoured and the stream is still in sync." Here `command_length` is honoured, the command is
`deliver_sm`, and only one 4-byte field is out of range - the spec gives no status for "sequence
number out of range" specifically, but continuing to read the stream and refusing just this PDU
(there is no `*_resp` to send back without a valid sequence number to answer with; a `generic_nack`
naming e.g. `ESME_RINVCMDID` would need a sequence number too, which is presumably part of why the
current code gives up on the whole link) would lose one receipt instead of the link.

**Reproducer.** A minimal `deliver_sm` with every field empty/zero except the header:

```
000000210000000500000000800000010000000000000000000000000000000000
```

(33 bytes: `command_length=0x21`, `command_id=0x00000005` deliver_sm, `command_status=0`,
`sequence_number=0x80000001`, then 17 zero bytes for `service_type`..`short_message` each
empty/0.) Feeding this to `pduToObj` (`src/pdu.ts`) returns `{ err: Error("Invalid seqNr, exceeds
2147483646: 2147483649") }`; feeding it to a live session's socket reproduces the teardown.

**Severity.** Medium-high against this peer specifically: roughly half of `smscsim`'s DLRs and MOs
are silently lost and bounce the link. Against a spec-conforming peer (small incrementing sequence
numbers) it never fires, so it is plausibly why the suite's own dummy peers never caught it - which
is the whole reason this experiment exists.

**Fixed** in PR #79: only a framing error tears the link down now, any 32-bit `sequence_number` is
read and echoed, and `smscsim.test.ts`'s retry crutch is gone. A rerun of `./interop-tests/run.py
smscsim` shows 54 frames, `deliver_sm: 6` answered by `deliver_sm_resp: 6`, `bind_transceiver: 5`
(no reconnects), `malformed: 0`, `expert errors: 0`, 8/8 tests passing on their first attempt.

## Peer quirks

- No PDU validation (documented): a bad `interface_version` or malformed PDU is never rejected.
- `FAILED_SUBMITS` needs the literal string `true`; PLAN.md's research notes say `1`, which the
  peer silently ignores (see Setup).
- DLR is always exactly `DELIVERED` (or, with `FAILED_SUBMITS=true`, `UNDELIVERABLE` on odd
  sequence numbers) after a fixed ~2s; no other status is reachable.
- `FAILED_SUBMITS=true` refuses only `submit_sm`s whose *own* sequence number is even
  (`ESME_RSYSERR`); it does not otherwise vary behaviour, and the DLR-triggering rule above applies
  to every accepted submit regardless of parity.
- MO injection (the `12775` web page) always encodes the message as UCS2 (`data_coding=8`)
  regardless of its content, and requires an already-bound session whose `system_id` matches the
  form's `system_id` field exactly (`sender`, `recipient`, `message`, `system_id`, `POST /`,
  `web.go`'s `webHandler`); the response is a `303` redirect to `/?message=...` (or `?error=...`).
- Message ids and `deliver_sm` sequence numbers are `rand.Int()`-derived per-process, not reset or
  seeded per connection - not proven security-relevant here, but they are not unique across a
  restarted container in the way a UUID would be.

## Open questions

- Whether the same out-of-range-sequence-number shape reaches other peers (Jasmin, SMPPSim) or is
  particular to `smscsim`'s unconstrained `rand.Int()` - phase 2+ should watch for the same
  `sessionError` text.
- Per PLAN.md's Order of work, this defect should get a regression test in `test/` and a fix before
  phase 2 starts; both are out of scope for this experiment (`src/`/`test/` are read-only here).
