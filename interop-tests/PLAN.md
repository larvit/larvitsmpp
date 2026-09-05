# Interoperability test plan for 1.0.0

Pre-release working file, like `todo.md`: it turns into `interop-tests/README.md` once the harness
below exists, and is deleted with it otherwise.

## Purpose

Find where the rewrite disagrees with SMPP as real peers run it. The suite cross-checks one
independent implementation, node-smpp, in both directions and over a live session. Everything here
adds peers written by other people, in other languages, with other opinions about the spec — and
faults the suite's own dummy peers never inject.

## Baseline

`docker compose run --rm node npm test` on `typescript` at `9ca83ac`, 2026-09-05: 303 pass, 0 fail,
lint and typecheck clean.

## Targets read from the code

Ranked by how likely a real peer is to trip it. Each is a scenario in the matrix below.

1. **One unreadable PDU drops the link.** `pdu-transport.ts` routes every codec error — an unknown
   command id, a TLV the codec refuses, a malformed body — to the teardown a framing error takes,
   although `command_length` was honoured and the stream is still in sync. One vendor-specific PDU
   or odd TLV from an SMSC becomes a reconnect loop. Spec: `generic_nack` with `ESME_RINVCMDID` for
   an unknown command, a `*_resp` with `ESME_RINVTLVSTREAM` for a bad TLV, and carry on.
2. **`message_payload` is never read.** `incoming-requests.ts` takes the text from `short_message`
   only. A `deliver_sm` with `sm_length` 0 and the body in `message_payload` — how several SMSCs
   carry a long MO, Melrose Labs and Telia among the documented ones — arrives as an empty message.
3. **`sar_*` segmentation is never read.** Reassembly keys on the UDH only; segments carried as
   `sar_msg_ref_num`/`sar_total_segments`/`sar_segment_seqnum` reach the application as fragments.
   Jasmin's default MT segmentation is SAR.
4. **`data_sm` is refused** with `data_sm_resp` `ESME_RINVCMDID`. CM.com documents receipts on
   `data_sm` as a configuration; Jasmin's DLR thrower can use it too.
5. **Long messages go out one way only:** UDH with an 8-bit reference and `esm_class` 0x40. No
   `sar_*`, no `message_payload`, no 16-bit reference. LINK Mobility wants exactly this and rejects
   the other two; Route Mobile and Kaleyra document 0x43 and validate UDH length strictly.
   Acceptable for 1.0 if documented — but find out which peers refuse it.
6. **Known-but-unhandled commands** (`query_sm`, `cancel_sm`, `replace_sm`, `submit_multi`,
   `alert_notification`, `outbind`) get a `*_resp` carrying `ESME_RINVCMDID`. Check strict clients
   accept that, and that `alert_notification` and `outbind`, which have no response PDU, do not
   produce a bogus one.
7. **Receipt text parsing** is a regex per field. Real formats to verify against: LINK writes
   `sub:000 dlvrd:000` and an empty `text:`; Vonage writes `stat:FAILED`, outside the spec's table,
   and one receipt per segment; tyntec sends a buffered receipt and then a final one for the same id;
   Infobip writes `stat:ENROUTE` in an ordinary receipt; Telesign gives only segment 1 a
   `message_id`. Also: field order, `id:` hex vs decimal, dates with and without seconds, no `id:`.
8. **Bind version negotiation.** A peer that omits `sc_interface_version` is treated as pre-3.4 and
   sent no TLVs. Right for a client; on the server side an ESME declaring 0x33 (Kannel
   `interface-version = "33"`) must get text-only receipts and still correlate them.
9. **Unbind.** Most SMSCs close the socket instead of answering; close-after-unbind is read as
   clean. Verify no `sessionError` noise and no reconnect attempt. Telia requires an `unbind` before
   the TCP close — check what `close()` puts on the wire.
