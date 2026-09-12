# 05 java clients

Date: 2026-09-06. Repo commit: `4194816` (working tree, phase 5 changes uncommitted on top). Host
Docker: 29.6.2. Images: `interop-jsmpp:3.0.3-a24db96` (jsmpp cloned at commit `a24db96`, built with
`maven:3.9.11-eclipse-temurin-21`, run on `eclipse-temurin:21.0.8_9-jre-jammy`),
`interop-cloudhopper:5.0.10-ae6485a` (fizzed/cloudhopper-smpp cloned at commit `ae6485a`, same
build/runtime image pair, plus a build-time self-signed cert for S10), `nicolaka/netshoot:v0.16`
(capture sidecar and tshark), `node:24.18.0-bookworm-slim` (test runner, from the root
`compose.yaml`).

## Setup

Each peer is a small Java driver (its own Maven project, `interop-tests/peers/<peer>/`) exposing an
HTTP command channel on 8080 - the node test file drives scenarios by calling it, the same shape as
`kannel.test.ts`'s `sendsms()` HTTP calls, and the same port doubles as the compose healthcheck
target. jsmpp's driver binds one or more named `SMPPSession`s and answers with the real client's own
exceptions and return values; Cloudhopper's binds one or more named `SmppSession`s the same way.
Long-message wire shapes (UDH 8/16-bit, `sar_*`, `message_payload`) are all built through jsmpp's own
typed `submitShortMessage(..., OptionalParameter...)` API, never a raw socket - jsmpp exposes exactly
the fields needed. Only three deliberately-malformed PDUs (an unknown command id, a truncated TLV
stream, a body shorter than `sm_length` declares) cannot be expressed through any typed SMPP client,
jsmpp included, so those go out over a second, plain `Socket` the driver opens alongside its jsmpp
session - noted here so "jsmpp accepts our answer" claims below are read as applying to the typed-API
scenarios only, where jsmpp's own reaction is what is being tested.

Build snags, both fixed in the Dockerfile, not in `src/`:

- Cloudhopper's parent pom (`fizzed-maven-parent:1.15`) hardcodes `<source>1.7</source>` /
  `<target>1.7</target>` directly in its compiler-plugin config, which modern `javac` refuses
  ("Source option 7 is no longer supported") and which `-Dmaven.compiler.source` cannot override
  since it is not read from a property. Fixed by `sed`-injecting a `<build>` block into
  `ch-smpp`'s own pom (which declares none) with `source`/`target` `8`, the narrowest override that
  changes nothing else.
- Cloudhopper's test sources reference `javax.annotation.PreDestroy` (JSR-250), removed from the JDK
  this builds with. `-DskipTests` only skips running them; Maven's `install` lifecycle still
  test-*compiles* them first. `-Dmaven.test.skip=true` skips compiling them too.
- Cloudhopper's `SslContextFactory` only takes the "no validation" branch when *neither* a keystore
  nor a truststore is configured; a client with only a trust store falls through to
  `loadKeyStore()` with a null path and fails ("SSL doesn't have a valid keystore"). Fixed by also
  building a PKCS12 keystore from the same build-time self-signed cert and pointing
  `SslConfiguration.setKeyStorePath()` at it - functionally unused (our server never requests a
  client certificate) but required for Cloudhopper's own SSL setup to get past its own null check.
