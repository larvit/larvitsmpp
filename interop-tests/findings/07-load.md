# 07 load

Date: 2026-09-06. Repo commit: `ab93833`. Host: AMD Ryzen 9 5950X, 8 vCPUs allotted, 31GB RAM,
Alpine 6.18.38-0-virt kernel, Docker 29.6.2. Images: `interop-smppload:2.5.3-49fb653` (smppload
cloned at commit `49fb653`, tag 2.5.3, built with `erlang:27.3.4.17-alpine` + a fresh `rebar3`
3.27.0 release replacing the commit's own pre-OTP-27 vendored one), `interop-dumbclient:de0334b`
(vponomarev/libsmpp cloned at commit `de0334b`, built with `golang:1.26.8-alpine3.23` on
`alpine:3.23.5`), `nicolaka/netshoot:v0.16` (capture sidecar and tshark), `node:24.18.0-bookworm-slim`
(test runner, from the root `compose.yaml`).

## Setup

### smppload: builds, binds, then puts a corrupted PDU on the wire - blocked

Issue #8 (rebar3/BEAM load errors) is real but resolved in minutes: the commit's own vendored
`./rebar3` escript predates OTP 27 and fails to load under it
(`please re-compile this module with an Erlang/OTP 27 compiler`). Replacing it with a fresh rebar3
3.27.0 release before `make escriptize` fixes the build outright - no further patching needed, and
`git://` dependency URLs in `rebar.config` resolved fine once rewritten to `https://` (a one-line
`git config --global url.insteadOf`).

The built escript is not usable against any SMSC, though: every `bind_transceiver` it sends is two
octets short of what its own `command_length` declares. Captured with a raw tshark sidecar against
`ukarim/smscsim:0.2.0` (independent of both this library and smppload's own logging):

```
002a000000090000000000000001736d7070636c69656e74310070617373776f7264000050010100
```

40 octets on the wire, but `command_length` (the first 4 octets, if the PDU were whole) would need
to read `0000002a` (42) for a `system_id` "smppclient1" / password "password" bind - the actual
first two octets of that field are simply missing, so the wire instead starts `002a0000`
(2,752,512) with `command_id` and everything after shifted two octets early. tshark's own SMPP
dissector does not recognise the stream as SMPP at all (`-Y smpp` matches zero frames, though the
raw capture has the SYN/ACK/PSH/FIN sequence and the 40-octet data frame) - a second, independent
confirmation this is not merely a framing quirk our own codec is stricter about.

Traced as far as `oserl`'s `smpp_pdu_syntax:pack/2` (the `trx_deadlock_fix_1` branch smppload's
`rebar.config` pins), which builds the header as plain 32-bit bit-syntax
(`<<Len:32, CmdId:32, 0:32, SeqNum:32>>`) - correct on inspection, so the corruption happens
somewhere between that call and the socket write, not chased further given the time-box. Reproduced
identically on three separate runs (byte-for-byte). Recorded as **blocked**; `smppload.test.ts`
keeps a live reproducer asserting what our server does when it receives it (refuses the stream as
unframeable - see Scenarios) rather than removing the peer. `smpp-dumb-client` covers S9, and
substitutes for S6 and (partially) S8 - see below.

### smpp-dumb-client: builds and interoperates cleanly; its own window bookkeeping stalls under sustained load

No build friction. Two binaries from the same pinned source: `smpp-dumb-client` (unmodified) and
`smpp-dumb-client-noping` (its two `enquireSender()` call sites in `smpp.go` commented out at build
time), the second built because every load tool built for this phase sends `enquire_link` on its
own otherwise (`smpp-dumb-client` every 10s, unconditionally, not configurable) and smppload - the
one peer that genuinely never does - is blocked, leaving S6 with no peer at all otherwise.

One integration snag, not a build one: `smpp.remote` in `config.yml` is fed straight into
`net.ParseIP` (`hdr.go`) with no DNS resolution at all, so the compose service name cannot appear
there directly. Fixed in the entrypoint: every `conf/*.yml` carries a `NODE_HOST` placeholder,
resolved with `getent hosts` and substituted into a writable copy before the real binary starts.

Four one-shot scenarios share `dumbclient-w2000`'s network namespace (`network_mode:
"service:dumbclient-w2000"`) - they are pure outbound clients with nothing of their own listening,
so the only shared cost is a source IP, and one capture sidecar sees all four conversations with
`node:2775` the same way `compose.kannel.yaml`'s does for its four bearerbox variants.

The long soak (below) surfaced a peer-side limit worth designing around rather than fighting: with
a fast, immediate-response handler and a window of 100 - nothing our server should ever have
trouble draining - the peer's own reported in-flight count (`GetTrackQueueSize`, read from
`len(TrackTX)`) gets stuck pinned at the window within the first minute, and its log fills with
`Expired TX packet` lines (`libsmpp`'s hardcoded, non-configurable 7000ms `TX_MAX_TIMEOUT_MS`) -
throughput drops from ~500/s to a trickle of tens per second, gated by how many tracked entries
individually cross that 7s mark each second rather than by real responses being matched. Our own
server-side counters (`arrived`/`answered`/`peakOutstanding`, tracked independently in
`dumbclient.test.ts`) stay in lockstep throughout with a low peak - see Scenarios - which places the
stall entirely on the peer's own window bookkeeping, not on anything our server did or failed to
do. The soak test was redesigned around this: bounded by wall-clock (5 minutes) rather than a
target count, asserting the invariants that matter regardless of how much the peer's own bug lets
through (every arrival answered, nothing duplicated, memory shape), and reporting whatever
throughput was actually reached rather than requiring a specific one.

One test-harness bug found and fixed between the two runs below, not a library defect: the S6 test's
first version attached its `session.on('close', ...)` listener lazily inside the test body, after
already waiting on the S9 assertions (which can run for the better part of a minute) - by the time
the S6 test ran, the idle session had already closed, and an `EventEmitter` never replays a past
event to a listener added after it fired. Fixed by attaching every session's `close` listener at
`session`-creation time, recording it in the same per-scenario stats every other assertion reads.

Two runs of `./interop-tests/run.py dumbclient`. Run 1 (the original 300,000-count soak) surfaced
both the peer's TX-tracking stall and the S6 harness bug above; run 2, after both fixes, is the one
reported below. `smppload.test.ts` passed on every run it was given (three, across the investigation
above); its one scenario needs no repeat - a second run reproduces the identical corrupted PDU,
adding nothing.

```
dumbclient run 2: frames 111300, bind_transceiver 4/4, enquire_link 12 (enquire_link_resp 9 - the
                   capture stops moments after the test does, catching some requests before their
                   response), submit_sm 62441, submit_sm_resp 48830, malformed 0, expert errors 0
smppload:          frames 0 (tshark's own SMPP dissector does not recognise the corrupted stream at all)
```

`submit_sm_resp` reads lower than `submit_sm` in the capture for the same reason
`enquire_link_resp` does - the sidecar is stopped right after the test file's own `after()` hook
finishes, which is itself moments after the last response goes out, so a handful of writes land
after the capture stops seeing them. Not a lost response: `submit_sm` (62441) matches the sum of
every session's own `arrived` exactly, and every session's own `answered` matches its `arrived` too
(see Scenarios) - both counted independently, in the server process, of anything on the wire.

## Throughput and memory

`dumb-w500` and `dumb-w2000` (S9) both ran to their full 20,000-message count in ~44s each,
concurrently, against a handler serialised to answer roughly one message every 2ms
(`SLOW_HANDLER_DELAY_MS`) - `peakOutstanding` read exactly 500 and exactly 2000, the two configured
windows, confirming the peer never let more than its own window ride at once.

The soak (fast, immediate-response handler; window 100) reached 22,440 `submit_sm` over its fixed
300s observation window - about 75/s, well under the peer's own configured `rate: 500` and under
what our server can sustain (see Setup: `smpp-dumb-client`'s own TX-tracking bookkeeping is the
ceiling here, not our server - `peakOutstanding` stayed at 25 throughout). Sampled every 5s across
the whole run (69 samples over 340s, all four scenarios combined): rss first=170MiB, min=124MiB,
max=306MiB (during the two window runs' backlog), last=125MiB, heapUsed at the last sample 15MiB -
back below its own starting point once the backlog drained, not merely flat. No monotonic trend in
either direction.

## Scenarios (PLAN.md)

| Id | Result | Evidence |
| --- | --- | --- |
| S6 (idleTimeout, no peer ever pings) | pass | `dumbclient.test.ts` "S6 - idle peer..." - dropped at idleTimeout, `linkTimers - closing an idle peer` logged, no response past the one owed |
| S8 (throughput, long messages, receipts) | blocked (smppload) / partial substitute | smppload's own scenario is blocked - see Setup. The soak below gives a genuine submit_sm/s figure without long messages or receipts, which `smpp-dumb-client` does not support (`research/esme-clients-and-validators.md` section B) - and is itself capped well below what our server can sustain by the peer's own TX-tracking stall, also see Setup |
| S9 (bounded window) | pass | `dumbclient.test.ts` "S9 - bounded window..." - 20,000/20,000 answered on both window 500 and window 2000, in arrival order, no duplicate ids, `peakOutstanding` exactly 500 and exactly 2000 |
| Backpressure at the server | pass | Same run: `peakOutstanding` 2000 exceeds `maxHeldMessages` (1000, session-options.ts) and the eviction warning fires; window 500 (`peakOutstanding` 500) never does; memory sampled before/after the window runs (170MiB before, 306MiB after, 125MiB once the soak's own run had also settled) |
| Long soak | pass (run once at the redesigned, wall-clock-bounded shape - see Setup) | `dumbclient.test.ts` "Long soak" - 22,440 arrived, 22,440 answered, 0 duplicates, 0 unanswered errors, `close()` drains with no error |
| smppload bind corruption (not in PLAN.md - found this phase) | blocked | `smppload.test.ts` - our server refuses the unreadable stream instead of hanging |

## Defects in @larvit/smpp

None found. `smppload.test.ts`'s own scenario is smppload's defect, not ours: our server's reaction
(refusing the stream as unframeable, per the decision in the root `AGENTS.md`, "A stream this
library cannot frame...") is the documented behaviour working exactly as designed against a peer
that never gets as far as a readable PDU. The soak's throughput ceiling is the peer's own defect
(see Setup) - our own `arrived`/`answered`/`peakOutstanding` counters stayed clean throughout every
run.

## Peer quirks

- **smppload's `bind_transceiver` is corrupted on the wire** - see Setup. Not chased past `oserl`'s
  `pack/2` (which is correct on inspection) given the time-box.
- **`smpp-dumb-client`'s window bookkeeping stalls under sustained load, throttling its own
  throughput far below what a promptly-answering server can sustain** - see Setup. Its `enquire_link`
  interval (10s once bound as an ESME) is also hardcoded (`smpp.go`, `enquireSender(10)`), not
  exposed through `config.yml` at all - the no-ping binary built for S6 patches the call site out
  rather than configuring it.
- **`smpp.remote` takes a literal IP, never a hostname** (`net.ParseIP`, no DNS resolution) - see
  Setup.

## Open questions

- Whether smppload's bind corruption is in `oserl`'s `gen_esme_session`/`smpp_session` send path
  (not reached, given the time-box) or something specific to this build's dependency versions.
- Whether `smpp-dumb-client`'s stall is a sequence-number correlation bug (a response failing to
  match its `TrackTX` entry, falling back to the 7s expiry) or something else in its own window
  accounting - not chased past the observation in Setup, given the time-box and that the fault is
  clearly on the peer's side (our own counters stayed clean throughout).
