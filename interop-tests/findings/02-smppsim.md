# 02 smppsim

Date: 2026-09-05. Repo commit: `9c4939f`. Host Docker: 29.6.2. Images: `larvitsmpp-interop/smppsim:bc29982`
(built locally here from `kwahome/smpp-sim-docker` at commit `bc299828af9046ab290da3b4957dfbc472f02bfb`,
running SMPPSim 2.6.11 on `eclipse-temurin:8u452-b09-jre`; cloned during the build with
`debian:13.2-slim`, never vendored), `nicolaka/netshoot:v0.16` (capture sidecars and tshark),
`node:24.18.0-bookworm-slim` (test runner, from the root `compose.yaml`).

## Setup

`interop-tests/peers/smppsim/Dockerfile` clones the pinned commit in a build stage and copies just
`smppsim.jar`, `lib`, `www`, `mo` and `conf/logging.properties` into the runtime stage; each
`smppsim*.props` file under the same directory is copied in and selected via the container
`command`. `interop-tests/compose.smppsim.yaml` runs nine variants of the one image (`smppsim`,
`-textdlr`, `-transition`, `-undeliv`, `-rejected`, `-accepted`, `-delayed`, `-queuefull`,
`-outbind`) plus `capture` (on `smppsim`) and `capture-textdlr`, all on one network so
`./interop-tests/run.py smppsim` covers everything in one run.

Two snags fixed while building the harness:

- **The first healthcheck (`bash -c 'echo > /dev/tcp/127.0.0.1/2775'`, 1s interval) filled the
  host's disk.** SMPPSim reads an empty connection as a malformed PDU and logs a full Java stack
  trace per attempt; with `DECODE_PDUS_IN_LOG=true` and a 1s probe interval, nine containers left
  running for ~20 minutes wrote 24GB+ of container logs between them and took the whole shared host
  to 0 bytes free (`docker run` itself started failing with "no space left on device"). Fixed by
  probing the HTTP admin port instead (`curl -sf -o /dev/null http://127.0.0.1:8884/`), which
  SMPPSim answers harmlessly, plus a `json-file` log cap (`max-size: 20m`, `max-file: "3"`) on every
  `smppsim*` service as a second line of defence. Worth knowing for anyone else pointing a 1s
  TCP-connect healthcheck at this peer.
- The `capture` sidecar's `dumpcap` needs the same root/DAC-override handling phase 1 documented
  (`interop-tests/captures/` chowned to `1000:1000`/`0777` by `run.py` after every run, stale
  `<peer>.pcapng` unlinked before the next). Once, a capture attempt failed outright
  ("Permission denied" opening the pcapng) for a reason not pinned down - not reproduced since;
  treat as a rare, unexplained flake in this harness rather than a peer issue.
- Two early runs showed `malformed: 2`, `expert errors: 2`. Both traced to this test file, not
  SMPPSim: C17's raw-UDH test used IEI `0x01` ("Special SMS Message Indication"), a real GSM 03.40
  information element with its own defined length (2 bytes), at length 1 - Wireshark's
  `gsm_sms_ud` dissector correctly flags that as malformed. Fixed by using IEI `0x70`
  (reserved-for-future-use, so no dissector validates its length) for what the test only ever
  needed to be an arbitrary, unparsed UDH element.

Two runs of `./interop-tests/run.py smppsim`, back to back, after that fix: both exit 0, 25/25
tests passing, `malformed: 0`, `expert errors: 0` in both.

## Scenarios

