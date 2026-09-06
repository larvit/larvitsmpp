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
	concat.ts            How a PDU says it is a segment: its UDH, or the sar_* TLVs
	dlr.ts               Delivery receipts: text and TLV parsing, receipt status codes
	dlr-merger.ts        DlrMerger: per-segment receipts counted into one MessageDlr
	error-from.ts        An untyped value as error material: errorFrom() an Error, namedValue() a name
	expiring-groups.ts   ExpiringGroups: the capped, expiring store both of those share
	held-messages.ts     HeldMessages: capped, expiring messages the application has not answered
	idle-waiters.ts      IdleWaiters: waiting for a count to fall to zero, and what is left of a budget
	incoming-requests.ts Every request the peer sends: messages, receipts, links, unknown commands
	link-gate.ts         LinkGate: where a request with no link to go out on waits for the next one
	link-timers.ts       LinkTimers: the enquire_link heartbeat and the idle timeout
	log.ts               SmppLog, the logger contract, and silentLog — the default
	message.ts           Encoding detection, splitting, bit counting, SMPP date formatting
	message-body.ts      Where an inbound body is: short_message, or the message_payload TLV
	outgoing-requests.ts OutgoingRequests: the gate, the window, the pending map and the retry
	pdu.ts               pduToObj / objToPdu / pduReturn — synchronous, result-returning
	pdu-framer.ts        PduFramer: a byte stream cut into complete PDUs
	pdu-refusal.ts       A PDU the codec would not read, and the answer SMPP names for it
	pdu-transport.ts     PduTransport: the socket a session reads complete PDUs off
	pending-requests.ts  PendingRequests: sequence numbers, correlation, timeout, abort
	reassembly.ts        Reassembler: capped, expiring multipart groups
	reconnect-loop.ts    ReconnectLoop: backoff, retry timer, stopped-ness
	result.ts            Result<T> — the shape every fallible call returns
	send-sms.ts          submitSms composition and the submitSmParams builder
	send-window.ts       SendWindow: the maxOutstanding semaphore
	session-options.ts   SessionOptions, ReconnectOptions, bind direction and the session defaults
	sms-id.ts            Message ids: the peer's notation, the <base>-<n> a segment gets, which response carries one
	udh.ts               User data header: its length, the concatenation fields of a long SMS and their reference
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
| `sar_*` segmentation unread | `session.js` reassembles on the UDH alone, so a message segmented with `sar_msg_ref_num`/`sar_total_segments`/`sar_segment_seqnum` — SMPP 3.4's other spelling, and Jasmin's documented default — reaches the application one fragment per segment |
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
| Every response carries a message id | `session.js` builds `params = {'message_id': …}` for every response it sends, `deliver_sm_resp` included; SMPP 3.4 4.6.2 makes that field unused and NULL, and Jasmin closes the connection on one |

## Multipart sends

`sendSms` puts every segment of a message on the wire together instead of waiting for each response
in turn, so a long message costs one round trip rather than one per segment. Nothing on the
receiving side forces the order either way: this library answers each inbound segment as it arrives,
so a peer that dispatches one request at a time is never left waiting on us.

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
- Fixtures that encode the wire are shared so no two files can drift on it: `test/raw-pdus.ts` builds
  the octets a test writes straight to a socket, the PDUs `objToPdu()` refuses to build included. The
  waiting helpers each file carries are copies, tolerated because a wrong one fails that file's own
  tests and nothing else.
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
  sending them. Only `submit_sm`, `deliver_sm` and `data_sm` are policed by bind direction — the
  three the library dispatches by it, of which it sends the first two.

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