10. **Reconnect against a peer that refuses the bind** (`ESME_RBINDFAIL`, `ESME_RINVPASWD`,
    `ESME_RALYBND` — Vonage's answer to a third bind — or TCP refused) must back off, never flood.
11. **Window.** Telenor's default window is 1; Kannel's `max-pending-submits` is 10. A peer
    enforcing 1, or closing on overrun, must not lose or duplicate.
12. **Flash** is detected on coding group 0x10 only; the 0xF0 GSM message-class group is not read
    as flash. Minor, but it is what `sms.flash` promises.

## Counterparts

Everything runs in Docker with full patch-version pins, resolved at setup; hosted services are
manual runs, never CI. Tags below were current on 2026-09-05.

### SMSC side — our client binds to them

| Peer | Why it earns a slot | Run | Knobs that matter |
| --- | --- | --- | --- |
| **Jasmin 0.11.0** — Python/Twisted, a production gateway, not a toy | Independent codec (`smpp.pdu`), SAR segmentation by default, UUID message ids, a real DLR pipeline that can use `data_sm` | `jookies/jasmin:0.11.0` + `redis:8.8.2-alpine` + `rabbitmq:4.3.5-management-alpine` (env `REDIS_CLIENT_HOST`, `AMQP_BROKER_HOST`; fall back to `redis:7.4.x` / `rabbitmq:3.13.x` if 0.11.0 balks). User, group, `mtrouter` and `morouter` over `jcli` on 8990 | `[smpp-server]`: `enquireLinkTimerSecs` 30, `inactivityTimerSecs` 300, `responseTimerSecs` 60; `submit_throughput` for throttling; `dlr_level` |
| **SMPPSim 2.6.x** — Java, the classic | Richest fault injection of anything open: per-state receipt percentages, delayed and intermediate receipts, queue-full, `LOOPBACK` (echoes our `submit_sm` back as `deliver_sm`), SMSC-initiated `outbind`, receipts with or without TLVs, its own decoded PDU log | Vendor site is down (522); build from `kwahome/smpp-sim-docker` and tag locally. Port 2775, HTTP 8884, `smppclient1`/`password` | `DELIVERY_RECEIPT_OPTIONAL_PARAMS` (off = Kannel-style text-only receipts), `PERCENTAGE_DELIVERED/UNDELIVERABLE/ACCEPTED/REJECTED`, `PERCENTAGE_THAT_TRANSITION`, `MAX_TIME_ENROUTE`, `DELAY_DELIVERY_RECEIPTS_BY`, `OUTBOUND_QUEUE_MAX_SIZE`, `OUTBIND_ENABLED`, `CAPTURE_*_DECODED_TO_FILE` |
| **ukarim/smscsim 0.2.0** — Go | Zero setup; MO injection from a web page; the smoke test | `ukarim/smscsim:0.2.0`, ports 2775 and 12775, no auth | `FAILED_SUBMITS=1` fails even sequence numbers and undelivers odd ones. No PDU validation, so it proves nothing about strictness |
| **Melrose Labs SMSC Simulator** — hosted, closed | A peer nobody here can special-case; TLS 1.2 on 8775 with a public CA; `message_payload` on `deliver_sm`; 64-char ids; SMPP 3.3/3.4/5; sends `enquire_link` itself after 45 s idle; rejects a destination under 8 digits | `smscsim.melroselabs.com:2775`, free developer account; MO by writing the bound `system_id`'s digits into the destination address | 100 SMS/s cap; delivered-only receipts on the free tier, TLVs plus text; MO echoes the submit's `data_coding` |
| **smscsim.smpp.org** — hosted | Second closed peer for the same assertions | port 2775, 2 SMS/s cap | — |
| **jsmpp `SMPPServerSimulator`** — Java | Strict PDU validation on the SMSC side, from the best-maintained SMPP codebase found (pushed 2026-06) | Build from `opentelecoms-org/jsmpp` `jsmpp-examples`; no image | Only if the Java clients below leave a gap |

Skipped, with the reason: Kannel's `opensmppbox` is not in any package and last saw a commit in
2014; `fakesmsc` does not speak SMPP; OsmoMSC and Restcomm need a telecom stack for no extra
coverage.

### ESME side — they bind to our server

| Peer | Why it earns a slot | Run | Knobs that matter |
| --- | --- | --- | --- |
| **Kannel 1.4.5** `bearerbox` + `smsbox` — C | The most deployed real ESME there is; parses our receipts with the parser most operators' customers run; declares 3.4 or 3.3 on demand | `debian:bookworm-20260824-slim` + `apt-get install kannel` (1.4.5-12). Submit over `smsbox` HTTP `sendsms`; MO out to a tiny HTTP receiver through an `sms-service` `get-url` | `group = smsc`, `smsc = smpp`: `interface-version = "34"` or `"33"`, `msg-id-type`, `max-pending-submits` (1 and 10), `enquire-link-interval` (30), `wait-ack` (60) with `wait-ack-expire`, `transceiver-mode`, `alt-charset`, `dlr-mask` on `sendsms` |
| **jsmpp** — Java, active | Strict, low-level: the caller builds UDH, `sar_*` or `message_payload` bytes by hand, so it is the tool for targets 2, 3, 5 and 6. Assumes 3.4 when `sc_interface_version` is absent; crashes on an unnameable one | Maven build in a pinned JDK image; no published image | `interface_version`, raw optional parameters, `query_sm`/`cancel_sm`/`replace_sm` calls |
| **Cloudhopper (fizzed fork)** — Java/Netty | The windowing client: `setWindowSize`, `setRequestExpiryTimeout`, `setWindowMonitorInterval`; async submits; an SSL demo | Maven build; `make client`, `make ssl-client` | Window 1, 10, 50 against a slow `sms` listener; request expiry shorter than our response |
| **python-smpplib 2.2.4** — Python | Sends GSM 7-bit unpacked with `0x1B` escapes, UDH long messages, reactive `enquire_link`; the easiest peer to script, so also the driver for the server-side matrix | `python:3.12.14-slim-bookworm` + `pip install smpplib==2.2.4` | `interface_version` kwarg, `auto_send_enquire_link`, `make_parts_encoded` |
| **php-smpp (alexandr-mironov fork)** — PHP | Cannot bind transceiver, so it forces separate TX and RX binds — the direction-enforcement path; three long-message modes from one client: `CSMS_16BIT_TAGS`, `CSMS_PAYLOAD`, `CSMS_8BIT_UDH` | `php:8.x-cli`, vendored; no licence declared, so test-only | The three CSMS modes; `submit_sm` on the RX bind |
| **Jasmin `smppccm`** — Python/Twisted | A production gateway as the ESME: its own reconnect, `elink_interval`, receipt parsing of what we send, `dlr_msgid` | Same stack as above; `smppccm -a` pointing at our server, `mtrouter`, HTTP `/send` | `elink_interval`, `con_loss_retry`/`con_loss_delay`, `coding`, `dlr_msgid`, `submit_throughput` |
| **smppload 2.5.3** — Erlang | The only free, scriptable load generator with UDH long messages: `-r` rps, `-T` threads, `-c` count, `-D` receipts, `-C` data_coding | Hand-built OTP image; expect build friction (issue #8) | No real window — in-flight is `threads × rps` — and no `enquire_link` at all, which is itself a real-world shape |
| **vponomarev/libsmpp `smpp-dumb-client`** — Go | The one load tool with an enforced bounded window (`generator.window`) | Go build stage, YAML config | `rate`, `window`, `count`, `stayConnected` |
| **fiorix/go-smpp `cmd/sms`** — Go | One-shot bind + submit + receive from a fourth language; `--tls` | Go build stage | — |

### Validator — always on

**tshark** decodes every PDU independently of both ends, including TLVs and UDH/SAR reassembly, and
flags malformed ones. `nicolaka/netshoot:v0.16`, or `debian:13.6-slim` + `tshark` (4.4.18), as a
sidecar on the compose network:

```bash
dumpcap -i any -f 'tcp port 2775' -w capture.pcapng
tshark -r capture.pcapng -d tcp.port==2775,smpp -Y smpp -T json > capture.json
```

Assert: no `_ws.malformed`, no `_ws.expert` at error severity, every TLV decoded by name, UDH
totals consistent. Run it under the existing suite too — it is the cheapest independent check of
every byte we emit. `gurk4n`'s browser decoder and SMPPSim's `CAPTURE_*_DECODED_TO_FILE` are the
manual fallbacks.

## Scenario matrix

Every scenario runs with the tshark sidecar. "Fixture" means a raw-socket peer in our own suite,
because no open implementation emits that shape on demand; those scenarios are unit tests derived
from real-world documentation, not interop runs, and belong in `test/`.

### Our client against an SMSC

| # | Scenario | Assert | Peers |
| --- | --- | --- | --- |
| C1 | Bind each type, `enquire_link` both ways, `unbind` | Bound; SMSC-initiated `enquire_link` answered; close after our `unbind` is clean, no reconnect | all SMSC peers; Melrose (45 s idle), Jasmin (30 s) |
| C2 | Text-only receipts, no TLVs | `dlr.smsId` equals the `submit_sm_resp` id; `statusMsg` right; `messageDlr` merges per segment | SMPPSim with `DELIVERY_RECEIPT_OPTIONAL_PARAMS` off |
| C3 | Receipts with `receipted_message_id` + `message_state` | Same, and TLV wins over body when both present | Jasmin, Melrose, SMPPSim TLVs on |
| C4 | Intermediate then final receipt | First arrives `intermediate: true` and never counts in `messageDlr`; final settles | SMPPSim `PERCENTAGE_THAT_TRANSITION` 100, `MAX_TIME_ENROUTE` |
| C5 | Failure states | UNDELIV, REJECTD, EXPIRED, ACCEPTD mapped; `messageDlr` carries the worst segment | SMPPSim percentages; Melrose dedicated tier |
| C6 | Receipt delayed past a link drop | Merge survives the reconnect; late receipt still reaches `dlr` | SMPPSim `DELAY_DELIVERY_RECEIPTS_BY` + kill the TCP link |
| C7 | Long MT: GSM with extension chars, UCS-2 with emoji, 2/3/10 segments | One id per segment; peer reassembles (loopback or MO route shows the whole text); receipt per segment | SMPPSim `LOOPBACK`, Jasmin MO route, Melrose |
| C8 | Long MO as UDH 8-bit, UDH 16-bit, `sar_*`, `message_payload` | One `sms` with the whole text in every spelling (targets 2, 3) | Jasmin (SAR), Melrose (`message_payload`), SMPPSim loopback (UDH 8), fixture (UDH 16) |
| C9 | MO or receipt on `data_sm` | Not refused; reaches `sms`/`dlr` (target 4) | Jasmin if configurable, else fixture |
| C10 | Unknown command id, unknown or malformed TLV, vendor TLV, zero-length integer TLV from the SMSC | Link stays up; `generic_nack`/`*_resp` with the right status; `sessionError` logged once (target 1) | fixture |
| C11 | Bind refused: bad password, `ESME_RALYBND`, TCP refused | Backoff 1 s → 30 s, one attempt per interval, no flood (target 10) | Jasmin bad creds, SMPPSim `SYSTEM_IDS`, closed port |
| C12 | `ESME_RTHROTTLED` and `ESME_RMSGQFUL` on submit | `sendSms` returns `err` naming the status; session stays bound; next send works | Jasmin `submit_throughput`, SMPPSim queue sizes, smscsim `FAILED_SUBMITS` |
| C13 | Slow SMSC and a full window | `maxOutstanding` queues, nothing overruns; `close()` drains; `responseTimeout` fires as documented (target 11) | Jasmin `responseTimerSecs`, SMPPSim delays |
| C14 | TLS bind against a public CA | Handshake, bind, send, receipt | Melrose 8775 |
| C15 | `interfaceVersion` 0x50 and a peer answering 3.3 or no `sc_interface_version` | Bound; no TLVs sent to a pre-3.4 peer; TLVs sent to 3.4+ (target 8) | Melrose (v5), SMPPSim, fixture |
| C16 | Receipt text variants from operator docs | LINK `sub:000 dlvrd:000 text:`; Vonage `stat:FAILED`; tyntec two receipts one id; Infobip `stat:ENROUTE` under 0x04; no `id:`; hex id in `submit_sm_resp`, decimal in receipt (target 7) | fixture |
| C17 | Encodings round trip | Latin-1, UCS-2 big-endian, flash 0x10 and 0xF0, 8-bit binary with UDH — what comes back matches (target 12) | SMPPSim loopback, Melrose MO echo |
| C18 | `outbind` from the SMSC to our server | No bogus response PDU; logged (target 6) | SMPPSim `OUTBIND_ENABLED` |

### An ESME against our server

| # | Scenario | Assert | Peers |
| --- | --- | --- | --- |
| S1 | Kannel binds at "34" and at "33", submits, gets receipts, receives MO | `bearerbox` log shows the receipt parsed and matched (`DLR`); at "33" our receipts carry no TLVs and still match; MO reaches the `sms-service` URL (target 8) | Kannel |
| S2 | Long messages in every spelling to our server | UDH 8-bit, UDH 16-bit, `sar_*`, `message_payload`: one `sms` each, or a documented refusal (targets 2, 3, 5) | jsmpp, php-smpp modes, python-smpplib |
| S3 | Unhandled and unknown commands | `query_sm`/`cancel_sm`/`replace_sm` get `*_resp` `ESME_RINVCMDID` and the client accepts it; an unknown id gets `generic_nack`; `alert_notification` gets nothing (targets 1, 6) | jsmpp |
| S4 | Separate TX and RX binds | Receipts and MO go out on RX only; `submit_sm` on RX gets `ESME_RINVBNDSTS`; the peer keeps working | php-smpp |
| S5 | Window pressure | Window 50 against a slow `sms` listener: every request answered, none twice; peer's request expiry shorter than our answer is reported by the peer, not by a crash on our side | Cloudhopper |
| S6 | Idle and keepalive | A peer sending no `enquire_link` is dropped at `idleTimeout` and reconnects cleanly; one sending every 5 s is kept | smppload (none), gosmpp (5 s), Jasmin `elink_interval` |
| S7 | A production gateway as the ESME | Jasmin parses our receipts (HTTP DLR callback fires with the right state); `dlr_msgid` 0 matches | Jasmin `smppccm` |
| S8 | Load: 100 000 `submit_sm`, rps 500, threads 20, receipts on, long messages on | All answered, memory flat, receipts correlate, `close()` drains to zero | smppload |
| S9 | Bounded window under load | `window` 2000, `rate` 1000: no head-of-line stall, no reorder problems | `smpp-dumb-client` |
| S10 | TLS from a Java client | Handshake with our cert, bind, send | Cloudhopper `make ssl-client` |
| S11 | Encodings from other encoders | GSM unpacked with `0x1B` extension escapes, UCS-2, Latin-1 decode to the right string; peer decodes our `deliver_sm` the same way | python-smpplib, jsmpp, Kannel `alt-charset` |

## Order of work

Each phase ends with findings in [Status](#status); a defect gets a regression test in `test/` and a
fix before the next phase starts, per AGENTS.md.

| Phase | What | Rough effort |
| --- | --- | --- |
| 0 | Harness: `interop-tests/compose.<peer>.yaml` per peer, our tests as `interop-tests/<peer>.test.ts` run in the `node` service on the same network, tshark sidecar writing to `interop-tests/captures/` (gitignored), a Python runner that brings a peer up, runs, tears down | ½ day |
| 1 | smscsim smoke + tshark assertions — proves the harness | 1 h |
| 2 | SMPPSim: C2–C7, C11–C13, C15, C17, C18 | 1 day |
| 3 | Jasmin as SMSC (C1, C3, C7–C9, C11–C13) and as ESME (S7) | 1 day |
| 4 | Kannel (S1) | ½ day |
| 5 | jsmpp + Cloudhopper (S2, S3, S5, S10) | 1 day |
| 6 | python-smpplib + php-smpp (S2, S4, S11) | ½ day |
| 7 | Load: smppload + smpp-dumb-client (S6, S8, S9) | ½ day |
| 8 | Hosted, manual: Melrose and smpp.org (C1, C7, C8, C14, C15, C17) | 2 h |
| 9 | Fixtures from the quirk list into `test/` (C8 UDH-16, C9, C10, C15, C16) | 1 day |
| 10 | Decide 1.0 scope for targets 2–5: fix, or document as a limitation with the peers that refuse | — |

## Delegation

Cheaper model, with these instructions and the tables above, no judgement calls:

- Compose files and Dockerfiles for every peer, pins as listed, `healthcheck` on the SMPP port.
- Kannel `kannel.conf` (`core`, `smsbox`, `smsc smpp`, `sendsms-user`, `sms-service`) from the 1.4.5
  user guide, one variant per knob value in S1.
- Jasmin `jcli` bootstrap script: group, user, `smppccm`, `mtrouter`, `morouter`.
- python-smpplib driver scripts for S2, S4 and S11, one PDU shape per script.
- Running a phase and pasting tshark's malformed/expert counts and the peer's log excerpts into
  [Status](#status).

Stronger model: reading a failure against the spec and the peer's docs, deciding fix versus
document, library changes, and the AGENTS.md decision record each one needs.

## Status

| Phase | State | Findings |
| --- | --- | --- |
| 0 | done | [01-smscsim.md](findings/01-smscsim.md) |
| 1 | done | [01-smscsim.md](findings/01-smscsim.md) |
| 2 | done | [02-smppsim.md](findings/02-smppsim.md) |
| 3 | not started | — |
| 4 | done | [04-kannel.md](findings/04-kannel.md) |
| 5–10 | not started | — |

Research notes behind this plan, 2026-09-05, are in `research/`: SMSC simulators, ESME clients
and validators, and operator quirks with one source URL per claim. Ask before trusting a claim here
that a peer's own docs would settle.