| Id (from PLAN.md) | Result | Evidence |
| --- | --- | --- |
| C2 (`smppsim-textdlr`) | pass | `smppsim-textdlr - C2 text-only receipts`; no TLVs, `dlr.smsId` matches `submit_sm_resp` |
| C3 (`smppsim`, TLVs on) | pass | `smppsim - C3+C7 …`; `receipted_message_id`/`message_state` TLVs present and agree with the body on every segment |
| C4 (`smppsim-transition`) | fail (peer defect, see below) | `smppsim-transition - C4 …`; intermediate report arrives, no final ever does |
| C5 (single-state variants) | pass | `smppsim single-state variants - C5 …`; UNDELIVERABLE/REJECTED/ACCEPTED each map correctly; 2-segment message's shared status confirmed, `messageDlr` confirmed absent (see Open questions) |
| C6 (`smppsim-delayed`) | pass | `smppsim-delayed - C6 …`; disconnect+reconnect observed, delayed receipt still reaches `dlr` on the new link |
| C7 (loopback, GSM 1/2/3/10-segment) | pass | same `C3+C7` suite; one id per segment, receipt per id, loopback reassembles the exact text including € and \[ \] |
| C7 (loopback, UCS2 2-segment) | pass with a defect, since fixed | `… 2-segment UCS2 …`; TLVs and loopback reassembly both correct, receipt body unreadable at this commit - `@larvit/smpp` defect below |
| C11 (bind refusal + backoff) | pass | `smppsim - C11 …`, three sub-tests, see below for what each shows |
| C12 (`smppsim-queuefull`) | pass | `smppsim-queuefull - C12 …`; `ESME_RMSGQFUL` returned, session stays bound, later send succeeds once the one-slot queue drains |
| C13 (`maxOutstanding: 1`, 10 parallel) | pass | `smppsim - C13 …`; 10 distinct, strictly-increasing ids, none lost |
| C15 (bind version) | pass (peer never declares, see below) | `smppsim - C15 …`, both 0x34 and 0x50 |
| C17 (encodings over loopback) | pass | `smppsim - C17 …`, 5 sub-tests: Latin-1, UCS-2, flash (0x10), raw 0xF0 (not flash), raw UDH+8-bit-binary |
| C18 (`smppsim-outbind`) | pass (record, not judge) | `smppsim-outbind - C18 …`; see below for the wire facts |

## Defects in @larvit/smpp

### A delivery receipt's `data_coding` is trusted to decode its body, even though the spec makes the receipt a fixed text format

**What happened.** A message sent with `encoding: 'UCS2'` gets `data_coding: 8` on its `submit_sm`.
SMPPSim's delivery receipt for it (confirmed against source, `DeliveryReceipt` extends `DeliverSM`
by copy-constructing the original `SubmitSM`) inherits that same `data_coding: 8`, but its
`short_message` is always plain ASCII text (`id:… sub:… dlvrd:… stat:…`). `pdu.ts`'s parser decodes
any non-UDH PDU's `short_message` using its own `data_coding` unconditionally
(`params.short_message = decodeMessage(message, paramNumber(params.data_coding, 0)).message`), so
the ASCII receipt bytes are read back as UCS2 (byte pairs swapped) - `id:001 sub:…` becomes
unrecoverable CJK-range glyphs, and `dlr.receipt` (hence `.stat`, `.id`, every body field) is
garbage or `undefined` for every receipt whose triggering message used a non-ASCII encoding.

**What the spec says.** SMPP 3.4 5.2.25 defines `short_message`/`message_payload` generically, but
Appendix B's receipt format is specified as fixed ASCII fields; `data_coding` on the *receipt* PDU
describes nothing about how to read that text, since the MC is reporting on a message rather than
carrying one. Trusting `data_coding` to decode a receipt body is reading a field the spec never
attaches that meaning to. The `receipted_message_id`/`message_state` TLVs are unaffected (typed
fields, not text), which is why `dlr.statusMsg` and `dlr.smsId` stay correct here - only the
body-derived `dlr.receipt` (and anything relying on it, e.g. a peer without TLVs) is lost.

**Reproducer.** `session.sendSms({ encoding: 'UCS2', dlr: true, message: 'x', from, to })` against
`smppsim`, then inspect the `dlr` event's second argument (the raw `PduObject`):
`pduObj.params.data_coding === 8` and `dlr.receipt === undefined`, while
`pduObj.tlvs.receipted_message_id`/`message_state` are present and correct. Confirmed both against
SMPPSim and by constructing the PDU directly: a `deliver_sm` with `data_coding=8`, `esm_class=4`
and an ASCII `id:0 sub:001 dlvrd:001 …` body decodes to garbage text via `pduToObj`.