- **`PduRefusedError` is exported, and `sessionError` names it in the event's type.** Maintainer's
  call, 2026-09-05, from a product review: one event carries both a PDU the peer malformed and the
  session's own failure, and `instanceof` is the only way to separate them that hard rule 4 allows —
  without the class as a value an application is left string-matching `err.message`. Goal 6 is paid by
  exporting the discriminant and the struct it carries and nothing else: `PduHeader` is named because
  an application that logs or forwards a header wants a name for it, `PduRefusalReason` is not
  because `reason` is compared against string literals, and an accessor
  (`PduRefusedError['header']`) names either one where a signature wants it. The payload union
  enforces nothing — a subclass narrows out of `Error` either way — and is there so the event's own
  type names what to narrow to, which is also what makes it a half-truth if a second `Error` subclass
  ever reaches this event without joining it. Rejected: a `SessionError` alias for that union, a
  third name for a type that is structurally `Error`. Rejected: a separate `pduRefused` event, which
  splits the failure channel so an application that wants every failure listens twice and an existing
  listener silently stops seeing refusals. Rejected: coalescing or rate-limiting them, which re-opens
  the standing decision that `sessionError` carries every failure, never coalesced or suppressed —
  the filtering belongs where the application is, since only it knows which peer is routinely sloppy.
  Rejected: an error code on a plain `Error`, which reads back off an `unknown` property only through
  a cast and types nothing it carries. Accepted: a second copy of the package installed alongside
  this one defeats `instanceof`, where `err.name` still reads `PduRefusedError`.

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

- **A body is read from `message_payload` where `short_message` carries none, and `short_message`
  wins where a peer filled both.** Maintainer's call, 2026-09-06, from the Jasmin interoperability
  phase: SMPP 3.4 5.3.2.32 makes the TLV the alternative for a body the mandatory field cannot
  carry, several SMSCs use it, and Jasmin relays one faithfully — reading `short_message` alone
  handed the application an empty message
  ([interop-tests/findings/03-jasmin.md](interop-tests/findings/03-jasmin.md)). `messageOctets()` is
  the single answer to where a body is, so the message path, the reassembler and `dlrFromPdu()`
  cannot disagree about it, and `esm_class` still says whether that body starts with a UDH wherever
  it was carried, which leaves concatenation reading exactly as before. Filling both contradicts the
  spec's own instruction to leave `sm_length` zero, and taking the mandatory field there keeps the
  rule purely additive: no PDU that parsed before reads differently now. Rejected: preferring the
  TLV, which re-reads every message a peer echoes into both. Rejected: refusing a PDU carrying both,
  which discards a message that is almost certainly present twice over, where goal 3 keeps the
  traffic. The reassembler's octet cap already counts TLV values, so a 64 KB payload is bounded like
  any other segment.

- **A segment's concatenation is read from its UDH, or from the `sar_*` TLVs where it declares none,
  and each spelling groups in a reference space of its own.** Maintainer's call, 2026-09-06, from
  the Jasmin and Java-client interoperability phases: SMPP 3.4 5.3.2.31-5.3.2.33 make
  `sar_msg_ref_num`/`sar_total_segments`/`sar_segment_seqnum` the other way to say what a UDH says,
  Jasmin documents it as its own segmentation and jsmpp writes it, and reading the UDH alone handed
  the application one `sms` per fragment
  ([interop-tests/findings/05-java-clients.md](interop-tests/findings/05-java-clients.md)).
  `concatOf()` is the single answer to how a PDU says it is a segment, as `messageOctets()` is to
  where a body is, and both are exported for the same reason: an application on the low-level
  surfaces would otherwise rewrite the read this fixed. It carries the spelling beside the
  reference, so the key is two tokens the reassembler joins and interprets neither of, and so the
  refusal can name the field the peer got wrong — `ESME_RINVESMCLASS` for a UDH, `ESME_RINVTLVVAL`
  for the TLVs, whose segment's `esm_class` is 0x00 and correct. Keying them together instead would
  assemble two of a peer's messages into one, since a UDH reference is 8 bits and `sar_msg_ref_num`
  is 16 and neither counts the other's messages; the two UDH widths share a space because they are
  one sender's counter in one layer, where a `sar_*` reference is another layer's. A UDH that names
  the concatenation wins over the TLVs — one carrying only a port leaves them to say — which keeps
  the change additive for every message that reassembled before, and leaves the library nothing to
  guess where the two disagree. Rejected: preferring the TLVs, which regroups every message a
  gateway derived them from. Rejected: comparing the parts and reporting a disagreement: the
  references are not comparable at all, and where the parts are, the UDH is still what the message
  is assembled by, so the report would name a failure the application cannot act on. Accepted: a
  peer that switches spelling mid-message now has two groups that expire rather than fragments that
  arrive, which goal 2 prefers to a message assembled from two counters. Receive-only: `sendSms()`
  goes on writing a UDH with an 8-bit reference, where a send-side `sar_*` would be a second
  spelling of one message whose only difference is which peers accept it.

