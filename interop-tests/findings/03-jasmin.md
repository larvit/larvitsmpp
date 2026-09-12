# 03 jasmin

Date: 2026-09-06. Repo commit: `db02f00`. Host Docker: 29.6.2. Images: `jookies/jasmin:0.11.0`
(both directions), `redis:8.8.2-alpine`, `rabbitmq:3.13.7-management-alpine` (fallback - see
below), `python:3.13.7-slim-bookworm` (jcli bootstrap), `nicolaka/netshoot:v0.16` (capture),
`node:24.18.0-bookworm-slim` (test runner, from the root `compose.yaml`).

## Setup

Two full Jasmin instances (`jasmin`, `jasmin-datasm`), each with its own `redis`/`rabbitmq` pair -
kept separate rather than shared, since two unrelated Jasmin instances sharing a broker is the
kind of proximity-only coupling the project avoids. `jasmin-datasm` mounts a custom `jasmin.cfg`
(`[dlr-thrower] dlr_pdu = data_sm`) for C9/target 4. Both run a `jcli` bootstrap
(`interop-tests/peers/jasmin/bootstrap.py`, a plain socket client - no telnet negotiation reply is
needed, the server proceeds regardless) that creates a group, two users (`esme1` for most
scenarios, `esme2` with a throttled `smpps_throughput` quota for C12), an `smppccm` connector
("upstream"/"upstreamds") pointing at our own `node` container, and `mtrouter`/`morouter`
`DefaultRoute`s wiring MT to that connector and MO back to `smpps(esme1)`. `interop-tests/jasmin.test.ts`
runs one persistent `server()` on `node:2777` as the fake real-world SMSC both connectors bind out
to, plus a tiny HTTP listener for Jasmin's DLR-thrower webhook (S7).

