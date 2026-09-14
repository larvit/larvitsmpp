# todo.md

Remaining work for `@larvit/smpp`. Read [AGENTS.md](AGENTS.md) first — the goals and hard rules
there constrain every item below.

This is a working file that sets its own rules. The documentation conventions in AGENTS.md do not
govern it, and nothing here is a source anything else may cite.

## Status

The rewrite is **feature complete and green**: the suite, lint and typecheck are clean on Node 18
to 26, and 0.5.0 is on npm. What is left is housekeeping around the release, a few things worth
adding, and the gaps a comparison with other SMPP libraries found.

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
| A message whose link dropped refused an answer, with its receipt still allowed out | `test/session-extras.test.ts` |
| The hold released exactly when the peer was answered: a refused `sendResp()` keeps it, a listener that rejected drops it | `test/session-extras.test.ts` |
| Every runnable README example | `test/readme.test.ts` |
| Receipt-versus-message classification by `esm_class` | `test/dlr.test.ts`, `test/session.test.ts` |
| An intermediate delivery notification read as a report marked `intermediate`, as is a receipt reporting `ENROUTE` or `SCHEDULED`, and never counted into a merge | `test/dlr.test.ts`, `test/session.test.ts`, `test/session-extras.test.ts` |
| A transient state sent under the marker the spec gives it, off the same list the reader uses | `test/session-extras.test.ts` |
| A listener that throws, or rejects, reaching `sessionError`/`serverError` rather than the process | `test/session.test.ts`, `test/error-from.test.ts` |
| Cross-checked against node-smpp both ways and over a live session | `test/interop.test.ts` |
| CI on Node 18 to 26, Renovate, tag-triggered publish | `.gitea/workflows/` |

Every defect listed in the AGENTS.md table has a regression test naming the behaviour.

## Move the repository to Gitea

`gitea.larvit.se/larvit/smpp-js` is the repository. `github.com/larvit/smpp-js` becomes a push mirror
of it and the place issues are filed. Maintainer's calls, 2026-09-13 and 2026-09-14.

- [x] `larvit/smpp-js` holds `main`, from `typescript`, and `v0.4.0`, from `master`. `rewrite-base`
      and the `renovate/*` branches stayed behind.
- [x] Fast-forward is the only merge style. `main` takes no pushes, requires `Test / lint
      (pull_request)` and `Test / test (*) (pull_request)`, blocks an outdated branch, and gives
      admins no override. Every other branch takes force pushes.
- [x] The workflows are in `.gitea/workflows/`. Tests run on pull requests only, the event the gate
      reads; Renovate runs as a scheduled workflow, as on adf-codec.
- [x] The release publishes without provenance, which npm generates only on GitHub Actions and
      GitLab CI/CD.
- [x] `package.json` names Gitea, and the GitHub mirror's issues as `bugs`. The README links
      absolutely: npmjs.com resolves a relative link against itself when the `repository` is not on
      GitHub. Its test badge is gone, since Gitea reports a workflow's status per branch and no
      workflow runs on `main`.
- `RENOVATE_GITHUB_TOKEN` exists nowhere, so Renovate queries github.com unauthenticated, as
  adf-codec's nightly run already does without a warning. `RENOVATE_TOKEN` is the Gitea token and
  cannot stand in for it. Add a github.com token only if lookups hit the rate limit.

## Before publishing 0.5.0

- [x] 0.5.0 rather than 1.0.0, while usage is this low. Maintainer's call, 2026-09-14.
- [x] `NPM_TOKEN`, which `.gitea/workflows/release.yaml` needs, is a Gitea organization secret.
- [x] Tag `v0.5.0` on Gitea to publish. The first publish creates `@larvit/smpp` on npm, provided the
      token can publish under `@larvit`.
- [ ] `npm deprecate larvitsmpp` pointing at `@larvit/smpp`. Maintainer's call to run it; not
      something CI should do.

## Retire the GitHub repository

Nothing here starts before 0.5.0 is published. Maintainer's call, 2026-09-14. Then in this order:
the push mirror replaces GitHub's branches with Gitea's, which closes every pull request based on
`master` without a reply, and GitHub refuses to delete the default branch it syncs over.