- **`sendSms()` takes the messaging mode by name, and it is the only part of `esm_class` a caller
  writes.** Maintainer's call, 2026-09-06, closing target 5 of the interoperability plan: every peer
  the suite ran took the 0x40 this library sends on a concatenated segment, but Route Mobile and
  Kaleyra both document `esm_class` 0x43 for one, and a caller facing either had to hand-build every
  segment through `send()` — giving up the split, the per-segment ids, the send window and the
  receipt merge, which is what goal 6 means by beating "the application can do this itself". The four
  modes of SMPP 3.4 5.2.12 are a `MESSAGING_MODE` constant group and the option takes one of their
  names, so 0x43 is a composition this library makes rather than a value a caller states, and the UDH
  indicator a segment carrying a header needs cannot be cleared by anything the option can express.
  Those three names moved out of `ESM_CLASS`, where they were a second spelling of the same bits that
  had `constsById.ESM_CLASS` read 0x03 as a whole `esm_class`. Rejected: a raw `esmClass` number,
  which is exactly that clearable state and would need refusing bit by bit to be safe. Rejected:
  taking a number beside a name, two spellings of one goal — which is why a value naming no mode is
  refused, by name, before a segment goes out. Rejected: a session-level default with a per-send
  override; an operator's requirement is a property of the link, but the library can verify nothing
  the caller's own options object does not, and shipping both buys a precedence rule to document and
  test for that. `SMSC_DEFAULT` is named so pinning the default deliberately is sayable, and
  `test/messaging-mode.test.ts` holds it and the absent option to the same octets.
  Untouched: the message-type bits `sendDlr()` writes, which have a decision of their own here.

- **An inbound `data_sm` stands in for whichever of `submit_sm` and `deliver_sm` its direction makes
  it, and none goes out.** Maintainer's call, 2026-09-06, from the Jasmin interoperability phase:
  SMPP 3.4 4.7.1 makes it a peer of both that always carries its body in `message_payload`, and
  Jasmin's `[dlr-thrower] dlr_pdu = data_sm` throws real receipts on it, which `ESME_RINVCMDID`
  dropped with nothing reported to the application at all. Every command but this one names its own
  direction, which is why the bind gate and the dispatch never had to be told which end of the link
  they are on; `linkEnd` is that fact, and it decides both. At the ESME end an inbound one is a
  delivery, so `esm_class` classifies it as it classifies a `deliver_sm`; at the SMSC end it is a
  submission and is read as one, because a report about a message this end never sent is goal 2's
  wrong answer whatever `esm_class` a peer wrote on it. A concatenated one is answered segment by
  segment either way, and 4.7.2 gives `data_sm_resp` a `message_id` where 4.6.2 leaves
  `deliver_sm_resp`'s unused, so the answer carries one. `linkEnd` is a field beside `boundAs`
  rather than a `SessionOptions` entry, so the code that knows which end this is writes it and
  nothing else can contradict what the session then binds as. Rejected: grouping the command with
  `deliver_sm` in the gate, which refuses a transmitter-bound ESME's legitimate submission, and with
  `submit_sm`, which refuses the receiver-bound delivery this was fixed for. Rejected: sending one —
  `send()` reaches the command raw, and an option choosing which command a message goes out on would
  be a second spelling of `sendSms()` whose only difference is which peers accept it.

- **A receipt's body is read as octets, and its own `data_coding` never says how.** Maintainer's
  call, 2026-09-05 via the SMPPSim interop run: SMPPSim copies the reported message's `data_coding`
  onto a receipt whose body it always writes as plain text, and Melrose Labs documents the same
  echo, so decoding by that field turns an Appendix B receipt into UCS-2 garbage — total loss
  against the many peers that send no TLVs to fall back on. `dlrFromPdu()` reads
  `PduObject.shortMessageOctets` through Latin-1, the one codec that maps every octet to a
  character, so the fixed fields parse whatever the PDU claims; the codec keeps both spellings
  because a message needs the text and a receipt needs the octets. Rejected: honouring `data_coding`
  where the octets yield no field, which reads one body two ways for the sake of a peer writing a
  UCS-2 receipt body that no researched SMSC is — that peer's receipt yields no fields at all here,
  which goal 2 reports as undetermined rather than guessed. An inbound message is untouched: nothing
  but `data_coding` can say how a message was written.

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

