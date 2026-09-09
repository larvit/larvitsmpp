# interop-tests

Eight real SMPP implementations, run against this library in both directions, with every session
decoded independently by tshark so no result rests on our own view of the wire. It exists because
the unit suite and this library's own dummy peers agree with themselves; these peers do not.

It ran between 2026-09-05 and 2026-09-08 and found twelve defects, all fixed. This file replaces
`PLAN.md`, which the findings below still cite by name.

[AGENTS.md](AGENTS.md) is how a run works: the layout, `run.py`, what the capture must show, and
the rules an experiment follows.

## What it found

| Peer | Findings |
| --- | --- |
| ukarim/smscsim | [01-smscsim.md](findings/01-smscsim.md) |
| SMPPSim | [02-smppsim.md](findings/02-smppsim.md) |
| Jasmin | [03-jasmin.md](findings/03-jasmin.md) |
| Kannel | [04-kannel.md](findings/04-kannel.md) |
| jsmpp, Cloudhopper | [05-java-clients.md](findings/05-java-clients.md) |
| python-smpplib, php-smpp | [06-python-php.md](findings/06-python-php.md) |
| smppload, smpp-dumb-client | [07-load.md](findings/07-load.md) |
| Operator documentation, as fixtures | [09-operator-fixtures.md](findings/09-operator-fixtures.md) |

Each records what the peer does on the wire, every defect with a reproducer, and the peer's own
quirks — several findings are the peer's bug, not ours, and say so.

## Peers

Our client binds to these:

| Peer | What it is for | Run |
| --- | --- | --- |
| **Jasmin 0.11.0** | A production gateway with an independent codec, SAR segmentation, UUID ids, and a DLR pipeline that can use `data_sm` | `jookies/jasmin:0.11.0` + `redis:8.8.2-alpine` + `rabbitmq:3.13.7-management-alpine`, bootstrapped over `jcli` by `peers/jasmin/bootstrap.py` |
| **SMPPSim 2.6.11** | The richest fault injection available: per-state receipt percentages, delayed and intermediate receipts, queue-full, loopback, SMSC-initiated `outbind`, receipts with or without TLVs | Built from `kwahome/smpp-sim-docker`; nine `.props` variants under `peers/smppsim/` |
| **ukarim/smscsim 0.2.0** | Zero setup and MO injection from a web page — the smoke test that proves the harness | `ukarim/smscsim:0.2.0`. No PDU validation, so it proves nothing about strictness |

These bind to our server:

| Peer | What it is for | Run |
| --- | --- | --- |
| **Kannel 1.4.5** | The most deployed real ESME there is; parses our receipts with the parser most operators' customers run, and declares 3.4 or 3.3 on demand | `debian:bookworm-slim` + the distribution package; four `.conf` variants under `peers/kannel/` |
| **jsmpp** | Strict and low-level: the driver builds UDH, `sar_*` and `message_payload` bytes by hand, and rejects an answer it dislikes | Maven build at a pinned commit, `peers/jsmpp/` |
| **Cloudhopper** | The one peer with real windowing knobs, plus a TLS client | Maven build at a pinned commit, `peers/cloudhopper/`. Its 2015-era TLS client cannot do 1.3, so that scenario caps the server at 1.2 |
| **python-smpplib 2.2.4** | An independent GSM 03.38 table to cross-check ours character by character | `python:3.12.14-slim-bookworm`, `peers/python/` |
| **php-smpp** | Three long-message spellings from one client, and separate transmitter and receiver binds | `php:8.4.25-cli` at a pinned commit, `peers/php/`. Its socket guard uses a check PHP 8 broke, so the image patches it |
| **smpp-dumb-client** | A genuinely enforced bounded window, which is what tests backpressure rather than raw rate | Go build at a pinned commit, `peers/dumbclient/` |
| **smppload** | Intended for throughput; its own `bind_transceiver` is two octets shorter than it declares, so it never binds. Kept as a live reproducer that our server refuses the stream rather than hanging | Erlang build, `peers/smppload/` |

## Scenario ids

The findings cite these. `fixture` means a raw-socket peer in our own suite, because no open
implementation emits that shape on demand.

| # | Scenario | Peers |
| --- | --- | --- |
| C1 | Bind each type, `enquire_link` both ways, `unbind` | all SMSC peers |
| C2 | Text-only receipts, no TLVs | SMPPSim |
| C3 | Receipts with `receipted_message_id` and `message_state` | Jasmin, SMPPSim |
| C4 | Intermediate then final receipt | SMPPSim |
| C5 | Failure states, and the worst segment winning a merge | SMPPSim |
| C6 | A receipt delayed past a link drop | SMPPSim |
| C7 | Long MT in GSM and UCS-2, 2, 3 and 10 segments | SMPPSim, Jasmin |
| C8 | Long MO as UDH 8-bit, UDH 16-bit, `sar_*` and `message_payload` | Jasmin, jsmpp, SMPPSim |
| C9 | MO or receipt on `data_sm` | Jasmin |
| C10 | Unknown command id, malformed and vendor TLVs | fixture, jsmpp |
| C11 | Bind refused, and the backoff that must not flood | Jasmin, SMPPSim, a closed port |
| C12 | Throttling and queue-full on submit | Jasmin, SMPPSim, smscsim |
| C13 | A slow SMSC and a full window | Jasmin, SMPPSim |
| C14 | TLS against a public certificate authority | not run — see [Untested](#untested) |
| C15 | `interfaceVersion` 0x50, and a peer answering 3.3 or nothing | SMPPSim, fixture |
| C16 | Receipt text variants from operator documentation | fixture |
| C17 | Encodings round trip | SMPPSim |
| C18 | `outbind` from the SMSC | SMPPSim |
| S1 | Kannel at "34" and at "33", submitting, receipts, MO | Kannel |
| S2 | Long messages in every spelling to our server | jsmpp, php-smpp, python-smpplib |
| S3 | Unhandled and unknown commands, and whether a strict client accepts our answers | jsmpp |
| S4 | Separate transmitter and receiver binds | php-smpp |
| S5 | Window pressure against a slow listener | Cloudhopper |
| S6 | A peer that never sends a keepalive | smpp-dumb-client |
| S7 | A production gateway as the ESME, parsing our receipts | Jasmin |
| S8 | Throughput, with receipts and long messages | smppload — blocked, see above |
| S9 | A bounded window under load | smpp-dumb-client |
| S10 | TLS from a Java client | Cloudhopper |
| S11 | Encodings from another implementation's encoder | python-smpplib |

## Untested

Three things this suite never exercised. None is a known defect; each is a claim resting on the
specification and on Node rather than on a peer having agreed.

- **A TLS handshake against a certificate a public authority signed.** Every TLS test here uses a
  certificate generated for the test, so what is proven is that the handshake works and that a bad
  certificate is refused. Verifying a real chain is Node's job and we pass `tls.ConnectionOptions`
  through untouched, which is why this is a thin risk rather than none.
- **A peer that genuinely speaks SMPP 5.0.** `interfaceVersion: 0x50` is tested against peers that
  answer 3.4 or answer nothing, so what 5.0 declares back is unobserved.
- **An SMSC written by someone who never sees this code.** Every peer here is open source and
  configured by us. A closed commercial SMSC is the one thing a free suite cannot buy, and the first
  operator integration is where that gets answered.

The research behind the peer choices and the operator quirks, one source URL per claim, is in
`research/`. Ask before trusting a claim there that a peer's own docs would settle.