- [ ] Close the backlog below.
- [ ] Close [#71](https://github.com/larvit/larvitsmpp/pull/71), pointing at Gitea.
- [ ] Rename `larvit/larvitsmpp` to `larvit/smpp-js`. GitHub redirects the old URLs, and the `bugs`
      URL in `package.json` resolves from then on.
- [ ] Push `main` and make it GitHub's default branch.
- [ ] Remove Renovate and CodeRabbit from the GitHub repository.
- [ ] Add it to Gitea as a push mirror, with a GitHub credential that can write to it.

## Close the GitHub backlog

**Answer and close as fixed by 0.5.0**, the reply naming what fixed it:

- [ ] [#2](https://github.com/larvit/larvitsmpp/issues/2) Tests for the README examples:
      `test/readme.test.ts`.
- [ ] [#3](https://github.com/larvit/larvitsmpp/issues/3) Tests for flash messages:
      `test/session.test.ts`.
- [ ] [#4](https://github.com/larvit/larvitsmpp/issues/4) DLR errors with `message_state` missing:
      `dlrFromPdu()` parses the `stat:` receipt text when the TLVs are absent.
- [ ] [#13](https://github.com/larvit/larvitsmpp/issues/13) Limit a long SMS to fewer segments: the
      `maxSegments` send option.
- [ ] [#16](https://github.com/larvit/larvitsmpp/issues/16) Support all three bind types: bound and
      enforced in both directions.
- [ ] [#17](https://github.com/larvit/larvitsmpp/issues/17) `addr_ton`/`addr_npi` should be
      settable: `sendSms()` takes all four, documented and tested.
- [ ] [#20](https://github.com/larvit/larvitsmpp/issues/20) Tests fail on current dependency
      versions: the mocha suite is gone; `node:test` on Node 18 to 26.
- [ ] [#33](https://github.com/larvit/larvitsmpp/issues/33) Large inbound text arrives as raw
      `Buffer` segments: `IncomingRequests` reassembles a UDH-carrying `deliver_sm` into one `sms`
      event.
- [ ] [#68](https://github.com/larvit/larvitsmpp/pull/68), a pull request: `message_id` in
      `submit_sm_resp`, spec DLR codes. All four hold: `sendResp()` always answers a `message_id`,
      per segment; `stat:UNDELIV` is the 7-character code. Credit the reporter — the fork found real
      defects.

**Close as superseded**, all against 0.4.0 dependencies the rewrite does not have — `async`,
`coveralls`, `eslint`, `iconv-lite`, `larvitutils`, `mocha`, `mocha-eslint`, `portfinder`, `uuid`:

- [ ] [#40](https://github.com/larvit/larvitsmpp/pull/40),
      [#41](https://github.com/larvit/larvitsmpp/pull/41),
      [#42](https://github.com/larvit/larvitsmpp/pull/42),
      [#45](https://github.com/larvit/larvitsmpp/pull/45),
      [#46](https://github.com/larvit/larvitsmpp/pull/46),
      [#47](https://github.com/larvit/larvitsmpp/pull/47),
      [#59](https://github.com/larvit/larvitsmpp/pull/59),
      [#63](https://github.com/larvit/larvitsmpp/pull/63),
      [#64](https://github.com/larvit/larvitsmpp/pull/64),
      [#67](https://github.com/larvit/larvitsmpp/pull/67),
      [#70](https://github.com/larvit/larvitsmpp/pull/70),
      [#77](https://github.com/larvit/larvitsmpp/pull/77).
      [#70](https://github.com/larvit/larvitsmpp/pull/70) is the open `uuid` advisory GitHub reports
      on the default branch; it disappears with the runtime dependencies rather than being fixed.

[#60](https://github.com/larvit/larvitsmpp/issues/60) is Renovate's dashboard and stays open after
the rewrite, for a dependency added later. Maintainer's call, 2026-09-14.

**Close as tracked here**, the reply saying it will be implemented on Gitea:

- [ ] [#8](https://github.com/larvit/larvitsmpp/issues/8) The socket's remote host and port on log
      messages: under Worth doing, not blocking. Maintainer's call, 2026-09-14.

## Worth doing, not blocking

- [ ] **A send the codec will refuse waits for a link and a window slot first.** `refuse()` in
      `outgoing-requests.ts` runs `misuse()` and the abort check before the wait, precisely so a call
      that can never go out does not queue for what it will never use; a body `objToPdu()` refuses on
      every attempt is the same case, and #98 made it a common one. On a down link the caller waits
      `responseTimeout` and is told the link failed rather than that the body could not be built —
      goal 2's wrong answer about what happened. The cheap fix builds the PDU twice, so the shape is
      the open half. Raised by the architecture review of
      [#98](https://github.com/larvit/larvitsmpp/pull/98), 2026-09-09.

- [ ] **`message.ts` answers two questions.** Message coding and the SMPP time format (`smppDate`,
      `smppTime`) share the file, which the architecture map in AGENTS.md already spells out as four
      concerns. Nothing is wrong today; if the file has to move for another reason, `smpp-time.ts` is
      the split. Raised by the architecture review of
      [#98](https://github.com/larvit/larvitsmpp/pull/98), 2026-09-09.

- [ ] **A gate that refuses a floating version anywhere in the repo.** Maintainer's ask on
      [#71](https://github.com/larvit/larvitsmpp/pull/71), 2026-09-06, on the `release.yaml`
      pinning thread. Pinning every action and runner by hand is what the ask followed; the gate is
      what keeps them pinned. It has to cover workflow `uses:` and `runs-on:`, compose `image:`, and
      Dockerfile `FROM`, and the conventions differ per kind — actions take a semver tag, images the
      full patch version — so one grep for `latest` is not it.

- [ ] **A gate that fails when the test matrix misses the current Node.** Maintainer's ask on
      [#71](https://github.com/larvit/larvitsmpp/pull/71), 2026-09-06, on the Node 26 thread. Node
      26 was added by hand; nothing notices when 27 ships. Needs a source for what Current is — the
      Node release schedule is published as JSON — and a decision on whether a new Current fails the
      build or opens a PR, which is what Renovate already does for everything else here.

- [ ] **CodeRabbit reviews through the GitHub mirror.** CodeRabbit does not support Gitea, so mirror
      each Gitea pull request to GitHub for it to review there. Maintainer's ask, 2026-09-14; not
      started until asked.

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

- [ ] **`err:` on a receipt for a state that neither delivered nor failed.** `receiptText()` now
      writes `err:000` for `DELIVERED` and for the two transient states, and `err:001` for every
      other — so `ACCEPTED`, `SKIPPED`, `UNKNOWN` and `DELETED` still announce an error code the SMSC
      never had. Which of those are failures is the open half. Raised by review, 2026-09-03; needs a
      decision.

- [ ] **`once()` is copied into four test files, and two copies never give up.**
      `session-extras.test.ts` and `readme.test.ts` reject after 5000 ms; `session.test.ts` and
      `tls.test.ts` wait forever, so an event that never fires still hangs the run the way an
      unclosed listener used to. One shared, guarded copy closes the rest of that class.

- [ ] **The peer's address and bind on every session log message.** `remoteAddress` and `remotePort`
      reach only `server - incoming connection`, and `systemId` only the bind messages, so with
      several peers connected one session's lines cannot be told apart, and a reconnect leaves nothing
      stable to filter on. Carrying them in every session message's metadata is a change to every
      call site. From [#8](https://github.com/larvit/larvitsmpp/issues/8), closed there as tracked
      here; maintainer's call, 2026-09-14.

- [ ] **A peer whose message ids share one base logs a refused merge on every send.** `smsc01-000123`
      and `smsc01-000124` carry the same base, so `DlrMerger` merges the first message and refuses
      every one after it, one log line per send. Left at `info` — nothing the operator can fix is
      wrong — but a rate guard or silence may suit it better. Raised by review, 2026-08-30.

- [ ] **`submit_multi` and the broadcast commands** encode and decode, but nothing exercises them
      end to end. The interop suite is the natural place.
- [ ] **Move to TypeScript 7** once `typescript-eslint` supports it; `renovate.json` pins TypeScript
      below 6.1 for exactly that reason.
- [ ] **An `onReceipt` hook.** Receipt text is only loosely specified and operators disagree on it,
      but `dlrFromPdu()` is wired into `IncomingRequests` with no seam of its own: an application
      facing a format we do not parse has to take the whole PDU on `onRequest` and reimplement the
      dispatch, which owns the response as well.
      Mirror the `onRequest` seam — return a `Dlr` to own the receipt, `undefined` to fall through
      to the built-in parser.

## Gaps against other SMPP libraries

From comparing 0.5.0 with `smpp`, `@semyonf/smpp`, `@leissner/node-red-smpp`, `node-smpp-next`,
`smpp-js-sdk`, `smppjs`, cloudhopper-smpp, jsmpp, go-smpp, Kannel, Jasmin and php-smpp, 2026-09-14.
Each lands under AGENTS.md goal 6: an option or a hook, with the call that passes none unchanged.

### Sending

- [ ] **A limiter hook, with a messages-per-second cap built on it.** Maintainer's call, 2026-09-14,
      reversing the earlier decline: Kannel, Jasmin, go-smpp and `smpp-js-sdk` all limit throughput.
      Count PDUs, not `sendSms()` calls — a long message is one `submit_sm` per segment and the
      operator counts those, which an application wrapping `sendSms()` cannot see. The hook takes a
      limiter the application already runs; the built-in cap counts per session until the store at the
      bottom lets it span sessions and processes. The default stays uncapped. Open: the hook's shape (a
      wait that resolves when a PDU may go, cut short by the send's `signal`), which requests it gates
      — messages, never `enquire_link`, `unbind` or a response — and whether its wait counts against
      `responseTimeout`.

- [ ] **Back off and resend on `ESME_RTHROTTLED`.** The SMSC refused the PDU, so resending cannot
      duplicate it and goal 2 holds, and the retry needs nothing wider than the session. Needs a
      decision: on by default with a bounded budget, as goal 5 suggests, and whether `ESME_RMSGQFUL`
      counts too. A throttled answer is also what a limiter hook wants to hear about.

- [ ] **`sendSms()` takes the rest of `submit_sm`.** `service_type`, `priority_flag`, `protocol_id`,
      `replace_if_present_flag` and TLVs on every segment, and `registered_delivery` beyond final
      receipts: on failure only, and intermediate notifications. Today each needs `send()`, which gives
      up splitting, the alphabet checks and receipt merging. TLVs are the common case: India's DLT
      rules put `PE_ID` (0x1400) and `TEMPLATE_ID` (0x1401) on every `submit_sm`, and USSD rides on
      `ussd_service_op`. Refuse a TLV the send composes itself (`sar_*`, `message_payload`). Open: one
      spelling for receipts, since `dlr: true` and a raw `registered_delivery` could disagree, and
      whether goal 4's rule on optional parameters binds a TLV the caller named.

- [ ] **Choose how a long message is spelled on the wire.** Only an 8-bit UDH reference goes out
      (`message.ts`), though the reader takes a 16-bit UDH, `sar_*` and `message_payload` alike. Some
      SMSCs take only `sar_*` or `message_payload`; php-smpp offers all three. A 16-bit reference also
      makes a collision rarer: the 8-bit one wraps every 255 sends on a session.

- [ ] **Failover across SMSC hosts.** Maintainer's call, 2026-09-14. `client()` takes one `host` and
      `port`; Kannel, Jasmin and php-smpp take several. A list the reconnect loop walks holds only
      which host the one session is on, so it needs no store. Two options, both maintainer's calls:
      - **Order**, `fixed` or round robin, default `fixed`. Fixed starts every reconnect at the first
        host; round robin at the host after the one the link was last on.
      - **Starting over**, a boolean, default on: once the last host has been tried, go back to the
        first. Off ends the session once the last host fails, as a drop does under `reconnect: false`.
      Open: how the list and today's `host` and `port` share one spelling; whether the backoff grows
      per host or per pass; and whether round robin with starting over off still tries the hosts
      before the one it started at.

### The server

- [ ] **`sendSms()` on a `server()` session sends `submit_sm` toward the ESME.** Kannel answers
      `ESME_RINVCMDID` (`interop-tests/kannel.test.ts`, "MO to Kannel"), and goal 1 says that PDU never
      goes out. A server has no other way to send an MO message either: `sendMo()` in that test builds
      one from `submitSmParams()` and `ConcatReference`, neither exported. Choosing `deliver_sm` by
      `linkEnd` gives MO messages the splitting and checks, keeps one method for one goal, and refuses
      the options 3.4 has `deliver_sm` leave empty (`scheduleDeliveryTime`, `validityPeriod`).

- [ ] **Error TLVs on a response this library builds.** `buildBody()` in `pdu.ts` writes no body for
      any non-zero status, so a server cannot answer a `data_sm` with `delivery_failure_reason`,
      `network_error_code` or `additional_status_info_text`, and a 5.0 peer gets none of its error TLVs.
      3.4 omits the body on error for `submit_sm_resp` by name; read each response's section before
      widening it. Reading needs nothing: an error response carrying a body already parses.

- [ ] **PROXY protocol on `server()`.** Behind HAProxy or an AWS NLB every session's remote address is
      the balancer's, so `authenticate` cannot allow-list by IP and logs name the wrong peer. v1 is
      text; v2 is binary and the only one an NLB sends. `smpp` accepts v1 from anyone; accept either
      only from addresses the option names.

- [ ] **`outbind`.** In the command table, handled nowhere: a client cannot take an SMSC's `outbind`
      and bind back, and `server()` cannot send one. Rare; take it on with a peer that uses it.

- [ ] **Register vendor-specific commands.** 3.4 reserves `command_id` `0x00010200`–`0x000102FF` for
      SMSC vendors; today one arrives as a `PduRefusedError`. `smpp` has `addCommand()`. The same
      shape question as registering an encoding.

### Encodings

- [ ] **Register a custom encoding.** Maintainer's ask, 2026-09-14. `EncodingName` is a closed union
      of three (`defs/encodings.ts`). An entry needs a name, a `data_coding`, `encode`, `decode`,
      `match`, whether `detect()` may pick it, and enough for `splitMessage()` to budget a segment
      without halving a character. Take encodings as a client or server option rather than mutating a
      module table as `smpp` does, so two sessions in one process cannot disagree about a name. A taken
      name is an `err`. Settle `consts.ENCODING`'s names first. An entry may claim a `data_coding` a
      built-in already uses, maintainer's call, 2026-09-14: an SMSC whose default alphabet, 0x00, is
      Latin-1 needs Latin-1 written and read under it
      ([#23](https://github.com/larvit/larvitsmpp/issues/23)). The entry then owns that coding on its
      session both ways: `encodingByDataCoding()` resolves to it, `detect()` tries it in the
      built-in's place, and naming the displaced built-in is an `err` naming the entry. Two entries
      on one coding are an `err`. Settle whether a claim on 0x00 reaches the class groups
      `messageClassEncoding()` reads GSM 7-bit from, which `flash` writes under.

- [ ] **The alphabets SMPP 3.4 names that no encoding carries.** `consts.ENCODING` lists the
      `data_coding` ids (5.2.19); only `ASCII`, `LATIN1` and `UCS2` can be sent. Those with a published
      definition, and what each costs:
      - 0x01 IA5 (ITU-T T.50, ASCII in practice): trivial.
      - 0x06 ISO-8859-5 (Cyrillic) and 0x07 ISO-8859-8 (Hebrew): 96-entry tables.
      - 0x05 JIS X 0208, 0x0D JIS X 0212, 0x0A ISO-2022-JP and 0x0E KS C 5601: two-octet sets.
        `TextDecoder` reads them through ICU — EUC-JP and EUC-KR once each octet's high bit is set,
        `iso-2022-jp` as is; checked for JIS X 0208 and KS C 5601 on Node 24.18.0. Nothing built in
        encodes them, so ship tables or build the reverse map on first use by decoding the 94×94 grid.
        A Node without full ICU throws from `new TextDecoder()`, which hard rule 1 wraps into an `err`.
      - 0x09 pictogram has no published definition; leave it out.

- [ ] **GSM 7-bit national language shift tables.** 3GPP TS 23.038 defines them for Turkish, Spanish
      (single shift only), Portuguese and ten Indian languages — Bengali, Gujarati, Hindi, Kannada,
      Malayalam, Oriya, Punjabi, Tamil, Telugu and Urdu — selected per message by UDH elements 0x25
      (locking) and 0x24 (single). They keep that text near GSM's segment size instead of UCS2's 67
      characters. Reading means honouring those elements in `decodeMessage()`; sending means `detect()`
      picking a table, with each element's 3 octets off the segment budget. `smpp` has Turkish, Spanish
      and Portuguese, used only when the caller writes the UDH.

- [ ] **Packed GSM 7-bit, opt-in.** Everything goes out unpacked, SMPP's convention (AGENTS.md, "GSM
      7-bit is sent unpacked"); go-smpp carries a packed codec for SMSCs that want septets. Find an SMSC
      that needs it before building it.

- [ ] **`consts.ENCODING` spells five alphabets twice.** `CYRILLIC`/`ISO_8859_5`,
      `HEBREW`/`ISO_8859_8`, `JIS`/`X_0208_1990`, `EXTENDED_KANJI_JIS`/`X_0212_1990` and
      `LATIN1`/`ISO_8859_1`; `FLASH` is a message class, not an alphabet. One name each before
      registration starts taking names. A breaking change to an export.

### Observability

- [ ] **Metrics.** Inbound traffic has `data`, `incomingPdu` and `incomingPduObj`; outbound has no
      event, and nothing counts requests in flight, queued for a window slot, waiting for a link, or
      unanswered. `smpp` and `@semyonf/smpp` emit `metrics`; cloudhopper keeps per-session counters. An
      `outgoingPdu`/`outgoingPduObj` pair mirrors the inbound events; the counters can be one read-only
      snapshot, read from the owner of each count rather than a second tally that can drift.

### Packaging, tests and CI

- [ ] **Ship `src`, so the source maps lead somewhere.** Maintainer's call, 2026-09-14. `sourceMap`
      and `declarationMap` write maps whose `sources` are `../src/*.ts`, but `files` publishes only
      `dist`, so 82 of the package's 167 files, 225 KB of its 555 KB unpacked, point at nothing. Adding
      `src` (41 files, 209 KB) makes go to definition land in the TypeScript, and lets a debugger or
      `--enable-source-maps` show it.

- [ ] **A coverage report and a floor in the gate.** `node --test --experimental-test-coverage
      --test-coverage-include='src/**' test/*.test.ts` on Node 24.18.0, 2026-09-14: 98.77% lines,
      93.85% branches, 98.28% functions. Gate at 98, 93 and 98 with `--test-coverage-lines`,
      `--test-coverage-branches` and `--test-coverage-functions`, which Node 22 and later take — a job
      of its own on 24, since the matrix runs compiled JavaScript — and add it to `main`'s required
      checks. Raise the floor as coverage rises; never lower it.

- [ ] **Mutation testing.** `@stryker-mutator/tap-runner` runs `node:test` suites and measures whether
      a test notices a change, which coverage cannot; `@semyonf/smpp` runs Stryker in CI. The session
      suites are timer-heavy, so start with the codec and the encodings.

- [ ] **A Node-RED node, as a package of its own.** `@leissner/node-red-smpp` is the only SMPP node in
      the Node-RED library, and by a read of its source it never parses a receipt and never answers the
      SMSC's `enquire_link`. Its UI is a fair list of what operators set. It builds on this package,
      never inside it.

## Declined

- **CommonJS.** ESM only, maintainer's call reaffirmed 2026-09-14, though `node-smpp-next` ships both.
  `require()` of an ES module works unflagged from Node 20.19 and 22.12.

## An optional store

- [ ] **Pooling, and state that survives a restart, through an optional store.** Maintainer's call,
      2026-09-14. It replaces two declines — merge state surviving a restart, and a pool of sessions —
      and AGENTS.md goal 8 was rewritten for it. Big: design before code.
      - **What it holds.** Receipts still awaited and the groups `DlrMerger` collects. Segments of a
        message already answered but not yet whole, which the peer will not send again (goal 2). The
        concatenation reference, so a restart does not reuse one. For a pool, the ids every session
        sent, since an SMSC may deliver a receipt on any bind of the account, and the
        messages-per-second budget the sessions share.
      - **What it cannot hold.** A response belongs to the link its request arrived on, so a message
        left unanswered at a restart stays unanswerable; the peer's own timeout settles it.
      - **Pooling.** Several sessions, in one process or many, behind one send: a message goes to a
        bound session with a free window slot, all its segments on that one. In one process the
        in-memory store is enough; across processes the application supplies one.
      - **The interface.** Narrow, with keys and records of the library's own making, versioned, with
        expiry: a record from an older version is read or refused, never misread, and `DlrMerger`'s
        group shape is never published (goal 7). What processes share needs an atomic operation —
        compare-and-set or increment — since get-then-set races.
      - **Adapters live elsewhere.** Redis, Postgres or SQLite stores are packages of their own; this
        one ships the interface and the in-memory store, and no runtime dependency (goal 9).
      - **When the store fails.** Open: a send whose awaited receipt cannot be recorded is refused, or
        sent and reported as undetermined (goal 2); a pool whose store is down stops, or falls back to
        memory. Either way, an application that supplied no store never waits on one.
      - **One spelling.** A store-backed cap and the limiter hook both reach a limit shared between
        processes; settle which owns that case before building the second.