- **The optional parameters run to `command_length` exactly, and the only slack tolerated is one
  NULL octet where a peer padded `short_message`.** Maintainer's call, 2026-09-06, from the
  Java-client interoperability phase: accepting any parse that merely did not error answered
  `ESME_ROK` to a `deliver_sm` whose three trailing octets were never read, dropping the
  `receipted_message_id` that makes a receipt a receipt
  ([interop-tests/findings/05-java-clients.md](interop-tests/findings/05-java-clients.md)). Goal 2
  settles it against goal 3: octets this codec cannot name are a PDU it did not read, so a region
  that does not end on `command_length` — the padded read included — is refused with the `tlvs`
  reason and `ESME_RINVTLVSTREAM` a truncated TLV value already gets. What the rule costs is paid
  once, in `readCstring()`: a trailing C-Octet String a peer left out entirely consumes no octet,
  where reporting the terminator it never sent puts every later offset past the declared end and
  refuses a bind, and every bodyless response, that used to parse. That composes, so a run of them
  at the tail all read empty — `outbind` is the only command with two, and an absent field and an
  empty one say the same thing, so goal 2 is not at stake even there. Rejected: keeping the tolerance
  for the one to three trailing octets too few to hold a TLV header, which no researched peer sends
  and which cannot be told apart from the truncated tail this fixes. Rejected: refusing it as
  `body`/`ESME_RINVCMDLEN`, which names the mandatory fields — the part the peer got right.

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

- **`reconnect: { fromStart: true }` puts the first connect and bind through that same loop, and
  `client()` then resolves only once it is bound.** Maintainer's call, 2026-09-05: an application
  started before its SMSC is up otherwise writes that retry itself, around the one this library
  already owns. A field on `reconnect` rather than an option of its own, so the combination that
  would contradict `false` cannot be written at all — `false` carries no fields — and a top-level
  `fromStart` is refused by name rather than ignored. Nothing but the caller's `signal` ends the
  wait: a bound of its own would be a second spelling of a deadline the caller already writes with
  that signal, and giving up after one is what the default does. A bind the SMSC refuses is
  retried like any other failure — rejected: giving up on `ESME_RINVPASWD` and `ESME_RBINDFAIL`,
  which would have the initial attempts and a rebind disagree about what a refused bind means, and
  gives up on the operator whose provisioning lands a minute later; the backoff is what bounds the
  rate goal 4 cares about. The attempts before the first link report nothing, because the session
  running one has not reached the application: `disconnected` would have no listener and `close`
  would be a lie. Its wait is the one retry timer that is not `unref()`'d, for the reason
  `LinkGate`'s hold is not — it is awaited with no other handle, so a process whose only work is
  `client()` would exit unbound.

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

- **Every segment of a concatenated message is answered as it arrives, so `sendResp()` on one is the
  application's own signal rather than the peer's answer.** Maintainer's call, 2026-09-06, from the
  Jasmin interoperability phase: Jasmin dispatches one `submit_sm` per connector at a time and will
  not send segment 2 until segment 1 is answered, so holding a group unanswered until it was whole
  deadlocked every multi-segment message against a production gateway
  ([interop-tests/findings/03-jasmin.md](interop-tests/findings/03-jasmin.md)). Goal 1 has the answer
  a real SMSC gives — one `message_id` per `submit_sm`, immediately — so the group's id base is
  generated when it opens and each segment is answered `<base>-<n>`, the notation `sms-id.ts` owns
  and `DlrMerger` reads back. The id is therefore fixed by the first segment, which is why an `smsId`
  or a refusing `status` passed to `sendResp()` on such a message is an error rather than a silent
  no-op. `answeredOnArrival` is on `Sms` because nothing the application can compute says it, and the
  discriminant a reader would reach for instead is wrong. A message `sendResp()` still answers itself is
  untouched, and is where a caller-chosen id and a refusal live; `onRequest` is the escape hatch for
  an application that must refuse a PDU the `sms` event could not have shown it yet. `collect()`
  answers every segment it will not carry rather than leaving it unanswered, which is the same stall
  in miniature: the field that numbered it where the segment belongs to no group, `ESME_RMSGQFUL`
  where the segment's own arrival overran the octet cap, since a peer told that still holds it. Rejected:
  answering every segment but the one that completes the group, which leaves the peer holding some
  segments accepted and one refused with nothing in SMPP to retract the rest, and still cannot honour
  a caller's `smsId` on the segments already gone. Rejected: a hook that mints the id per segment,
  which asks the application to name a message it cannot read yet — what it wants is `sms.smsId`
  afterwards. Rejected: an option to keep the old behaviour, a second spelling whose only
  distinguishing feature is that it deadlocks. Accepted: a group given up on — expired, evicted, or
  dropped with the link — is traffic the peer will not send again, so each one reaches `sessionError`
  as well as the log. Rejected there: an exported `MessageLostError` carrying the group, on the
  `PduRefusedError` pattern — no `sms` ever fired for that group, so there is nothing in it the
  application could act on, and goal 6 does not buy a second exported class to make a count
  distinguishable. Accepted: a completing segment whose own answer the socket would not carry still
  reaches the application, because the message is whole and correct and the failed answer is on
  `sessionError` — a peer that re-sends after the drop is the smaller risk than dropping a message
  in hand. The answer goes out before the `sms` event either way, so a listener's own receipt can
  never precede the acceptance of the message it reports on.