- The shared `cloudhopper-tls` volume Cloudhopper's entrypoint copies `server.key`/`server.crt`
  into (so node's test file can load the same pair into `server({ tls })`) came out root-owned,
  0600 - unreadable by `node`'s container, which runs as uid 1000. Fixed with a `chmod 644` in the
  same entrypoint step.
- Cloudhopper's SSL client (Netty 3.9.6.Final, 2015-era) cannot complete a handshake against our
  server's default TLS 1.3 - see Peer quirks. `server({ tls: { ..., maxVersion: 'TLSv1.2' } })` on
  the S10 listener only; the plain listener the window scenarios use is unrestricted, and a Python
  `ssl` client confirmed TLS 1.3 itself works before this was traced to the peer.
- One GSM7 encoding footgun in the jsmpp driver's own text fixtures, not in `@larvit/smpp`: the
  driver's "gsm7" mode sends plain ASCII bytes for `short_message`, and GSM 03.38's default
  alphabet maps ASCII `_` (0x5F) to `§`, not underscore - a message_payload fixture containing `_`
  round-tripped as `§` until the character was dropped from the fixture text.

Two runs each of `./interop-tests/run.py jsmpp` and `./interop-tests/run.py cloudhopper`, all four
stable: jsmpp 12/12 both times, Cloudhopper 6/6 both times.

```
jsmpp:       frames 37, submit_sm 8/8, query_sm 1/1, cancel_sm 1/1, replace_sm 1/1,
             deliver_sm 2/2, enquire_link 2/2, generic_nack 1, malformed 2, expert errors 2
cloudhopper: frames 90-92 (varies slightly run to run - see Peer quirks), bind_transceiver 5/5,
             submit_sm/submit_sm_resp present, unbind 4/4, malformed 0, expert errors 0
```

jsmpp's `malformed: 2` / `expert errors: 2` are not a stability problem: they are tshark
independently flagging the same two deliberately-malformed PDUs the "S3" scenarios send on purpose
(the truncated-TLV and short-body reproducers below) - both are genuinely malformed by the spec, so
an independent dissector agreeing is the expected outcome, not a surprise.

## Scenarios (PLAN.md)

| Id | Result | Evidence |
| --- | --- | --- |
| S2 UDH 8-bit (targets 2, 5) | pass | `jsmpp.test.ts` "UDH, 8-bit reference": one reassembled `sms`, segments answered `<base>-1`/`<base>-2` |
| S2 UDH 16-bit (target 5) | pass | `jsmpp.test.ts` "UDH, 16-bit reference": also reassembled - confirms both widths are read |
| S2 `message_payload` (target 2) | pass | `jsmpp.test.ts` "message_payload: one sms, the full text" |
| S2 `sar_*` (target 3) | defect confirmed, second peer; fixed in [#91](https://github.com/larvit/larvitsmpp/pull/91) | `jsmpp.test.ts` "sar_* (target 3)": one reassembled `sms`, segments answered `<base>-1`/`<base>-2` |
| S3 known-but-unhandled (targets 1, 6) | pass | `jsmpp.test.ts` "query_sm, cancel_sm, replace_sm": `ESME_RINVCMDID`, link survives, jsmpp raises `NegativeResponseException` and keeps going |
| S3 unknown command id (target 1) | pass | `jsmpp.test.ts` "an unknown command id gets generic_nack..." |
| S3 truncated TLV stream (target 1) | pass | `jsmpp.test.ts` "a deliver_sm with a truncated TLV stream..." |
| S3 short body (target 1) | pass | `jsmpp.test.ts` "a deliver_sm whose body is shorter than sm_length declares..." |
| Bind strictness (target 8) | pass, quirk noted | `jsmpp.test.ts` "bind version negotiation": 0x34 gets `sc_interface_version` back, 0x33 gets none; see Peer quirks for jsmpp's own negotiated-version report |
| Refusing status (jsmpp) | pass | `jsmpp.test.ts` "a refusing status is surfaced back to jsmpp" |
| S5 window 1/10/50 (target 11) | pass | `cloudhopper.test.ts` "S5 - window pressure...": all answered, no id answered twice, peak window never exceeds the configured size |
| S5 request expiry (target 11) | pass | `cloudhopper.test.ts` "the peer reports the expiry itself...": Cloudhopper's own window monitor reports it, our side does nothing unusual |
| S10 TLS | pass, quirk noted | `cloudhopper.test.ts` "handshake, bind, submit over TLS" |
| Refusing status (Cloudhopper) | pass | `cloudhopper.test.ts` "a refusing status is surfaced back to Cloudhopper" |

## Defects in @larvit/smpp

### `sar_*` segmentation confirmed unread, from a second independent peer (target 3)

What happened: jsmpp splits a message into two `sar_*`-tagged `submit_sm`s (no UDH, `esm_class`
carries no UDHI bit); each arrives at our server as its own, independent `sms` event carrying only
its own ~half of the text, with its own unrelated generated id - never merged into one message.
Confirms Jasmin's finding (`findings/03-jasmin.md`) from a second, independently-written client.

Spec: SMPP 3.4 5.3.2.16-5.3.2.18 defines `sar_msg_ref_num`/`sar_total_segments`/`sar_segment_seqnum`
as an alternative to the UDH for carrying concatenation; nothing in the spec says a receiver may
ignore it.

Reproducer: `jsmpp.test.ts`, "sar_\* (target 3)" - two `submit_sm`s to the same
`source_addr`/`destination_addr`, `esm_class` 0x00, one `sar_msg_ref_num` (0x77) across both, `1/2`
then `2/2` in `sar_total_segments`/`sar_segment_seqnum`. Severity: as already scoped in PLAN.md
target 3 / phase 10 - a known, tracked limitation, not new.

**Fixed** in [#91](https://github.com/larvit/larvitsmpp/pull/91): `concatOf()` reads the
concatenation from the UDH, or from the `sar_*` TLVs where the PDU declares none, and each spelling
groups in a reference space of its own. The reproducer now asserts what a rerun shows - one `sms`
carrying the whole 200-char text, its two `submit_sm`s answered `<base>-1` and `<base>-2`, and
neither half ever reaching the application on its own. The rest of the suite is unchanged: 12/12,
frames 37, `submit_sm` 8/8, malformed 2 and expert errors 2 - the two deliberately malformed PDUs
the S3 scenarios send.

### A 4-octet truncated TLV tail is silently accepted rather than refused (target 1)

What happened: a `deliver_sm` whose mandatory fields are complete, followed by exactly one bare TLV
header (tag, 2-octet declared length) and *no* value octets at all, is answered `ESME_ROK` and its
mandatory-field text delivered as an ordinary `sms` - the TLV is silently dropped rather than the PDU
being refused with `ESME_RINVTLVSTREAM`, which is what the *same* codec path does correctly when a
few value octets (but still short of the declared length) follow the header instead of none.

Why: `pdu.ts`'s `pduToObj()` tries two parses of every PDU - "plain", and "padded" (some peers add a
trailing NUL after `short_message` for non-UDH text). Here "plain" parsing hits the TLV loop, reads a
length that overruns `command_length`, and correctly errors. But "padded" parsing shifts the TLV
region by one octet (treating the first of the four trailing octets as that padding NUL), leaving
only 3 octets - one short of what `parseTlvs()`'s loop needs even to read a tag+length pair
(`offset + 4 <= cmdLength` is false) - so the loop exits with no error and 3 octets unconsumed
(`aligned` false). `pduToObj()`'s fallback chain then reaches `if (!padded.err) return
{ pduObj: padded.pduObj }`, which accepts a misaligned parse whenever it produced no error, even
though 3 octets of the peer's PDU were never read. The fix is scoped to that fallback, not touched
here per the read-only rule.

Spec: SMPP 3.4 4.3 - a TLV field this codec cannot parse should be refused with
`ESME_RINVTLVSTREAM` (5.0's name; 3.4 spells it `ESME_RINVOPTPARSTREAM`), the same as the sibling
case with a few value octets present.

Reproducer (raw hex, sent after an ordinary `bind_transceiver`; independently reproduced with a
plain Python socket, no Java involved):

```
000000460000000500000000000000630000007261772d66726f6d0000007261772d746f00000000000000000000137472756e636174656420746c762070726f6265001d00c8
```

This is a `deliver_sm` (`source_addr` `raw-from`, `destination_addr` `raw-to`, body "truncated tlv
probe") followed by `00 1d 00 c8` - tag `0x001D`, declared length 200, zero value octets.
Our server answers `command_status 0x00000000` (`ESME_ROK`) and delivers the text as `sms`.
Appending 4 more arbitrary octets to the same tail (8 total, still declaring length 200) correctly
triggers `ESME_RINVTLVSTREAM` instead - `jsmpp.test.ts`'s "a deliver_sm with a truncated TLV stream"
test uses that 8-octet form deliberately, to test the *documented* refusal path rather than this
adjacent bug. Reproduced with jsmpp's own driver too:
`jsmpp.test.ts`, "a deliver_sm ending in a bare TLV header gets ESME_RINVTLVSTREAM, and reaches no
listener" - the same shape, over a `net.Socket` opened directly against `server()` (not through
jsmpp's typed API, which cannot build it at all). Severity: low - a narrow boundary condition (exactly 4
trailing octets, no value) rather than a general TLV-validation gap, but it is a hole in the fix
target 1 otherwise closed, silently dropping a TLV the peer meant to send instead of losing (and
counting) the one malformed PDU.

Fixed in [#87](https://github.com/larvit/larvitsmpp/pull/87): the optional parameters now have to end
on `command_length`, so this PDU is refused `ESME_RINVTLVSTREAM` like the sibling case. The hex above
is asserted octet for octet by `test/pdu.test.ts`, "refuses a bare TLV header the same way it refuses
a truncated value"; the same shape over a socket is `jsmpp.test.ts`, "a deliver_sm ending in a bare
TLV header gets ESME_RINVTLVSTREAM, and reaches no listener".

## Peer quirks

- **jsmpp's `session.getInterfaceVersion()` echoes what the driver declared, not what the earlier
  research pass expected.** `research/esme-clients-and-validators.md` A2 quotes jsmpp's own source
  (`scVersion != null ? IF_50.min(valueOf(scVersion)) : IF_34`) as defaulting to 3.4 whenever the
  server's `bind_resp` omits `sc_interface_version`. Binding at 0x33 against our server (which
  omits the TLV for a pre-3.4 peer) and reading `session.getInterfaceVersion()` back gives `0x33`,
  not `0x34` - this getter does not visibly take that fallback branch here. Recorded as observed;
  whether jsmpp's *internal* negotiated-version state (used, per its source, to decide whether to
  attach optional parameters to requests it sends) differs from what this getter reports is not
  established either way.
- **jsmpp accepts every one of our target-1/6 answers without closing the link.** `query_sm`,
  `cancel_sm` and `replace_sm` each raise a catchable `NegativeResponseException` carrying
  `ESME_RINVCMDID` (0x00000003); the session stays `BOUND_TRX` afterward (confirmed with a
  follow-up `enquire_link`). A strict, actively-maintained Java client tolerates the exact answers
  the interop plan's fixes promise.
- **Cloudhopper's SSL client (Netty 3.9.6.Final, last touched 2018) cannot complete a TLS 1.3
  handshake.** `setUseSsl(true)` against our server's default listener fails immediately with
  `org.jboss.netty.handler.ssl.NotSslRecordException: not an SSL/TLS record`, on the very first
  record. A plain Python `ssl.SSLContext` client handshakes the same listener at TLS 1.3 without
  issue, isolating the incompatibility to Cloudhopper's decade-old SSL stack rather than our
  server. Capping the S10 listener at `maxVersion: 'TLSv1.2'` resolves it completely - bind,
  submit and response all succeed. Not attempted: whether an older JRE for the *driver* (rather
  than capping the server) would let Cloudhopper negotiate TLS 1.3 on its own terms.
- **Cloudhopper's window-monitor expiry and its own per-call timeout are different exceptions.**
  Setting `requestExpiryTimeout` shorter than how long our (deliberately slow) handler holds a
  message completes the blocking `session.submit(pdu, timeoutMs)` call early with
  `RecoverablePduException`, distinct from the `SmppTimeoutException` a plain `timeoutMs` expiry
  raises - worth telling apart in anything scripting around Cloudhopper's timeouts. Our side does
  nothing unusual: the held message is answered on its own schedule, over the still-open socket,
  once our slow handler gets to it; nothing server-side errors or is left in a half-finished state.
- **tshark's per-frame JSON export undercounts `submit_sm` frames under a tight concurrent
  Cloudhopper burst on one TCP connection**, e.g. 90-92 total frames decoded across two otherwise
  identical runs of the same test file (`dumpcap` itself reports zero drops: "Packets
  received/dropped on interface 'any': 200/0"). Not chased further - `malformed`/`expert errors`
  are unaffected (both 0 on every run), and the S5 assertions rely on the driver's own structured
  per-request results, not the tshark histogram, for exactly this reason.

## Open questions

- Whether jsmpp's own negotiated-version fallback (the `IF_34` branch in its source) is reachable
  through any observable other than `getInterfaceVersion()` - not established this phase.
- Whether the tshark frame undercount under a Cloudhopper burst is specific to `-T json` batch
  export, or would also show up reading the same capture interactively - not investigated, time-
  boxed.
