# todo.md

Remaining work for the `@larvit/smpp` 1.0.0 rewrite. Read [AGENTS.md](AGENTS.md) first — the goals
and hard rules there constrain every item below.

This is a temporary working file: it is deleted when 1.0.0 ships, and until then it sets its own
rules. The documentation conventions in AGENTS.md do not govern it, and nothing here is a source
anything else may cite.

## Status

The rewrite is **feature complete and green**: the suite, lint and typecheck are clean on Node 18,
20, 22 and 24. What is left is release work and a few things worth adding before or after 1.0.0.

## The agreed API

Settled with the maintainer before implementation. Do not change any of it without asking. The
public surface is documented in [README.md](README.md); this is the short form.

```ts
import { client, server } from '@larvit/smpp';

const { err, session } = await client({ host, password, port, username });
const { err: sendErr, pduObjs, smsIds } = await session.sendSms({ dlr, from, message, to });
await session.unbind();

const { err: serverErr, server: smpp } = await server({ authenticate, port });
smpp.on('session', session => {
	session.on('sms', async sms => {
		await sms.sendResp();
		if (sms.dlr) await sms.sendDlr('DELIVERED');
	});
});
await smpp.close();
```

Rules the API follows:

- **Never throws.** Everything fallible resolves to `{ err?, … }`. See AGENTS.md rule 1.
- **Named exports only**, no default export. `defs` is exported as a group alongside the individual
  tables.
- **The PDU codec is synchronous** and returns `{ err?, pduObj? }` / `{ err?, buffer? }`.
- **Low-level surface stays public**, including `session.sock`, `session.send()` and
  `session.sendReturn()`.

## Done

| | Covered by |
| --- | --- |
| Definition tables: constants, errors, encodings, wire types, TLVs, commands | `test/encodings.test.ts`, `test/types.test.ts`, `test/commands.test.ts` |
| Message helpers: splitting, bit counting, SMPP dates and times | `test/message.test.ts` |
| PDU codec: parse, build, respond, per-command typing, bounds checks | `test/pdu.test.ts` |
| Stream framing | `test/pdu-framer.test.ts` |
| Delivery receipt parsing, TLV and text | `test/dlr.test.ts` |
| Session, client, server: bind, auth, send, reassembly, DLRs, timeouts, abort, send window | `test/session.test.ts` |
| Merged multipart DLRs including across a reconnect, reassembly bounds, per-send abort, the segment cap | `test/session-extras.test.ts` |
| `smsIdFormat`: a peer's `submit_sm_resp` and receipt ids read into one notation before they are compared | `test/dlr.test.ts`, `test/session-extras.test.ts` |
| A draining `close()` and `unbind()`, bounded by `shutdownTimeout` or an abort | `test/session-extras.test.ts` |
| A drain that also waits out the messages the application has not answered, with `sendDlr()` the one send that passes it | `test/session-extras.test.ts` |
| `OutgoingRequests`: the gate, the window, the pending map and the retry under one owner, told when a link comes up or goes down | `test/session-extras.test.ts`, `test/session.test.ts` |
| Held messages capped and expiring, so an application that answers nothing cannot grow them | `test/session-extras.test.ts` |
| A send with no link held for the next one, and one the link dropped under counted as `unanswered` | `test/session-extras.test.ts` |
| Every runnable README example | `test/readme.test.ts` |
| Receipt-versus-message classification by `esm_class` | `test/dlr.test.ts`, `test/session.test.ts` |
| A listener that throws, or rejects, reaching `sessionError`/`serverError` rather than the process | `test/session.test.ts`, `test/error-from.test.ts` |
| Cross-checked against node-smpp both ways and over a live session | `test/interop.test.ts` |
| CI on Node 18/20/22/24, Renovate, tag-triggered publish | `.github/workflows/` |

Every defect listed in the AGENTS.md table has a regression test naming the behaviour.

## The GitHub backlog, once this branch is `master`

Nothing below is closed while `master` is still 0.4.0 — declining a security bump on a live default
branch is worse than leaving it open. Work through this immediately after the merge.

**Close as fixed by 1.0.0**, naming the replacement in the comment:

| | Fixed by |
| --- | --- |
| [#4](https://github.com/larvit/larvitsmpp/issues/4) DLR errors with `message_state` missing | `dlrFromPdu()` parses the `stat:` receipt text when the TLVs are absent |
| [#33](https://github.com/larvit/larvitsmpp/issues/33) Large inbound text arrives as raw `Buffer` segments | `IncomingRequests` reassembles a UDH-carrying `deliver_sm` into one `sms` event |
| [#3](https://github.com/larvit/larvitsmpp/issues/3) Tests for flash messages | `test/session.test.ts` |
| [#20](https://github.com/larvit/larvitsmpp/issues/20) Tests fail on current dependency versions | The mocha suite is gone; `node:test` on Node 18/20/22/24 |
| [#2](https://github.com/larvit/larvitsmpp/issues/2) Tests for the README examples | `test/readme.test.ts` |
| [#17](https://github.com/larvit/larvitsmpp/issues/17) `addr_ton`/`addr_npi` should be settable | `sendSms()` takes all four, documented and tested |
| [#16](https://github.com/larvit/larvitsmpp/issues/16) Support all three bind types | Bound and enforced in both directions |
| [#13](https://github.com/larvit/larvitsmpp/issues/13) Limit a long SMS to fewer segments | The `maxSegments` send option |
| [#68](https://github.com/larvit/larvitsmpp/pull/68) `message_id` in `submit_sm_resp`, spec DLR codes | All four hold: `sendResp()` always answers a `message_id`, per segment; `stat:UNDELIV` is the 7-character code. Credit the reporter — the fork found real defects. |

**Close as superseded**, all against 0.4.0 dependencies the rewrite does not have — `async`,
`coveralls`, `eslint`, `iconv-lite`, `larvitutils`, `mocha`, `mocha-eslint`, `portfinder`, `uuid`:
[#40](https://github.com/larvit/larvitsmpp/pull/40), [#41](https://github.com/larvit/larvitsmpp/pull/41),
[#42](https://github.com/larvit/larvitsmpp/pull/42), [#45](https://github.com/larvit/larvitsmpp/pull/45),
[#46](https://github.com/larvit/larvitsmpp/pull/46), [#47](https://github.com/larvit/larvitsmpp/pull/47),
[#59](https://github.com/larvit/larvitsmpp/pull/59), [#63](https://github.com/larvit/larvitsmpp/pull/63),
[#64](https://github.com/larvit/larvitsmpp/pull/64), [#65](https://github.com/larvit/larvitsmpp/pull/65),
[#67](https://github.com/larvit/larvitsmpp/pull/67), [#70](https://github.com/larvit/larvitsmpp/pull/70).
[#70](https://github.com/larvit/larvitsmpp/pull/70) is the open `uuid` advisory GitHub reports on the
default branch; it disappears with the runtime dependencies rather than being fixed.

[#60](https://github.com/larvit/larvitsmpp/issues/60) is Renovate's dashboard — leave it, it
re-baselines itself against the new `package.json`.

**Leave open:** [#8](https://github.com/larvit/larvitsmpp/issues/8), the socket's remote host and
port on log messages. Only `server - incoming connection` carries them today; putting them on every
session message is a change to every call site.

## Before publishing 1.0.0

- [ ] Create the `@larvit/smpp` package on npm and add `NPM_TOKEN` to the repository secrets, which
      `.github/workflows/release.yaml` needs.
- [ ] Tag `v1.0.0` to publish.
- [ ] `npm deprecate larvitsmpp` pointing at `@larvit/smpp`. Maintainer's call to run it; not
      something CI should do.
- [ ] Decide what happens to `master`: this branch is an orphan, so merging it is a deliberate act.

## Worth doing, not blocking

- [ ] **Merge state does not survive a process restart.** A drop no longer discards it, but a restart
      loses every incomplete group, and a peer has no reason to resend a receipt it already had
      answered. Surviving one means exposing the merge state for the application to persist and hand
      back, which is a public-surface decision.
- [ ] **Group the session's collaborators under `src/session/`.** `session.ts` imports
      `dlr-merger`, `incoming-requests`, `link-timers`, `outgoing-requests`, `pdu-transport`,
      `reconnect-loop` and `send-sms`, and nothing else does, so the directory would make that
      boundary visible. The `OutgoingRequests` extraction this was to be done with landed on
      2026-09-01, so it is the remaining half. Raised by review, 2026-09-01.

- [ ] **`leftOf()` and the link gate's own budget are one concept counted twice.**
      `idle-waiters.ts` reads what is left of a budget as `Math.max(1, deadline - now)`, because 0
      means "forever" there; `link-gate.ts` runs the same subtraction and calls `<= 0` expired.
      Neither is reachable from the other, so nothing can disagree today, but a reader who learns one
      and applies it to the other is wrong. A budget type both take would close it. Raised by review,
      2026-09-01.

- [ ] **An `sms` listener that rejects before answering costs a whole `shutdownTimeout`.**
      One that *throws* is fine: `emit()` catches it, returns false, and `emitSms()` releases the
      hold. A rejecting `async` one reaches `sessionError` through `captureRejections`, which hands
      the handler an `unknown[]` the `Sms` cannot be read out of without a cast, so nothing releases
      until the message expires. Same cost as the `onRequest`-answers-nothing case that was declined,
      but reached by a bug rather than a policy. Raised by review, 2026-09-01.

- [ ] **A message the reconnect dropped is answered into the void, and reported as delivered.**
      `teardown()` clears the held messages along with the inbound segments, which is right — but the
      application still holds the `Sms`, so `sendResp()` writes the old link's sequence numbers to the
      new socket, succeeds, and returns `{}` for a response that correlates with nothing at the peer.
      `HeldMessages` now knows exactly which messages went that way, so saying so is a small
      addition. Goal 2, low frequency. Raised by review, 2026-09-01.
- [ ] **Does an intermediate delivery notification deserve to be a `dlr`?** `esm_class` message type
      `INTERMEDIATE_DELIVERY` (0x20) is classified as a message today, so a peer that reports
      non-final states with it hands the application a raw `id:… stat:ENROUTE` text as an inbound
      SMS. Kannel treats 0x04, 0x08 and 0x20 alike as report-bearing. Against it: a non-final report
      would take a segment's slot in `DlrMerger` and complete the group early. Raised by review,
      2026-08-27; needs a decision.

- [ ] **`once()` is copied into four test files, and two copies never give up.**
      `session-extras.test.ts` and `readme.test.ts` reject after 5000 ms; `session.test.ts` and
      `tls.test.ts` wait forever, so an event that never fires still hangs the run the way an
      unclosed listener used to. One shared, guarded copy closes the rest of that class.

- [ ] **A peer whose message ids share one base logs a refused merge on every send.** `smsc01-000123`
      and `smsc01-000124` carry the same base, so `DlrMerger` merges the first message and refuses
      every one after it, one log line per send. Left at `info` — nothing the operator can fix is
      wrong — but a rate guard or silence may suit it better. Raised by review, 2026-08-30.

- [ ] **`submit_multi` and the broadcast commands** encode and decode, but nothing exercises them
      end to end. The interop suite is the natural place.
- [ ] **Move to TypeScript 7** once `typescript-eslint` supports it; `renovate.json` pins TypeScript
      below 6.1 for exactly that reason.
- [ ] **Coverage reporting.** `node --test --experimental-test-coverage` works today; nothing
      publishes the numbers.

- [ ] **An `onReceipt` hook.** Receipt text is only loosely specified and operators disagree on it,
      but `dlrFromPdu()` is wired into `IncomingRequests` with no seam of its own: an application
      facing a format we do not parse has to take the whole PDU on `onRequest` and reimplement the
      dispatch, which owns the response as well.
      Mirror the `onRequest` seam — return a `Dlr` to own the receipt, `undefined` to fall through
      to the built-in parser.

## Declined

- **Throughput throttling — a TPS cap, and backing off on `ESME_RTHROTTLED`.** Declined by AGENTS.md
  goal 7: an operator's rate limit is scoped to the account, while the widest thing this library owns
  is a session, so a bucket here cannot see a second process binding the same account and is wrong in
  exactly the case it exists for. `sendSms()` surfaces `ESME_RTHROTTLED` to the caller instead, and
  `maxOutstanding` stays — a window slot frees on the peer's next response, which is self-limiting in
  a way a rate ceiling is not.