- **`server()` composes the application's `onRequest` after its own bind handling, and offers it
  every request that handling did not answer.** Maintainer's call, 2026-09-06, from a product review
  of the multipart change: `server()` filled the session's only `onRequest` slot, so the escape hatch
  the error above names was reachable only by hand-wiring a `Session` over a raw socket, giving up
  bind acceptance, `authenticate`, the session set and the drain `close()` runs over it — which is
  what goal 6 means by beating "the application can do this itself". What the library verifies is the
  ordering rather than the hook's honesty about answering: the hook is consulted only for a non-bind
  request on a session already bound, so no bind — a second one on a live session included — and
  nothing a peer sends before one can be intercepted however the hook is written. One
  `OnRequest` type on both option bags, because a second contract under one name is two spellings of
  one goal; widened to accept a plain boolean, as `authenticate` already is, so an observing hook need
  not be `async`. Nothing of ours is written for a request whose hook failed, the same on both
  surfaces: the library cannot tell one that failed before answering from one that failed after, so
  goal 2 reports the outcome as undetermined rather than guessing, and the peer's own
  `responseTimeout` is what settles it — the answer `authenticate` failing already takes. A hook that
  throws or rejects reaches `sessionError` on the way; one that never settles reaches nothing at all,
  and is visible only as the request that was never answered. That takes the keepalive with it, since
  a hook broken across the board leaves `enquire_link` unanswered and the peer drops the link — the
  back-pressure wanted, because an application that cannot serve a link should not hold one.
  `sessionError` rather than `serverError` because the
  failure belongs to one session's request, and that channel already carries every failure of one.
  The hook is consulted before the bind-direction gate, so it sees a `submit_sm` a receiver-bound
  peer may not send; first refusal means first, and one it declines still gets `ESME_RINVBNDSTS`.
  Nothing is held for a request the hook answered: `HeldMessages` is opened by the `sms` event the
  hook skipped, so the drain waits on none of it. `OnRequest` stays unexported where
  `AuthenticateInput` is exported, because that hook's argument is a shape this library invents and
  this one's are two types already published. Rejected: consulting the hook first, which puts
  bind and authentication inside the application's reach for nothing. Rejected: a narrower hook
  returning a status for the library to write, which makes the answer verifiable but pays a second
  contract under a second name for it, and could not express what the session-level hook already
  does — answer a bind, a vendor command, a `data_sm` — leaving that error naming something only
  half the surface can do. Rejected: falling the request through to the built-in handling on a
  failure, which reads as the answer the peer would have had with no hook — true only of a hook
  that failed before answering, where one that failed after put a second response on the peer's own
  sequence number, goal 1's wire violation. Rejected with it: recording what the hook wrote so the
  fall-through could be gated on it, which buys a fail-open path with state and an internal contract
  no other collaborator needs.

