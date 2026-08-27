# todo.md

Remaining work for the `@larvit/smpp` 1.0.0 rewrite. Read [AGENTS.md](AGENTS.md) first — the hard
rules there constrain every item below.

## Status

The rewrite is **feature complete and green**: 230 tests, lint and typecheck clean, verified on Node
18, 20, 22 and 24. What is left is release work and a few things worth adding before or after 1.0.0.

```bash
docker compose run --rm node npm install
docker compose run --rm node npm test
```

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
| Merged multipart DLRs, reconnect, reassembly bounds, per-send abort, the segment cap | `test/session-extras.test.ts` |
| Every runnable README example | `test/readme.test.ts` |
| Receipt-versus-message classification by `esm_class` | `test/dlr.test.ts`, `test/session.test.ts` |
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

- [ ] **An `async` event listener that rejects escapes the guard.** `Session.emit()` wraps
      `super.emit()` in try/catch, which catches a listener that throws synchronously but not one
      that returns a rejected promise — that surfaces as an unhandled rejection and takes the
      process down, which hard rule 1 says must not happen. Every README example uses
      `session.on('sms', async sms => …)`, so the shape is the one applications will write. The
      library's own calls inside such a listener never reject, so the examples themselves are safe.
      Fixing it means dispatching `rawListeners()` by hand in `emit()` and routing a rejection to
      `sessionError` — a change to the hottest path, so it needs a decision before 1.0.0.

- [ ] **In-flight sends across a reconnect.** They currently fail with "Session closed before a
      response arrived" and the caller retries. Re-queueing them automatically would be friendlier
      but risks duplicate delivery, so it needs a decision before it is built.
- [ ] **A drop discards delivery receipts already acknowledged to the peer.** `teardown()` calls
      `dlrMerger.clear()`, and it runs on every path — an idle timeout and a failed rebind, not only
      `close()`. `onDeliverSm()` answers each receipt with `sendReturn()` before the merge completes,
      so a peer that has sent two of three segment receipts will never resend them and `messageDlr`
      can never fire for that message. `dlrMergeTimeout` budgets a day for the last receipt to
      arrive, while the state does not survive a thirty-second link drop. Reassembly is not affected
      the same way: inbound segments go unanswered until the message is whole, so the peer keeps
      them. Clearing is right when `close()` ends the session for good and wrong on the reconnect
      path; separating the two is most of the fix. Surviving a process restart as well means
      exposing the merge state for the application to persist and hand back, which is a
      public-surface decision.
- [ ] **`close()` and `unbind()` drop in-flight requests instead of draining them.** `teardown()`
      settles every pending request with "Session closed before a response arrived" and destroys the
      socket in the same tick, so a submit the SMSC has already accepted is reported to the caller
      as a failure — the ambiguous outcome that produces a duplicate on retry. Give both a drain:
      refuse new sends, wait out the pending responses up to a `shutdownTimeout`, then tear down
      whatever is left. Distinct from re-queueing across a reconnect above — this is the deliberate
      shutdown path, where there is nothing to come back to.
- [ ] **`session.ts` is 386 lines.** The one seam left in it is a socket-to-PDU transport, which
      would move the deliberately public `sock` field out of `Session` or turn it into a getter —
      a public-surface change, so it waits for a decision.
- [ ] **Group the session's collaborators under `src/session/`.** Only `session.ts` imports
      `reassembly`, `dlr-merger`, `send-window`, `link-timers`, `reconnect-loop`, `pending-requests`
      and `send-sms`, so the directory would make that boundary visible. Do it on the next
      extraction out of `session.ts`, not as a move of its own.
- [ ] **Nothing owns the `esm_class` bits.** Three modules read them with their own literals:
      `pdu.ts` decides decode-or-not, `incoming-requests.ts` reassemble-or-not and `dlr.ts`
      receipt-or-not. That divergence is what let a UDH-carrying receipt reach `dlrFromPdu()` as an
      undecoded buffer. Two predicates next to the constants would collapse it without touching
      `index.ts`.

- [ ] **`submit_multi` and the broadcast commands** encode and decode, but nothing exercises them
      end to end. The interop suite is the natural place.
- [ ] **Move to TypeScript 7** once `typescript-eslint` supports it; `renovate.json` pins TypeScript
      below 6.1 for exactly that reason.
- [ ] **Coverage reporting.** `node --test --experimental-test-coverage` works today; nothing
      publishes the numbers.

- [ ] **Normalise the message id on both sides of a receipt.** An SMSC that answers `submit_sm_resp`
      with a hex `message_id` and sends the receipt's `id:` in decimal — or pads it, or flips its
      case — leaves `smsIds` and `dlr.smsId` unequal, so correlation silently yields nothing and the
      application sees no receipts at all. A `dlrIdFormat` option (`'hex' | 'decimal' | 'raw'`, or a
      function) applied to both ids before they are compared covers the whole class. The smallest
      change on this list for the most real-world breakage removed.

- [ ] **An `onReceipt` hook.** Receipt text is only loosely specified and operators disagree on it,
      but `dlrFromPdu()` is wired into `IncomingRequests` with no seam of its own: an application
      facing a format we do not parse has to take the whole PDU on `onRequest` and reimplement the
      dispatch, which owns the response as well.
      Mirror the `onRequest` seam — return a `Dlr` to own the receipt, `undefined` to fall through
      to the built-in parser.

- [ ] **Turn `reconnect` on by default in `client()`.** Surviving a dropped link is most of why the
      session layer exists, and it is opt-in behind an empty object today, so an application that
      does not read the options table gets none of it. A default change, so it needs a decision.

## Declined

- **Throughput throttling — a TPS cap, and backing off on `ESME_RTHROTTLED`.** Two reasons, either
  sufficient. An operator's rate limit is scoped to the account, while the widest thing this library
  owns is a session: a bucket here cannot see a second process binding the same account, so it is
  wrong in exactly the case it exists for. And a rate limiter's queue drains at a fixed ceiling
  rather than at the peer's response rate, so a submit rate sustained above the limit grows it
  without bound — and a queue holding messages the caller was told were accepted loses them on
  restart, which is worse than refusing them up front. Pacing an account needs durable shared state
  this library deliberately has none of. `sendSms()` surfaces `ESME_RTHROTTLED` to the caller
  instead, and `maxOutstanding` stays: a window slot frees on the peer's next response, which is
  self-limiting in a way a rate ceiling is not.