**RabbitMQ 4.3.5 does not work with Jasmin 0.11.0**: its `txamqp` client declares
transient/non-exclusive queues, a feature RabbitMQ 4.x refuses by default ("transient_nonexcl_queues
... not permitted anymore"), so `RouterPB`/`DLRThrower` fail to start. Fell back to the 3.13 series;
`rabbitmq:3.13.7-management-alpine` starts clean.

Snags fixed while building the harness, roughly in the order found:
- **jcli commands after `smppccm -a` need loud failure detection, not keyword-sniffing.** A failed
  `ok` ("Failed adding connector, check log for details") doesn't contain any of "error"/"unknown"/
  "invalid" - it left the bootstrap's own session stuck at the `>` sub-prompt, and every later
  command was misread as a key inside it. Fixed by also checking the last reply lands back on the
  top-level `jcli :` prompt.
- **The connector's password has an 8-character wire maximum.** SMPP's `password` is a C-octet-string
  with an 8-char + NUL limit; Jasmin's own `smpp.pdu` encoder enforces it strictly when it builds the
  connector's own bind PDU (our library's encoder is permissive and doesn't). A 10-char password
  made every single connector bind throw mid-encode (`ValueError: COctetString is longer than
  allowed maximum size (9)`), logged only in the connector's own per-CID log file
  (`/var/log/jasmin/default-<cid>.log`), not in the main Jasmin process log.
- **`session.userData` is unset when the `session` event fires** (it fires on raw connect, before
  `authenticate()` runs) - populating a map off it there silently never worked. Fixed like
  `kannel.test.ts`'s `bindPdus`: read the bind PDU's own `system_id` from `incomingPduObj` instead,
  and only read `userData` later, from `sms`, once authenticate() has long since run.
- **Jasmin's own MT dispatch to one connector is strictly serialized** (see the defect below) -
  moving `C13`/`S7`'s HTTP-send test ahead of `C3+C7`'s multi-segment sends in file order (both need
  the same connector's queue to be unstuck) turned three tests that always failed into two that
  always pass.
- The `jasmin`/`jasmin-datasm` healthcheck probes the HTTP API port (1401) with a bare TCP connect,
  no bytes written - Jasmin's SMPP codec, like SMPPSim's, is not something to probe with an empty
  PDU. `rabbitmq` uses `rabbitmq-diagnostics -q ping`.
- Bootstrap and the whole `docker compose up` sequence are slow and variable on this host - jcli's
  own connector/router commands (which round-trip through AMQP/redis, unlike the plain in-memory
  group/user commands) sometimes took most of a minute each under contention; the harness itself
  budgets for it (`run.py` runs past its own foreground tool timeout and is watched to completion),
  not something to read as a Jasmin defect.

Three runs of `./interop-tests/run.py jasmin`, all after the fixes above: all exit non-zero (the
4 failing tests below), all `malformed: 0`, `expert errors: 0`. Wire commands, from the last run:

Re-run 2026-09-06, after every defect below was fixed and after `run.py` learned to refuse a capture
holding no frames: exit 0, 19 of 19 tests pass, 175 frames, `malformed: 0`, `expert errors: 0`. The
four multi-segment failures are gone with the deadlock, and the counts below are the state that
found the defects, kept because that is what the reproducers refer to.

```
bind_transceiver: 14, bind_transmitter: 1, bind_receiver: 6 (+ their _resp)
submit_sm: 45, submit_sm_resp: 43
deliver_sm: 15, deliver_sm_resp: 1
enquire_link: 7, enquire_link_resp: 7
unbind: 1, unbind_resp: 1
```

## Scenarios

| Id | Result | Evidence |
| --- | --- | --- |
| C1 | pass | `binds transceiver, sees Jasmin's own enquire_link, unbinds clean`; `binds transmitter`; `binds receiver` |
| C3+C7 (single-segment) | pass | `single-segment GSM with extension chars`: UUID id, `receipted_message_id`/`message_state` TLVs present, `DELIVERED` |
| C3+C7 (multi-segment) | **fail (peer/library interaction, see Defects)** | `2-segment`/`3-segment`/`10-segment GSM`, `2-segment UCS2`: every attempt across 3 runs times out waiting for a receipt |
| C8 target 3 (SAR) | pass | `SAR-segmented deliver_sm from the fake upstream`: reassembles into one whole `sms` |
| C8 target 3 (UDH) | pass | `UDH-segmented deliver_sm from the fake upstream`: reassembles into one whole `sms` |
| C8 target 2 (`message_payload`) | pass (defect confirmed) | `a deliver_sm carrying message_payload instead of short_message`: Jasmin accepts and relays it; our `sms` arrives with an empty message - see Defects |
| C9 target 4 (`data_sm` DLR) | pass (defect confirmed) | `a receipt thrown as data_sm is not read as a dlr`: the raw `data_sm` PDU is seen, no `dlr` event ever fires - see Defects |
| C11 | pass | `wrong password: one attempt, no retry` (`ESME_RINVPASWD`); `a rebind refused after a live link drops: backs off, never floods` (2-8 attempts, ≥150ms apart) |
| C12 | pass | `flooding submits past the quota`: `ESME_RTHROTTLED` from `esme2`'s `smpps_throughput 0.1` quota on some of 15 parallel sends; session stays bound; a later send succeeds once the next slot opens |
| C13 | pass | `every send is answered, none lost, order preserved`: 10 distinct ids, arrival order matches send order |
| S7 | pass | `a message pushed through /send arrives as submit_sm`: HTTP `/send` → Jasmin → connector → our `server()`; our `sendResp()`+`sendDlr('DELIVERED')` fires Jasmin's own DLR webhook, both the SMSC-ack (`ESME_ROK`) and terminal (`DELIVRD`) callbacks at `dlr-level=3`; long GSM and UCS-2 MO pushes from our server reassemble whole at Jasmin's connector |

## Defects in @larvit/smpp

### `message_payload` is never read (target 2) - confirmed against a real peer

**What happened.** Jasmin's connector accepts a `deliver_sm` with `sm_length` 0 and the text in a
`message_payload` TLV from our fake upstream SMSC without complaint, and relays it through
`morouter` to our real client bound to Jasmin's `smpps`. The `sms` event fires with the right
envelope (`from`/`to`) but `message` is the empty string - the actual text, which only ever existed
in `message_payload`, is lost. Matches the target exactly: `incoming-requests.ts` reads
`short_message` only.

**Reproducer.** `interop-tests/jasmin.test.ts`, `C8 (target 2)`: build a `deliver_sm` with
`short_message: Buffer.alloc(0)` and `tlvs: { message_payload: { tagValue: Buffer.from(text) } }`,
send it over the connector's session, and inspect the `sms` event at a client bound to Jasmin's
`smpps` - `sms.message === ''`.

**Severity.** Medium: silent data loss, not a wire error - the message is fully present on the wire
and Jasmin forwards it faithfully; only this library's read of it is incomplete.

**Fixed** in [#84](https://github.com/larvit/larvitsmpp/pull/84): the body is read from
`message_payload` where `short_message` carries none. The relay is confirmed on the wire - the
capture's one `sm_length` 0 `deliver_sm` is Jasmin's own, out of `smpps` to our client, carrying the
`0x0424` TLV intact. The reproducer's own fixture was wrong as well as the library: it built the TLV
as Latin-1 while the PDU declared `data_coding` 0, so `_` (GSM 03.38 0x11, Latin-1 0x5F) came back
as `§` even once the body was read. It now encodes the payload the way the PDU says it is written.

### `sar_*`/UDH segmentation from an upstream SMSC reassembles fine (target 3, MO direction) - not reproduced as a defect here

C8's SAR and UDH MO pushes both reassembled into one whole `sms` at our real client. This does not
confirm target 3 is fixed in general (our own reassembly still keys on UDH only - a SAR-tagged
`deliver_sm` from Jasmin's connector would still arrive as an unrelated fragment if Jasmin ever
sent SAR MO unprompted), it confirms only that pushing SAR/UDH-tagged `deliver_sm`s ourselves,
directly over the connector session, reassembles correctly on the way out through `smpps` - Jasmin
does not re-segment or otherwise disturb an already-short single PDU in transit.

**Fixed** in [#91](https://github.com/larvit/larvitsmpp/pull/91), where a second peer did reproduce
it (`findings/05-java-clients.md`): reassembly now reads the `sar_*` TLVs as well as the UDH. C8's
SAR scenario no longer accepts fragments as an outcome - it asserts one whole `sms` and no segment
arriving on its own - and a rerun is 19/19 with no malformed frame and no expert error.

### `data_sm` is refused (target 4) - confirmed against a real peer

**What happened.** With `jasmin-datasm`'s `[dlr-thrower] dlr_pdu = data_sm`, a receipt requested via
`sendSms({ dlr: true, ... })` throws as a `data_sm` PDU on the client's bind, exactly as documented.
Our client's `incomingPduObj` sees it arrive; no `dlr` event ever fires. The receipt is lost -
`data_sm` falls to the generic unhandled-command path (`ESME_RINVCMDID`), matching the target.

**Reproducer.** `interop-tests/jasmin.test.ts`, `C9`: bind to `jasmin-datasm`, `sendSms({ dlr: true,
... })`, assert an incoming `data_sm` PDU arrives and no `dlr` event ever fires.

**Severity.** Medium: a real, documented Jasmin configuration (`dlr_pdu = data_sm`) that a receipt
depends on silently drops delivery reports, with no error surfaced to the application either.

**Fixed** in [#84](https://github.com/larvit/larvitsmpp/pull/84): `data_sm` is classified and
answered exactly as `deliver_sm` is, and the receipt reaches `dlr` naming the id the `submit_sm_resp`
carried, `DELIVERED`. The wire histogram still shows no `data_sm`: `capture` runs
`network_mode: service:jasmin`, so it only ever sees the main instance's namespace, never
`jasmin-datasm`'s.

### A multi-part MT send deadlocks against Jasmin's serialized per-connector relay - a library/peer interaction, not a wire defect

**What happened.** A 2-, 3-, 10-segment GSM or UCS-2 message sent through Jasmin's `smpps` (our real
client → Jasmin → `mtrouter` → the `upstream` connector → our fake upstream) never gets a receipt,
in every one of 3 runs, regardless of segment count or encoding - only the always-unsegmented
single-segment case succeeds. Jasmin's own `messages.log` shows why: `SubmitSmPDU[...] request
timed out through [cid:upstream], message requeued` after its 120s response timeout, and nothing
for the later segments at all (they stay queued behind the stuck one). The mechanism, confirmed by
dumping every `submit_sm` this library's `server()` received as Jasmin's fake upstream: segment 1
arrives intact (`esm_class: 64`, a correct `05 00 03 <ref> <total> <seq>` UDH, matching exactly what
`splitMessage()` itself would produce - Jasmin relays the UDH byte-for-byte) - but segment 2 never
arrives. `src/incoming-requests.ts`'s `onMessage()` answers nothing for an incomplete concatenation
group (`if (whole) this.emitSms(whole);` - a partial group falls through silently); `sms.sendResp()`
only exists once the whole group is in hand, so it answers all segments of a group atomically, in
one call, after the last one arrives. Jasmin, on its side, dispatches to a given connector one
`submit_sm` at a time, waiting for that one's response before sending the next queued message for
the same connector (confirmed indirectly: reordering the test file so `C13`'s 10 *independent*
single-segment sends and `S7`'s HTTP-send run *before* any multi-segment send turned both from
always-failing into always-passing at sub-second speed, while running them *after* a stuck
multi-segment send left them queued behind it for the same reason). Two designs that are each
individually reasonable - Jasmin never advances its connector queue past an unanswered request;
this library never answers part of a concatenated message - deadlock when composed: Jasmin will not
send segment 2 until segment 1 is acked, and this library will not ack segment 1 until segment 2
arrives.

Ruled out before landing on this: RabbitMQ/host CPU contention (real, but the failure is
deterministic across three runs regardless of load - not a timing flake); the connector's own
`submit_throughput` default of 1 msg/s (set to `0`, no change); the fake upstream's `idleTimeout`
dropping the connector mid-flight (widened to 300s, no change - the connector stayed bound
throughout, confirmed in its own log).

**Reproducer.** `interop-tests/jasmin.test.ts`, `C3+C7`, any multi-segment case, run after
`waitForUpstreamSession('main')`: `session.sendSms({ dlr: true, message: 'g'.repeat(200), from,
to })` against Jasmin's `smpps`, with a `server()` bound as the fake upstream that only calls
`sms.sendResp()`/`sendDlr()` once its own `'sms'` event fires. No receipt arrives within Jasmin's
own 120s response timeout; `messages.log` on the peer shows the requeue.

**Severity.** Medium, narrow: needs a real relaying gateway whose own dispatch is serialized
per-outbound-link, which is exactly Jasmin's `smppc` connector shape - a directly-connected SMSC
(every other peer in this suite) never exhibits it, since it always has a response ready for every
segment as they arrive rather than being a relay itself. Worth a decision record either way (answer
each segment as it's held, not only once the group completes; or document that a `server()` sitting
behind a serializing relay needs its own segment-level ack), but not fixed here per the phase rules.

**Fixed** in [#83](https://github.com/larvit/larvitsmpp/pull/83): every segment is answered as it
arrives, with `<base>-<n>` off an id the group is opened with. All four multi-segment cases pass, in
200-360 ms each, malformed 0 and expert errors 0.

## Peer quirks

- **Jasmin's own `enquireLinkTimerSecs` (30, `[smpp-server]` default) is an idle timer, not a strict
  period.** Our client's own default 20s keepalive counts as activity and resets it, so Jasmin's own
  probe never gets a chance to fire on a link that's never quiet for 30s. `C1` disables our own
  keepalive (`enquireLinkInterval: 0`, widening `idleTimeout` to compensate) to observe it.
- **Message ids are UUIDs, self-consistent end to end when the upstream hands out one id per PDU.**
  Every id the real client's `submit_sm_resp` carried matched exactly what the fake upstream's
  `sendResp()` assigned; the later receipt named the same id. Since the fake upstream here is this
  library's own `server()`, a multi-segment message's ids came back in this library's own
  `<base>-<n>` shape - an artifact of the test rig (our own server minting one base per group),
  not evidence that Jasmin itself produces that convention; a real upstream SMSC would very likely
  hand back unrelated ids per segment, as the research notes expected.
- **`smpps_throughput`, not the connector's `submit_throughput`, gates an ESME's own submission
  rate.** The plan named `submit_throughput` "on the connector" for C12; that setting throttles the
  connector's own *outbound* rate to its upstream. The knob that actually throttles submissions
  *into* Jasmin's `smpps` from a bound ESME is a **user**-level quota
  (`user -u <uid> mt_messaging_cred quota smpps_throughput <n>`), which does answer `ESME_RTHROTTLED`
  reliably once exceeded.
- **`smppccm`'s `cid` must be 3-25 chars, `morouter`'s `smpps(<system_id>)` target is validated by
  the same regex** (`[A-Za-z0-9_-]{3,25}`) - confirmed from `jasmin/protocols/cli/morouterm.py`.
- **`[dlr-thrower] dlr_pdu`** is a config-file setting (`deliver_sm` default, `data_sm` the other
  option), not a per-connector or per-user key - the only way to test both is two Jasmin instances.
- **HTTP DLR callbacks carry fixed query args** (`id`, `level`, `message_status`, `connector`, plus
  `id_smsc`/`sub`/`dlvrd`/`subdate`/`donedate`/`err`/`text` at `dlr-level` 2/3) appended by
  `DLRThrower` itself to whatever bare URL `dlr-url` names - unlike Kannel's `%d`/`%F`
  printf-style placeholders, nothing is written into the URL by the caller. `dlr-level=1` fires once,
  immediately, with `message_status=ESME_ROK` (an SMSC-ack, not a terminal state); `dlr-level=3`
  additionally fires once more, later, with the real terminal status (`DELIVRD` here).
- **Jasmin FINs the connection on a `deliver_sm_resp` carrying a `message_id`.** SMPP 3.4 4.6.2
  makes that field unused and NULL, and Jasmin's own decoder sizes it at one octet; a 38-octet UUID
  in it cost the link immediately after the response, taking the rest of the MO group with it. Found
  by the fix for the multipart deadlock above, which is what first had this library answer an inbound
  `deliver_sm` in this suite at all; the field now goes out empty.
- **jcli is a plain-text protocol dressed as Telnet** - it sends real `IAC`/option-negotiation bytes
  and a couple of ANSI escapes in its banner, but never waits for or requires a reply to them; a raw
  socket client that ignores negotiation entirely and just reads/writes lines works throughout.

## Open questions

- Whether Jasmin's own MT dispatch is serialized *per connector* specifically, or *globally* across
  every connector on the instance - only one connector was configured, so the two are
  indistinguishable here.
- Whether the deadlock above is specific to a message requesting a receipt (`registered_delivery`
  set) or would also occur for a plain multi-segment send with no `dlr` - not isolated separately,
  since every `C3+C7` case here requests one.
- Whether a real peer accepts a `data_sm_resp` carrying a `message_id`. SMPP 3.4 4.7.2 defines the
  field, unlike `deliver_sm_resp`'s, and this library fills it when a `data_sm` carried a message -
  but Jasmin only ever sends one as a receipt, which is answered with the field empty, so the filled
  case has met no peer. Jasmin FINing over a `deliver_sm_resp` that carried one is the nearest
  precedent there is.
- Whether Jasmin, given an *upstream* connector that itself defaults to SAR (rather than our
  library's own UDH), would relay an MT message using SAR instead of preserving our UDH bytes - the
  120s-timeout deadlock always intervened before a second segment could be observed on the wire in
  either direction.