- **The drain waits on the messages the application holds, and `sendResp()` is what says it is done
  with one.** Maintainer's call, 2026-09-01: waiting on the send window alone tore a server session
  down while the application was still answering a `submit_sm`, so the peer timed out and re-sent —
  the duplicate goal 2 forbids, in the direction the window already covers. No completion signal was
  added to the `sms` event: `sendResp()` is what an application already calls when it is done with a
  message, so it is the one the drain waits for. Counting every inbound request until `sendReturn()` answered it was rejected —
  an `onRequest` that deliberately answers nothing would then cost a full `shutdownTimeout` on every
  close — and a message no listener took is released at once, since nothing is going to answer it.
  A listener that failed before answering gives it up the same way, but only once every listener has:
  a throw stops `emit()` where it stands, while a rejection leaves the others running, so the release
  waits for the last of them rather than answering on their behalf. What ends the wait is the response
  reaching the wire, not the call — a `sendResp()` the library refused, or one the socket would not
  carry, leaves the message held, so `close()` still reports the one the peer is owed. Where the
  segments were answered as they arrived there is no response left to write, so the call itself ends
  the wait, an argument the library refuses excepted. `teardown()`
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
  `onDelivery()` answers each receipt before the group it belongs to is complete, and `teardown()`
  runs on every path — an idle timeout and a failed rebind, not only `close()` — so clearing the
  merges there loses receipts no peer has a reason to send again. They are cleared where the session
  is over instead. Inbound segments stay in `teardown()`: a concatenation reference is the
  peer's own counter, so a half-arrived group kept across a drop would take a later message's
  segments as readily as the rest of its own, and goal 2 will not hand the application a message
  assembled that way. What goes there is traffic already answered, which is why each group reaches
  `sessionError` like every other one given up on.

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

- **A send queued for a send-window slot is bounded by the caller's `signal`, and by nothing else.**
  Maintainer's call, 2026-09-06, from a review of PR #71: the hold above observes the signal and the
  `acquire()` on the next line did not, so a caller that aborted while the window was full waited for
  a slot it no longer wanted — at `responseTimeout: 0` for as long as the peer stayed quiet, which is
  the deadline the README sends the caller to that signal for. Goal 4 is not re-opened by an
  unbounded wait here: the queue is the application's own backlog, unbounded in depth as well as in
  time because capping it would refuse a send the application asked for, and nothing in it keeps the
  peer waiting — which is what separates it from the inbound stores capped on constants. Rejected:
  having `release()` skip a waiter whose signal already fired, which leaves the departed waiter in
  the queue where `unfinished()` still counts it and the drain waits on it; the waiter leaves as it
  settles instead. Rejected: bounding this wait by `responseTimeout` as the hold is bounded — a full
  window is this end's own concurrency draining as the peer answers rather than a link going nowhere,
  and that bound would fail a message with more segments than `maxOutstanding` partway through
  against a slow peer. The failure is a plain `Error` rather than `UnansweredError`, the same answer
  an abort at the gate already gives. The drain half needs nothing: `close({ signal })` already hands the signal to
  `window.idle()`, and `unbind()` taking none is the shape README states.

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

- **The four-line abort dance is copied across `LinkGate`, `IdleWaiters`, `PendingRequests` and
  `SendWindow` rather than extracted.** Architecture review, 2026-09-06: pre-check `aborted`, attach
  `{ once: true }`, detach on settle, leave the registry. What differs at each site is the registry
  and what settling means — a FIFO handing over a slot, a set released together, a map keyed by
  sequence number, a count recomputed at settle — so a shared `Waiters<T>` fits two of the four and
  is a shallower module than the copies. Extract it once a fifth appears.

- **`SmppLog` is a five-method contract this library declares, not a dependency.** `debug`, `error`,
  `info`, `verbose` and `warn` are what the code actually calls, so an application can satisfy it
  with an object literal. `@larvit/log` implements it structurally and stays a devDependency, where
  `test/tls.test.ts` passing a real `Log` as the server's logger keeps that compatibility compiled.

- **The TLS tests build their own self-signed certificate in DER** (`test/tls.test.ts`) instead of
  adding a devDependency or shelling out to openssl. Maintainer's call, 2026-08-26: the dev image
  `node:24.18.0-bookworm-slim` ships no openssl binary, so a shelled-out fixture would pass in CI and
  fail on every developer machine, and a committed key leaks in a public repository. Valid while the
  dev image has no openssl.

- **`src/` stays flat until a module has to move for another reason.** Architecture review,
  2026-09-06: the grouping the file map above already implies — `wire/` for `pdu*` and `defs`,
  `link/` for `link-*`, `reconnect-*`, `pdu-transport` and `send-window`, `messages/` for `sms*`,
  `dlr*`, `message*`, `reassembly` and `udh` — rewrites every import for no change to
  `dist/index.js`, the one published entry. Valid while that map is what a reader navigates by.
