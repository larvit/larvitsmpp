# AGENTS.md

Guidance for LLM agents working in this repository. What each file in it is for is under
[Documentation](#documentation).

## What this is

A ground-up TypeScript rewrite of `larvitsmpp` 0.4.0, published as `@larvit/smpp` 1.0.0. The branch
started from an orphan commit — no history from 0.4.0 is carried over. The 0.4.0 source is still
readable on the `master` branch of the same repository and is the reference for protocol behaviour,
not for structure or style.

## Goals

In priority order, and the order is the point: where two of them pull against each other, the earlier
one wins. They do not override the hard rules below.

1. **Correct on the wire.** SMPP 3.4 as SMSCs actually run it. Every other goal yields to this one;
   the defect table below is what the alternative costs.
2. **Never give the application a wrong answer about what happened.** An outcome we cannot determine
   is reported as undetermined rather than guessed; a report the peer marked as not final settles
   nothing, so nothing the library concludes may rest on one; a request the peer may already have
   taken is never re-sent on the library's own initiative; work the peer has no reason to send again
   is not dropped.
3. **Strict in what we send, generous in what we read.** The library's own senders follow 3.4, and
   the codec parses whatever arrives. Where the letter of the spec would discard traffic a real SMSC
   sends, keep the traffic.
4. **A peer an operator never has to complain about.** No bind flooding, nothing a bind direction
   forbids, no optional parameters to a peer that declared none, nothing held without a bound.
5. **The session layer is in here, and its defaults are what most applications should run.**
   Keepalive, reconnect, the send window, reassembly and receipt correlation. What the network says
   about a message the application sent reaches it as a report rather than as an inbound message, and
   says whether it is final, so nothing has to read the PDU to tell those apart. An option retunes a
   default or opts out of it; an option does not switch on the thing the caller obviously wanted.
6. **A small, stable public surface over reshapeable internals.** Only what `src/index.ts` exports is
   published. A new option has to beat "the application can do this itself", and has to keep a
   promise this library can verify. The low-level surface is a passthrough: policy binds what the
   library composes, never what the caller wrote.
7. **Nothing that needs state wider than one session.** No throughput throttling, no persistence
   across a restart, no coordination between processes — and no seam handing the application state to
   persist for one of those either, which commits to the same scope through the back door and
   publishes an internal shape to do it. This is the scope floor, and it is why an otherwise
   reasonable feature is declined without a fresh argument each time.
8. **It builds, tests and runs the same everywhere.** Container-only toolchain, no runtime
   dependencies, the Node 18 floor verified in CI rather than asserted, every README example executed
   by the suite.

## Hard rules

These are not preferences. Breaking one is a defect.

1. **Nothing throws.** Every fallible function returns (or resolves to) a DTO carrying an optional
   `err`. No `throw`, no rejected promises, no exceptions as control flow. Node APIs that throw are
   wrapped at the boundary and converted into a result. Programmer errors (bad arguments) are
   results too.
2. **Log messages are static strings.** Every dynamic value goes into the log metadata. Never
   interpolate, never concatenate.
   - GOOD: `log.debug('sendSms() - splitting message', { parts: msgs.length, to });`
   - BANNED: `log.debug('sendSms() - splitting into ' + msgs.length + ' parts');`
3. **No `error` event.** Node makes an unhandled `error` event throw, which would break rule 1.
   Sessions emit `sessionError`, servers emit `serverError`.
4. **No casts, no non-null assertions.** `as`, `as unknown as` and `!` are all banned. Parse untyped
   input once through a type guard at the boundary; everything past it is typed. `noUncheckedIndexedAccess`
   is on, so every lookup into a record or buffer is `T | undefined` until you handle it — that is the
   point, not an obstacle to route around.

## Architecture

```
src/
	index.ts             Public surface. Named exports only, no default export.
	client.ts            client() -> { err, session }
	server.ts            server() -> { err, server }, server owns the listener + close()
	session.ts           Session: the socket's life, dispatch, events, and the collaborators below
	sms.ts               The live handle emitted as the 'sms' event (sendResp/sendDlr)
	dlr.ts               Delivery receipts: text and TLV parsing, receipt status codes
	dlr-merger.ts        DlrMerger: per-segment receipts counted into one MessageDlr
	error-from.ts        errorFrom(): whatever was thrown or rejected, as an Error
	expiring-groups.ts   ExpiringGroups: the capped, expiring store both of those share
	held-messages.ts     HeldMessages: capped, expiring messages the application has not answered
	idle-waiters.ts      IdleWaiters: waiting for a count to fall to zero, and what is left of a budget
	incoming-requests.ts Every request the peer sends: messages, receipts, links, unknown commands
	link-gate.ts         LinkGate: where a request with no link to go out on waits for the next one
	link-timers.ts       LinkTimers: the enquire_link heartbeat and the idle timeout
	log.ts               SmppLog, the logger contract, and silentLog — the default
	message.ts           Encoding detection, splitting, bit counting, SMPP date formatting
	outgoing-requests.ts OutgoingRequests: the gate, the window, the pending map and the retry
	pdu.ts               pduToObj / objToPdu / pduReturn — synchronous, result-returning
	pdu-framer.ts        PduFramer: a byte stream cut into complete PDUs
	pdu-transport.ts     PduTransport: the socket a session reads complete PDUs off
	pending-requests.ts  PendingRequests: sequence numbers, correlation, timeout, abort
	reassembly.ts        Reassembler: capped, expiring multipart groups
	reconnect-loop.ts    ReconnectLoop: backoff, retry timer, stopped-ness
	result.ts            Result<T> — the shape every fallible call returns
	send-sms.ts          submitSms composition and the submitSmParams builder
	send-window.ts       SendWindow: the maxOutstanding semaphore
	session-options.ts   SessionOptions, ReconnectOptions, bind direction and the session defaults
	sms-id.ts            The notation a peer writes message ids in, normalised for comparison
	udh.ts               User data header: the concatenation fields of a long SMS, and their reference
	unanswered-error.ts  UnansweredError: it went out and no answer came back
	uuid.ts              uuidv7() — the ids the library generates for messages
	defs/
		commands.ts      The 33 commands, their ids and ordered parameter lists
		constants.ts     consts + constsById, and the SMPP version constants
		encodings.ts     GSM 03.38, LATIN1, UCS2, detection, data_coding resolution
		errors.ts        errors + errorsById (ESME_*)
		tlvs.ts          TLV definitions, tlvsById
		types.ts         Wire types: int8/int16/int32/string/cstring/buffer/arrays
```

Dependency direction is one way: `defs` knows nothing above it, `pdu` uses `defs`, `session` uses
`pdu`, and `client`/`server` use `session`. Nothing reaches back up.

**Parameter order is wire order.** The key order inside `cmds.*.params` is the order the fields are
written to and read from the buffer. Never sort those alphabetically — the alphabetical-ordering
convention applies everywhere else, but here it corrupts every PDU.

## Toolchain

Run everything through the container; never invoke node or npm on the host.

```bash
docker compose run --rm node npm install
docker compose run --rm node npm test
docker compose run --rm node npm run build
```

- Tests are `.ts` and run directly under Node's type stripping — no build step in the dev loop.
- Source imports use `.ts` extensions; `rewriteRelativeImportExtensions` emits `.js` into `dist`.
- `erasableSyntaxOnly` is on, so no enums, no namespaces, no parameter properties. Use `as const`
  objects plus union types.
- The published floor is Node 18, but the dev container runs Node 24 (type stripping needs it). CI
  compiles the tests and runs them on 18/20/22/24, so the floor is verified rather than asserted.
- `typescript` is pinned to the 6.x line because `typescript-eslint` peer-requires `<6.1.0`. Move to
  TypeScript 7 once that constraint lifts.

## Defects found in 0.4.0

Every row names what 0.4.0's own code did, so it is not rebuilt here.
[README.md](README.md#behaviour-that-changed-on-the-wire) names what changed for a consumer, and is
the only place that does. Confirmed by reading the 0.4.0 source; each row has a regression test
naming the behaviour.

| Defect | 0.4.0 behaviour |
| --- | --- |
| LATIN1 never decodes | `decodeMsg` loops `consts.ENCODING` without breaking, so `data_coding` 0x03 lands on the alias `ISO_8859_1`, which has no decoder, and silently falls back to ASCII |
| Short segments | `splitMsg` accumulates a full segment then pushes `msgPart.slice(0, -1)`, so every segment is one character short: 152 GSM characters instead of 153, 66 UCS2 instead of 67. Long messages are split into more segments than they need, and each extra segment is billed |
| DLR month off by one | `smppDate()` uses `getMonth()` (0-based) without `+1`, so January renders as `00` |
| Non-standard DLR status | Receipts emit `stat:UNDELIVERABLE`; the spec's field is 7 characters (`UNDELIV`) |
| Flash destroys UCS2 | `flash: true` overwrites `data_coding` with 0x10, discarding the UCS2 alphabet, which needs 0x18 |
| Shared concat reference | The concatenation reference counter is a module-level global shared by every session in the process |
| `send()` never times out | Each call adds a listener keyed on the sequence number; a peer that never answers leaks it and the promise never settles |
| `tls: true` is not TLS | Constructs a bare `new tls.Socket()` with no handshake instead of `tls.connect()` |
| Alphanumeric sender TON | `sendSms` hardcodes `source_addr_ton` to 1 (international) even for alphanumeric senders, which require TON 5 |
| Text-only DLRs refused | `deliver_sm` without both `message_state` and `receipted_message_id` TLVs is rejected with `ESME_RINVTLVSTREAM`, so Kannel-style receipts are unusable |
| Unbounded reassembly | Incomplete long-SMS groups are capped by nothing and swept only when other traffic arrives, after 24 hours |
| Dead DLR aggregation | `longSmsDlrs` is allocated to merge per-segment receipts and then never used |
| Trailing NULL truncation | `types.buffer.size()` subtracts one whenever the value's last octet is `0x00`, so the PDU is allocated one octet short while `sm_length` still reports the full length. Any UCS2 message ending in a character like U+4E00 or U+3000 goes out corrupt |
| Dormant filters | `defs.filters` is declared on commands and TLVs but never invoked anywhere |
| Unchecked reads | Wire reads index straight into the buffer, so a short or malformed PDU throws out of the codec |
| Unrangechecked writes | Integer params are handed to `writeUInt8`/`writeUInt16BE` unvalidated, so an out-of-range value throws from inside Node |
| `submit_multi` missing `sm_length` | The field is commented out of the command table, so `short_message` never round-trips for that command |
| Per-parameter defaults never applied | `calcCmdLength` reads `paramType.default` (the wire type's) rather than the parameter's, so `interface_version: 0x50` on the bind commands did nothing and every bind declared version 0x00 |
| `source_telematics_id` width | Defined as a 2-octet integer; SMPP 3.4 5.3.2.8 makes it 1 octet, unlike `dest_telematics_id`, which really is 2 |
| Binary payloads decoded as text | `data_coding` 0x02, 0x04, 0x14 and 0xF4-0xF7 are 8-bit binary and land on the GSM 03.38 table, which rewrites every octet outside it |
| Binary TLVs round-trip corrupt | `pduToObj` turns a `Buffer` TLV value into a hex string (`utils.js:307`), and `objToPdu` writes that string back as its own ASCII, so `message_payload`, `network_error_code`, `callback_num` and the rest are destroyed by any round trip |
| `ESME_RINVBCASTCHANIND` typo | Defined as `0x011`, three hex digits; the spec value is `0x0112` |

## Multipart sends and the send window

`sendSms` puts every segment of a message on the wire together instead of waiting for each response
in turn. This is not an optimisation: this library's own server holds segments until the whole
message is reassembled before it answers any of them, so sending them one-after-a-response
deadlocks. It follows that a message with more segments than `maxOutstanding` cannot be delivered to
a server that defers responses that way — real SMSCs answer each `submit_sm` immediately, so this
only bites when both ends are this library.

## GSM 7-bit is sent unpacked

Over SMPP the ESME puts one GSM character per octet in `short_message` and the SMSC packs it into
septets. The 140-octet limit applies to that packed result, not to what goes on the wire here, which
is why a concatenated segment is 153 characters plus a 6-octet UDH — 159 octets in `short_message`,
and entirely correct. Do not "fix" this to 134; that number is the packed payload size and would
truncate every long message by a fifth.

UCS2 is not packed, so there the two coincide: 67 characters = 134 octets, plus the 6-octet UDH is
exactly 140.

## Conventions

- Hard tabs. Alphabetical ordering for keys, imports and lists unless order is logic-significant.
  Two deliberate exceptions: command parameters are in wire order (above), and the `errors` and TLV
  tables are ordered by their numeric id so they can be diffed against the spec and gaps stay visible.
- Comments are the exception, not the default — see the root `CLAUDE.md` rules. Do not write file
  preambles or restate what the code says.
- Test data uses real randomised UUID v7 values, never `aaaa-0000` placeholders.
- `message_id` values the library generates are UUID v7.
- A test that needs a dummy peer must `resume()` its sockets. An unread socket never processes the
  peer's FIN, so `server.close()` hangs forever — that is a test bug, not a library one.
- Everything a test opens gets its teardown registered as it is opened, never closed on the test's
  last line: an assertion that throws skips that line, and the listener it leaves behind keeps
  `node --test` alive until CI's ten-minute cap. `test/teardown.ts` covers a session, a server and a
  listener; anything else takes a bare `t.after`. Its close aborts rather than drains, so a test that
  fails holding the send window still ends.
- `t.after` hooks run in registration order, so registering at creation tears the outermost resource
  down first. A teardown that waits on a listener must destroy that listener's own connections before
  it waits, or be registered after the hook that does — `net.Server.close()` does not call back until
  every connection on it is gone.
- `assert.equal` from `node:assert/strict` narrows its first argument, so a following `?.` on the
  same value is flagged as unnecessary. Assert once with `assert.ok(x)` and use plain access after.

## Documentation

Each file answers one question, and a fact belongs to the file whose question it answers:

- **README.md — what you can rely on.** Observable behaviour, for someone using the package. It
  carries a reason only where the reason changes how you would call the thing.
- **AGENTS.md — what may not change, and why.** Goals, hard rules, architecture, conventions, and the
  decisions the goals do not already settle. It does not restate behaviour README states.
- **todo.md** is a temporary working file that sets its own rules; nothing here governs it.

A sentence living in two of them is a defect: delete the copy in the file whose question it does not
answer. The toolchain commands are the one deliberate exception — README's copy serves a contributor
who never opens this file, and this file's copy carries the constraint that nothing runs on the host.

**Write a decision down only when it cannot be put better as a goal.** A goal decides every case that
follows from it; a decision record decides one. So reach for the goal list first — sharpen a goal,
add one, or move one up the order — and write a decision only for what is left over: a choice a
competent change would otherwise re-open, that no goal implies. Give the claim, the constraint that
settled it and the alternative rejected, and nothing the code or README already says. Where a
compiler or a test already forbids the other way, it is not a decision, it is a test name. Delete one
once it no longer constrains anything; this is not a changelog.

## Decisions

Grouped by what each one constrains.

### The public surface

- **`Session` is publicly constructible, which is what makes `SessionOptions` and `ReconnectOptions`
  public too.** Raised twice as a leak; it is not one. The collaborators `session.ts` delegates to
  (`Reassembler`, `PendingRequests`, `SendWindow`, `ReconnectLoop`, `LinkTimers`, `LinkGate`,
  `DlrMerger`, `PduTransport`, `submitSms`) stay unpublished so they can be reshaped.

- **`acceptsOptionalParams()` and `bindAllows()` are predicates, not chokepoints.** The library's own
  senders consult them; `session.send({ tlvs })` is passed through as written, because silently
  stripping a caller's explicit TLVs off a deliberately public low-level surface would be worse than
  sending them. Only `submit_sm` and `deliver_sm` are policed by bind direction — the only two the
  library sends and dispatches by it.

- **`session.sock` is a getter over `PduTransport`.** Reading it is unchanged; assigning it no longer
  compiles, which never rewired the handlers and so never worked.

- **Both emitters re-declare their listener methods to accept a promise.** Maintainer's call,
  2026-08-27: `EventEmitter` types every listener as void-returning, so the
  `session.on('sms', async sms => …)` README documents reads as a misused promise in any strict
  consumer. `declare on: …` and its six siblings re-type the inherited methods to return `unknown`,
  which emits nothing and needs no cast; overriding them as real methods cannot work, because the
  `super.on()` call needs one. The cost is that a subclass can no longer reach those seven through
  `super` — re-declaring them the same way is its way out. `unknown` rather than
  `void | Promise<void>` because a listener may return anything: `session.on('close', () =>
  set.delete(session))` returns a boolean. This also settles what the drain can wait on: a listener's
  own promise would be the better completion signal, and reaching it needs `listeners()`, which
  cannot be re-declared the same way — Node types it invariantly enough that widening `void` to
  `unknown` is `TS2416`. Re-probed 2026-09-01; `sendResp()` stays the signal.

### The wire

- **The declared interface version is an option on both `client()` and `server()`, and is not the
  optional-parameter threshold.** That threshold is fixed at 0x34 by the spec, so an implementation
  that must declare 5.0 throughout can, without moving it.

- **A peer that declared no version is pre-3.4, and `undefined` means no bind yet.** `acceptBind()`
  records what the ESME declared and the client's `bind()` records the `sc_interface_version` the
  SMSC answered with; a peer that declared nothing is recorded as `undeclaredInterfaceVersion` (0x00)
  and sent no optional parameters, which is how the spec reads an absent `sc_interface_version`.

- **`esm_class` decides what a `deliver_sm` is, and the body is read only when it names nothing.**
  The two types the MC writes about a message we submitted — `MC_DELIVERY_RECEIPT` (0x04) and
  `INTERMEDIATE_DELIVERY` (0x20) — are reports whatever the body parses to, so one in a format
  `dlrFromPdu()` cannot read reaches `dlr` with `smsId` undefined instead of arriving as an inbound
  SMS. The three the far-end SME writes (0x08, 0x10, 0x18) are messages and their bodies are not
  scraped: Kannel reads 0x08 as report-bearing and this does not, because a delivery acknowledgement
  is the handset's word about a message, not the network's. A message type of 0 or one of the ten
  reserved keeps the scrape, and a non-empty `receipted_message_id` TLV marks a report on the same
  footing. A report this library recognises never reaches the reassembler, so an SMSC that splits one
  across segments gets a `dlr` per segment rather than one merged report. The `message_state` TLV is
  authoritative only where it names a state in the table — SMPP reserves 0x80-0xFF for
  MC-vendor-specific values, so an unnameable one keeps its raw `statusId` and leaves `statusMsg` to
  the body.

- **A report is final unless its `esm_class` or its state says otherwise, and only `ENROUTE` and
  `SCHEDULED` say otherwise.** SMPP 3.4 Appendix B lists every other receipt state as final,
  `UNKNOWN` and `ACCEPTED` included, so a peer writing `ACCEPTD` for a carrier-accepted step is taken
  at its word. Rejected: reading `UNKNOWN` as non-final, which leaves a peer whose receipt body this
  library cannot read with no `messageDlr` at all — goal 2 wants that reported as undetermined, not
  withheld. Both spellings resolve into `Dlr.intermediate` at the boundary rather than being read a
  second time in `DlrMerger`, so the library cannot answer the application one way and conclude the
  other. Not every peer marks a transient report 0x20 — an ordinary receipt carrying `stat:ENROUTE`
  is common — so the state test is what the marker test cannot replace. `message_state` 0 is 5.0's
  `SCHEDULED` and undefined in 3.4; a peer that writes it is read as transient rather than as saying
  nothing, maintainer's call, 2026-09-03, since the codec refuses a zero-length integer TLV and so an
  absent one cannot land there.

- **A transient state goes out as an intermediate delivery notification (0x20), every other state as
  a delivery receipt (0x04).** Appendix B makes a receipt's `stat` the message's final status, so
  0x04 over `ENROUTE` emits the two disagreeing spellings of finality the reading side above has to
  reconcile, and goal 3 has our own senders write the marker 3.4 defines. `sendDlr()` takes the list
  from `transientStates` in `dlr.ts`, the same one the reader uses, so the two cannot drift.
  Rejected: 0x04 for every state, for the sake of a peer that classifies on the marker — the cost
  accepted here is that such a peer stops recognising a transient report as a report at all and hands
  its application receipt text as an inbound message, where under 0x04 it would have read the state
  from `stat:` and been right. A transient state also carries `err:000`, since a message still on its
  way has not failed.

- **A refused PDU is answered from its header, and any 32-bit `sequence_number` is echoed as it
  arrived.** Maintainer's call, 2026-09-05 via the interop plan. The header of a framed PDU always
  parses, so it carries the answer SMPP 3.4 4.3 asks for, with the status 3.4 names for the part
  that would not parse. Rejected: nacking a refused *response*, whose sequence number is one of
  ours — the `generic_nack` would land in the peer's own numbering and nack a request of the peer's
  we never saw, so a refused response is written back nothing and settles the request it names
  instead. An unknown command id with the response bit set takes that branch too: a peer echoing a
  sequence number of ours is answering something, and settling it reaches the undetermined outcome
  `responseTimeout` would have reached anyway, sooner. Rejected: clamping a sequence number outside 4.7.1's 0x00000001–0x7FFFFFFF into range
  before answering, which correlates with nothing at the peer — stacks write the field as a plain
  uint32 (ukarim/smscsim signs every unprompted `deliver_sm` with a raw `rand.Int()`), so goal 3
  keeps that traffic and `PendingRequests.nextSeqNr()`, the only thing that invents one, is what
  holds our own sends inside the spec.

- **`smsIdFormat` names a notation per place, and normalisation never reaches inside a `<base>-<n>`
  id.** An SMSC may answer `submit_sm_resp` in hex and write the receipt's `id:` in decimal, so one
  transform over both sides cannot make them equal. `submitResp` covers the `receipted_message_id`
  TLV too, which SMPP 3.4 5.3.2.26 defines as the id the `submit_sm_resp` carried: naming one
  notation for whichever id a receipt yields would break the peer that sends both. Omitting a place
  is what leaving it alone means, so there is no `raw` notation, and a caller-supplied formatter is
  refused because it would make the promise that the two ids are comparable unverifiable — `onRequest`
  and the PDU on the `dlr` event are the escape hatches. A `<base>-<n>` id parses as no number and so
  reaches `expect()` and `collect()` unchanged, which is what keeps `DlrMerger` working; normalising
  the base instead would break that pair. The option is on `client()` only, since a `server()` session
  writes both ids itself.

### The session's life

- **A close arriving after our own `unbind` is a clean unbind, not an error.** Maintainer's call,
  2026-08-26: most SMSCs drop the socket instead of answering, so the documented shutdown would
  otherwise always report a failure. It does mask a socket that died mid-unbind for an unrelated
  reason, which is accepted — the peer sees the same TCP close either way.

- **`close` means the session is over, and a drop the loop will retry is `disconnected`.**
  Maintainer's call, 2026-08-31: without the split, an application that opens a replacement client on
  `close` ends up holding two binds on one account. `teardown()` picks the event by whether the
  reconnect loop is still live, and `end()` stops that loop before tearing down, so every deliberate
  shutdown emits `close`. A retry that opens a socket and then loses it clears `closed` through
  `attach()`, which is why a second drop emits again.

- **An answer belongs to the link the message arrived on; a receipt does not.** Maintainer's call,
  2026-09-01. Rejected: answering on the new link, which succeeds and reports `{}` for a response
  that correlates with nothing — goal 2's wrong answer. Accepted: a receipt sent after a refused
  response names an id the peer has no record of.

- **`reconnect` takes `{ minDelay, maxDelay }` to retune and `false` to turn off**, so absent means
  on and there is one spelling for each. Only `client()` reconnects — a `server()` session is a
  connection the peer opened, and nothing at this end can reopen it. The retry timer is `unref()`'d,
  so a process with nothing else left to do still exits between attempts.

- **Coming up is not proof a link works, so only one that outlasted `maxDelay` resets the backoff.**
  An unreadable stream is found after the bind returns, so resetting on connect gave a link that died
  on arrival a fresh `minDelay` every cycle — one TCP connect and bind per second, forever. A drop
  after a healthy link still retries at `minDelay`.

- **A stream this library cannot frame is a dead link; one PDU it cannot parse is not.**
  Maintainer's call, 2026-08-31, narrowed 2026-09-05 via the interop plan: a `command_length` below
  16 or above `maxPduLength` leaves nothing that can say where the next PDU starts, so it tears the
  link down through `teardown()` and the reconnect loop retries it on a fresh socket with a fresh
  framer. Every other codec failure honoured `command_length`, so the stream is still in sync and
  the next PDU starts where it says — tearing the link down there cost one peer half its receipts
  and its MO to a reconnect loop (`interop-tests/findings/01-smscsim.md`), and left the peer waiting
  for answers it was owed. `sessionError` carries every failure of either kind, never coalesced or
  suppressed, so a peer that only ever sends garbage is visible in the log rather than silent.

- **A deliberate shutdown drains; an unusable link and an abort do not.** `close()` and `unbind()`
  wait on the send window rather than the pending map — the map misses a segment still queued behind
  a full window, and finishing a half-sent multipart message is the point. The window counts slots,
  never outcomes, and empties on a drop too, where `teardown()` settles everything the link was
  carrying, which is why `drain()` reads `closed` before it reads the count. A stream the framer or
  the codec cannot read takes `teardown()` instead, and `close({ signal })` on an aborted signal and
  a peer's own `unbind` take `end()`: nothing on a dead link can answer, an abort means stop now, and
  a peer that has declared itself finished will not answer what it still owes, so draining any of the
  three would only hold a socket open for the timeout. `unbind()` sends its own PDU through
  `request()` past both the window and the drain gate, because it must go out either way.
  `shutdownTimeout` stays a session option rather than a `close()` argument: `server()` builds
  sessions on the caller's behalf, so the option is the only composition point. `SmppServer.close()`
  reports each session's unfinished drain through `serverError`, because its own result says nothing
  but that the listener stopped.

- **The drain waits on the messages the application holds, and `sendResp()` is what says it is done
  with one.** Maintainer's call, 2026-09-01: waiting on the send window alone tore a server session
  down while the application was still answering a `submit_sm`, so the peer timed out and re-sent —
  the duplicate goal 2 forbids, in the direction the window already covers. No completion signal was
  added to the `sms` event: `sendResp()` is the answer the peer is waiting for, so it is the one the
  drain waits for. Counting every inbound request until `sendReturn()` answered it was rejected —
  an `onRequest` that deliberately answers nothing would then cost a full `shutdownTimeout` on every
  close — and a message no listener took is released at once, since nothing is going to answer it.
  A listener that failed before answering gives it up the same way, but only once every listener has:
  a throw stops `emit()` where it stands, while a rejection leaves the others running, so the release
  waits for the last of them rather than answering on their behalf. What ends the wait is the response
  reaching the wire, not the call — a `sendResp()` the library refused, or one the socket would not
  carry, leaves the message held, so `close()` still reports the one the peer is owed. `teardown()`
  drops what is still held for the same reason it drops inbound segments. The release is one turn
  late, so a listener that sends its receipt straight after the response is still holding when the
  drain looks; `sendDlr()` is the one send that goes out past the drain's refusal, and only while the
  message is still held — past that it is an ordinary send, because the drain it would slip past is
  no longer waiting for it. `shutdownTimeout: 0` does not carry over to this half:
  waiting forever is safe for the peer, whose every request is bounded by `responseTimeout` unless the
  caller set that to 0 as well, and unsafe for the application, which nothing bounds — `close()` is
  what you reach for when the application is stuck, so it may not block on the application coming
  unstuck. That half falls back to `responseTimeout`, the same answer the link gate's hold already
  takes — and to that option's default where it is 0 as well, since neither option is an answer about
  the application. What is held is capped and expiring like every other inbound store, on constants
  rather than options, because a bound the application cannot raise is the point: an application that
  answers nothing would otherwise grow it for the life of the link, which goal 4 forbids. A message
  that falls out of the bound is one the drain stops waiting for, so `close()` can report fewer
  unanswered than there were — accepted, because the alternative is holding what nothing will answer,
  and both exits are logged.

- **A reconnect keeps the delivery-receipt merges; everything else the link held is dropped.**
  `onDeliverSm()` answers each receipt before the group it belongs to is complete, and `teardown()`
  runs on every path — an idle timeout and a failed rebind, not only `close()` — so clearing the
  merges there loses receipts no peer has a reason to send again. They are cleared where the session
  is over instead. Inbound segments stay in `teardown()`, because they go unanswered until the
  message is whole: the peer still holds them, and answering it on a later link with the old
  segments' sequence numbers would correlate with nothing.

- **A message id base is merged at most once.** A receipt carries nothing but `<base>-<n>`, so a
  straggler for a message whose group is gone cannot be told from a receipt for a later message the
  peer handed the same ids — an SMSC whose id counter restarts with its process is the realistic
  case. `DlrMerger` remembers the bases it has finished with, capped and expiring exactly like the
  groups, and refuses to open one a second time: the later message gets no `messageDlr`, and an
  earlier one whose receipts are still arriving is dropped rather than left to collect the later
  one's. Every segment still reaches the application as a `dlr`. `expect()` ignores a lone id, so a
  single-part message never claims a base.

- **A send that never reached the socket waits for the next link; one that did is counted, not
  resent.** Maintainer's call, 2026-09-01: re-queueing everything unanswered would resend a
  `submit_sm` the SMSC accepted and answered into a dead socket, which is delivered and billed twice,
  while a request that never left this process can be lost for free. `attempt()` therefore wraps all
  three ways a written request can fail in `UnansweredError`; counting only the dropped-link case, as
  the first cut did, would have called the commonest one safe to resend. A count rather than a
  boolean because `sendSms()` aggregates segments into one `err` slot, and required rather than
  optional so every construction site answers. `UnansweredError` stays unexported: `unanswered` is
  the one spelling on the public surface. The hold is bounded by `responseTimeout` rather than an
  option of its own — that is already the answer to how long one request may wait — and its clock
  starts when the send is issued rather than when it first finds the gate shut, so one budget covers
  every hold a single call makes. That timer is the one here that is not `unref()`'d: a held request
  is awaited with the socket already destroyed, so an unref'd one lets a process whose only remaining
  work is that send exit without settling it.

- **The gate decides whether a link can carry a request, and a bind is what makes it one.**
  Maintainer's call, 2026-09-01: `attach()` clears `closed` the moment a socket is handed over, one
  round trip before the bind is answered, so gating on `closed` let a send arriving in that window go
  out unbound and come back `ESME_RINVBNDSTS`. `LinkGate` owns the answer instead — `shut(returning)`
  on every teardown, `open()` only once `comeBackUp()` has a bound link — and
  `OutgoingRequests.linkDown()` reads it rather than `closed`. The bind itself cannot wait for what it
  creates, so `pastDrain()` lets the three bind commands past the gate and the window, the same door
  `unbind()` takes through `now()`. The gate is told what happened and never reads back into the
  session: a collaborator that has to ask does not own its decision, which is how the first cut ended
  up answering the same question two different ways at admit and at release. For the same reason the
  retry in `pastDrain()` asks `gate.isUp()` rather than `linkDown()`, which also reads the socket — a
  condition that loops on something the gate does not gate on spins against a gate that admits it
  straight back. `LinkGate.returning` is a copy of `retrying()` taken at teardown, and stays true
  only because nothing stops the reconnect loop without `emitClose()` following it: `drain()` and
  `end()` are the only callers of `stop()`. A third caller has to shut the gate itself.

### Internals and tests

- **A listener that rejects is routed by Node's `captureRejections`, not by hand-dispatching.** Both
  emitters construct with `captureRejections: true` and implement
  `[EventEmitter.captureRejectionSymbol]`, which lands a rejected `async` listener on `sessionError`
  or `serverError` beside the synchronous guard in `emit()`. Dispatching `rawListeners()` from
  `emit()` instead needs a cast to call them with the event's argument tuple, which hard rule 4
  forbids. A rejection reason is `unknown` and `String()` throws on a null-prototype object, so both
  handlers normalise through `errorFrom()` rather than inline — a route out of the handler would land
  on a bare `process.nextTick` with nothing to catch it.

- **`SmppLog` is a five-method contract this library declares, not a dependency.** `debug`, `error`,
  `info`, `verbose` and `warn` are what the code actually calls, so an application can satisfy it
  with an object literal. `@larvit/log` implements it structurally and stays a devDependency, where
  `test/tls.test.ts` passing a real `Log` as the server's logger keeps that compatibility compiled.

- **The TLS tests build their own self-signed certificate in DER** (`test/tls.test.ts`) instead of
  adding a devDependency or shelling out to openssl. Maintainer's call, 2026-08-26: the dev image
  `node:24.18.0-bookworm-slim` ships no openssl binary, so a shelled-out fixture would pass in CI and
  fail on every developer machine, and a committed key leaks in a public repository. Valid while the
  dev image has no openssl.