**Severity.** Medium: harmless when TLVs are present (as here), since `statusMsg`/`smsId` still
resolve correctly - but total for a peer that answers `DELIVERY_RECEIPT_OPTIONAL_PARAMS=false`
(text-only, `smppsim-textdlr`'s own style) *and* accepts non-ASCII submits, where nothing would be
left to fall back on. Not reproduced against `smppsim-textdlr` here (that variant's own C2 test
only sends ASCII), so this is inferred from the mechanism, not independently confirmed there - see
Open questions.

**Fixed** in PR #81: a receipt body is read as the octets that arrived, never by its `data_coding`.

### `reconnect` never retries the very first connect or bind attempt

**What happened.** `client()` performs the socket connect and the initial bind directly, not
through the `ReconnectLoop`; on either failing (`ESME_RINVPASWD`, `ESME_RBINDFAIL`, connection
refused, …) it calls `session.close()` and returns `{ err }` with no session at all - the
`reconnect` option is never consulted. Confirmed with a wrong password and with a closed port
against `smppsim` (`smppsim - C11 …`, both "one attempt, no retry" sub-tests): each is exactly one
bind attempt, logged once, no matter how long the test then waits. `ReconnectLoop.schedule()` only
runs from `onClose()`/a failed `comeBackUp()` after a session has been up at least once - confirmed
separately by binding once, then mutating the same `options` object's `password` before dropping
the live link: the loop *does* retry with proper backoff then (`smppsim - C11 …, "a rebind refused
after a live link drops"`: 2-6 attempts over 12s, each gap ≥150ms).

**What the spec/README say.** Neither documents this boundary explicitly; `README.md`'s `reconnect`
entry reads as covering any drop uniformly. Given hard rule/goal 4 ("no bind flooding"), never
retrying a cold failure is arguably the safer default - a bad password retried forever would flood
exactly as much as this avoids it entirely - but it means a client started before its peer's
listener is up gets one shot and gives up for good, which a caller relying on `reconnect` for that
race would not expect.

**Reproducer.** `client({ host, password: 'wrong', reconnect: { minDelay: 1000, maxDelay: 4000 } })`
against `smppsim` (valid `system_id`, wrong `password`): resolves `{ err }` once, no `session`; a
`log.info` capture shows exactly one `'client - bind refused'` line even after a further 2s wait.

**Severity.** Low / informational - plausibly intentional, not previously written down anywhere
`git grep`-able in this repo.

## Peer quirks

- **`registered_delivery` 0x11 (final + intermediate together) never produces a final receipt.**
  SMPPSim's own user guide (v2.5 release notes) says "Set to 0x11 for both intermediate
  notification and final delivery receipts." `LifeCycleManager.setState()` tests
  `registered_delivery_flag == 1` or `== 2` by exact integer equality rather than a bitmask
  (`InboundQueue.addMessageState()`'s own intermediate-notification check correctly uses
  `(rd & 0x10) == 0x10`), so 17 (0x11) matches neither branch: the intermediate report (esm_class
  0x20, `ENROUTE`) always arrives, a final one never does, however long you wait. Confirmed by
  reading `LifeCycleManager.java`, `MessageState.java` and `OutboundQueue.java`, and empirically
  with a 16s wait against `smppsim-transition`.
- **Two `submit_sm`'s on the same connection without a response in between - exactly how this
  library always sends a multi-segment message's segments (`Promise.all`, never one after the
  previous one's response, a documented, deliberate design choice, not something to change here) -
  sometimes make SMPPSim lose one of the resulting receipts or loopback echoes entirely.** Never
  seen as a malformed/corrupted PDU on the wire (both kept runs, and every other run once the
  harness's own UDH bug above was fixed, show zero); the PDU that should have arrived just never
  does. Confirmed by direct A/B: a script sending two segments concurrently (this library's own
  shape) got only one of two receipts about half the time across several tries; the same script
  sending two independent `submit_sm`'s sequentially, awaiting each response before the next, never
  lost one in the same number of tries. `interop-tests/smppsim.test.ts`'s own multi-segment tests
  work around it by resending a fresh message (up to 10 times) until every segment's receipt and,
  where relevant, the loopback reassembly are all present in one attempt - see
  `sendUntilAllDlrsArrive`/`sendUntilComplete`/`dlrLooksIntact` there. The mechanism is unconfirmed
  (see Open questions).
- **`bind_resp` never carries `sc_interface_version`, whatever the ESME declared.** No
  `BindTransceiverResp`/`BindReceiverResp`/`BindTransmitterResp` class sets that TLV (confirmed
  against source). `@larvit/smpp`'s client therefore always records
  `peerInterfaceVersion === 0x00` (undeclared) and `acceptsOptionalParams() === false` against this
  peer, whether the client declared 0x34 or 0x50 - yet `smppsim` (with
  `DELIVERY_RECEIPT_OPTIONAL_PARAMS=true`) still sends `receipted_message_id`/`message_state` TLVs
  on every receipt regardless, because that gate reads the *client's own declared* version from the
  bind PDU it received, not anything it echoes back. Confirmed for both 0x34 and 0x50 (`smppsim -
  C15 …`).
- **`DelayedDrQueue`'s own poll loop is hardcoded to 5000ms** (`private static final int period =
  5000;`, not a props knob - `DELAYED_INBOUND_QUEUE_PROCESSING_PERIOD` is a different queue, for
  redelivery after `ESME_RMSGQFUL`). `DELAY_DELIVERY_RECEIPTS_BY` is a floor, not the delay: a
  receipt configured for an 8000ms delay can take up to ~13000ms in practice. Confirmed by direct
  measurement (an 11s wait saw nothing; 16s did).
- **Message ids are decimal, a per-process global counter** (`message_id++`, not per-connection),
  starting at 0 unless `START_MESSAGE_ID_AT`/`MESSAGE_ID_PREFIX` are set (neither is here) - matches
  the research notes; `submit_sm_resp` and every receipt spelling (TLV and body `id:`) agree, so no
  `smsIdFormat` was needed anywhere in this suite.
- **The receipt body's echoed-message field is `Text:` (capitalised, not `text:`)** and carries up
  to the first 20 bytes of the original message when it is non-empty - never the empty `text:` some
  other peers (documented: LINK) send. `@larvit/smpp`'s parsing is already case-insensitive, so this
  needed no special handling.
- **`outbind()` closes the socket immediately after writing, without reading anything back.**
  Confirmed against source (`Smsc.outbind()`: `out.write(...); out.flush(); out.close(); s.close();`
  with no read in between) and on the wire (`smppsim-outbind - C18 …`): our server's
  `incomingPduObj` sees the `outbind` (`system_id: smppclient1`), `onRequest` tries to answer
  `ESME_RINVBNDSTS` and fails before writing anything (`outbind_resp` is not a defined command, so
  `pduReturn` errors first) - `sessionError` fires with `"outbind" has no response command`, no PDU
  reaches the wire, matching target 6. Whether our socket sees SMPPSim's own close land as a clean
  `close` was observed but not asserted against, per the task ("record, do not judge").
- **`outbind` fires the moment SMPPSim has an MO to deliver and no receiver is bound** - not on a
  timer. `InboundQueue.processQueue()`'s wait/notify wakes on `iq.addMessage(...)`, and moves
  straight to `PENDING_QUEUE` + `outbind()` when `getReceiverBoundCount() == 0`; the MO Injection
  endpoint (`GET /inject_mo?source_addr=…&destination_addr=…&short_message=…`, not `/inject_mo.htm`
  as the docs might suggest - that path is the *form*, `/inject_mo` is the handler) works with zero
  ESMEs ever bound, which is what let this test trigger `outbind` deterministically instead of
  racing `DELIVERY_MESSAGES_PER_MINUTE` against container startup.

## Open questions

- Whether the `data_coding`-decodes-the-receipt-body defect also loses receipts against a peer
  answering `DELIVERY_RECEIPT_OPTIONAL_PARAMS=false` (no TLV fallback) - `smppsim-textdlr`'s own
  scenario here only exercises an ASCII message, so the compounding case (non-ASCII + no TLVs) is
  untested.
- The exact mechanism behind the occasional lost receipt/loopback echo under concurrent
  `submit_sm`'s. A plausible read of SMPPSim's threading (the connection-handler thread writing
  `submit_sm_resp`s and loopback echoes, a separate `OutboundQueue`/`InboundQueue` thread writing
  receipts, both against the same socket with no synchronisation found in
  `StandardConnectionHandler`) would predict corruption, not a clean loss - but no malformed PDU
  was ever observed for a genuine SMPPSim-authored frame in this suite, so that read is unconfirmed
  and the actual mechanism (dropped at the SMPPSim side before it ever reaches the wire, versus
  something on our side discarding a well-formed PDU) is still open.
- Phase 2's own instructions call for `smppsim-accepted`/`-rejected` as "similar single-state
  variants... if cheap"; both were cheap and are included, alongside `-undeliv`.
