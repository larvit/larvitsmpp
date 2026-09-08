# 09 operator receipt fixtures

Date: 2026-09-08. Repo commit at the start of the phase: `83176f5`. Host: Alpine 6.18.38-0-virt
kernel. Images: `node:24.18.0-bookworm-slim` (test runner, from the root `compose.yaml`) — and
nothing else. No peer runs in this phase and no capture is taken.

## Setup

This phase has no peer to bring up, so `run.py` is not involved. The eight peers the suite can run
are all open source, and none of them writes the receipt bodies commercial operators document —
that whole class of behaviour is what
[research/operator-quirks.md](../research/operator-quirks.md) topics 4 and 5 collected, one source
URL per claim, and what this phase turns into fixtures in `test/`.

Everything here runs under the ordinary suite:

```bash
docker compose run --rm node npm test
```

New file: `test/operator-receipts.test.ts` — a table of receipt bodies as each operator's own
documentation spells them, checked through `dlrFromPdu()`, plus four scenarios driven over a live
link against a dummy SMSC that answers each `submit_sm` with the message id the fixture names. Each
fixture carries the URL it was read from as its assertion message, so a failure names the page that
settles it. That dummy SMSC is `test/dummy-smsc.ts`, extracted from the copy `messaging-mode.test.ts`
already carried rather than written a second time. `test/session-extras.test.ts` gained C8's 16-bit
UDH and `test/session.test.ts` the `DlrMerger` fact the Telesign scenario turned up.

## What the research settles, and what it does not

Several things in topic 5 could not be taken at face value, and are recorded rather than guessed at:

- **Telesign's `err` width contradicts itself.** The page calls it "a 3-octet hex code" and then
  gives 8-hex-digit examples (`0x000004A6`), which is four octets
  (https://developer.telesign.com/enterprise/docs/smpp-protocol). smpp.org fixes the receipt field
  at 3 octets. The fixture takes the 3-octet width and the hex notation (`err:4A6`) and asserts the
  value reaches `dlr.errorCode` verbatim — this library never parses `err:`, so either reading
  arrives intact at the application, which is the only claim the sourced material supports.
- **tyntec does not document the `stat:` its buffered receipt carries**, only that a buffered one
  precedes the final one. The fixture uses `stat:ENROUTE` under `esm_class` 0x04 — Appendix B's own
  spelling for a message still on its way, and the shape Infobip documents explicitly — rather than
  inventing a vendor token.
- **Telesign's `message_parts_count` TLV has no published tag id** in either sourced page, so no
  fixture names one. The behaviour it accompanies (only the first segment answered with a
  `message_id`) is covered without it.
- **Telesign's `message_state` 9 is not a receipt body shape**, so it is not in the operator table.
  Appendix B has no seven-character code for `SKIPPED`, so a fixture pairing the two would have had
  Telesign's body and TLV contradict each other where its own page says the status is stated
  redundantly in both. The TLV rule is asserted where it belongs instead — `dlr.test.ts` "names a
  state only the TLV can spell" — and the Telesign fixture states one status in both fields, as
  documented. The research file of 2026-09-05 is the source for 9 = `SKIPPED`; the TLV page no
  longer shows that table.
- **Vonage's `stat:` set could not be re-fetched** during review (the support article answers 403).
  Kaleyra and Route Mobile both verify independently and both define `FAILED` as a terminal delivery
  failure, which is what the library change rests on; Vonage's own developer page documents a
  lower-case status set for its HTTP callbacks, which is a different surface from the seven-character
  `stat:` field. The fixture keeps the research's attribution, and `src/dlr.ts` cites the two that
  verify.
- **Clickatell's cited page no longer resolves** — `archive.clickatell.com/developers/api-docs/pdu-details/`
  now redirects to `docs.clickatell.com`. The body shape is quoted verbatim in the research file of
  2026-09-05, which is what the fixture was built from.

Two further items in topic 5 are not receipt-body shapes at all and are out of this phase:
Syniverse's and Route Mobile's numeric status tables are vendor fields of their own rather than the
seven characters `stat:` holds, and LINK Mobility's `registered_delivery=0x21` is a submit field.

## Scenarios (PLAN.md)

| Id | Result | Evidence |
| --- | --- | --- |
| C16 LINK Mobility: `sub:000`, `dlvrd:000`, empty `text:`, finals only | pass | `operator-receipts.test.ts` "LINK Mobility, whose sub and dlvrd are always 000…" — `receipt.sub`/`receipt.dlvrd` read 0 and nothing is derived from them, `receipt.text` is `''`; "finds none of LINK Mobility's among the transient ones" |
| C16 Vonage: `stat:FAILED` outside Appendix B, eight-value set, `err:` off `DELIVRD`/`ACCEPTD` only | fail, then fixed | "Vonage, whose stat:FAILED is six characters and outside Appendix B" and "names a state of its own for every one of them" — both failed against `83176f5`; see Defects |
| C16 Vonage: one receipt per segment | pass | "reports every segment and merges nothing" — three `dlr` events under the SMSC's own three unrelated ids, no `messageDlr` |
| C16 tyntec: a buffered receipt then a final one for one id | pass | "hands both receipts to the application rather than taking the second for a duplicate" — two `dlr` events, `intermediate` `[true, false]`, one `smsId` |
| C16 Infobip: `stat:ENROUTE` marked `esm_class` 0x04 | pass | "Infobip, reporting ENROUTE in an ordinary receipt that carries no text field at all" — `intermediate` true off the state where the marker says final, and `receipt.text` stays `undefined` |
| C16 Clickatell: the exact documented body | pass | "Clickatell, whose dates carry seconds" — every field of the documented order, 12-octet dates |
| C16 Telesign: hex `err:`, one id per concatenated send | pass | "Telesign, whose err is hexadecimal and whose status is stated in the body and the TLVs alike"; "hands the err field over as it arrived, whichever width the operator writes"; "hands back what landed where only the first segment is answered with one" |
| C16 CM.com: a four-digit year, an eight-character `stat:`, no `sub:` or `dlvrd:` | fail, then fixed | "CM.com, which writes a four-digit year, an eight-character stat, and the status twice" — absent fields stay `undefined` and the `message_state` TLV agrees with `stat:`, but both the documented `yyyyMMddHHmmss` date and the documented `stat:DELIVERD` failed against `83176f5`; see Defects |
| C16 a receipt with no `id:` at all | pass | "settles a status against no message where a marked receipt names no id" — marked, `smsId` is undefined and the status still settles; unmarked, the same body arrives as an `sms`. "takes the id from the TLV where the body names none" covers the third case |
| C16 fields in another order | pass | "reads the same fields whatever order they arrive in"; "reads the rest of the line as the text where a peer does not write text last" |
| C16 hex `message_id` against a decimal `id:` | pass | "correlates the receipt against the send once both notations are named" and "leaves the two incomparable where neither notation is named" |
| C16 a zero-padded id | pass | "strips the padding an operator writes the same number with" |
| C16 dates with and without seconds | pass | The LINK Mobility and Infobip fixtures carry 10-octet dates, Clickatell and Telesign 12-octet ones and CM.com a 14-octet one; every one asserts the `Date` it resolves to, and `dlr.test.ts` "reads a receipt date whichever of the three widths the peer writes it in" pins all three against each other |
| C8 UDH 16-bit | pass | `session-extras.test.ts` "names the spelling a segment was numbered by, alongside the reference" reads GSM 03.40 element 0x08, and "assembles a message numbered by a 16-bit UDH reference" carries two of them through the `Reassembler` into one whole text — the width was previously exercised only by the jsmpp peer run ([05-java-clients.md](05-java-clients.md)) |
| C9 MO or receipt on `data_sm` | pass, already covered | `dlr.test.ts` "reads a receipt the peer carried in message_payload, on deliver_sm and on data_sm"; `session-extras.test.ts` "reads a data_sm as the command its direction makes it" |
| C10 unknown command id, malformed and vendor TLVs | pass, already covered | `test/raw-pdus.ts` and the `session.test.ts` refusal suites |
| C15 `interfaceVersion` 0x50, a peer answering 3.3 or nothing | pass, already covered | `session.test.ts` bind-version suites around `sc_interface_version` |

## Defects in @larvit/smpp

### `stat:FAILED` read as `UNKNOWN`

**What happened.** A receipt body carrying `stat:FAILED` reached the application as
`statusMsg: 'UNKNOWN'`, `statusId: 7` — indistinguishable from a receipt that really says
`stat:UNKNOWN`.

**What the operators' docs say.** Vonage lists `FAILED` among the eight `stat` values it writes
(https://api.support.vonage.com/hc/en-us/articles/204015663), Kaleyra among its four
(https://messaging.kaleyra.com/support/solutions/articles/3000091798-delivery-reports), and Route
Mobile among its five (https://routemobile.com/pdf_files/developer/api/routemobilesmpp.pdf). In all
three it is a terminal delivery failure. SMPP 3.4 Appendix B does not define it, and it is six
characters where the field is seven.

**Reproducer.** `operator-receipts.test.ts`, the Vonage fixture and "names a state of its own for
every one of them" — the second walks every code all seven researched operators publish and fails
on any that reads as `UNKNOWN` without saying `UNKNOWN`.

**Severity.** Two ways it gives a wrong answer, both goal 2: an application cannot tell an
operator's "it failed" from its "I do not know", and `DlrMerger` ranks `UNKNOWN` (5) below `EXPIRED`
(6), so a multipart send with one failed segment and one expired one reported as expired.

**Fixed** in this phase: one entry added to `receiptStates` in `src/dlr.ts`. `receiptCodes` is
untouched, so this library still only ever writes `UNDELIV`. Decision recorded in the root
`AGENTS.md` under "The wire".

### CM.com's own `stat:` spelling read as `UNKNOWN`

**What happened.** A receipt spelled the way CM.com's code table prints it reached the application as
`statusMsg: 'UNKNOWN'`. Unmarked, it arrived as an inbound `sms` rather than as a report at all.

**What the operator's docs say.** The "Message state values" table at
https://developers.cm.com/messaging/docs/smpp gives the code column as `DELIVERD` — eight
characters — beside `EXPIRED`, `DELETED`, `UNDELIV`, `ACCEPTD`, `UNKNOWN` and `REJECTD`, which are
all correct Appendix B codes. The page prints `DELIVERD` four times and `DELIVRD` not once, verified
by fetching it.

**Reproducer.** `operator-receipts.test.ts` "names a state of its own for every one of them", whose
CM.com row now carries the published spelling, and the CM.com fixture.

**Severity.** The same class as the `stat:FAILED` defect above, on the most common status there is: an
application could not tell a delivered message from one whose state the library could not read.

**Fixed** in this phase: one entry in `receiptStates`. Whether CM.com's table is a typo or its wire
spelling, reading it costs nothing — no other code could be meant, and `receiptCodes` still writes
only `DELIVRD`. This supersedes the research file's CM.com line, which records the code as `DELIVRD`
and asks for an assertion that every `stat:` is exactly seven characters: written today, that
assertion fails against the page it cites.

### A receipt date carrying its century dropped

**What happened.** `dlr.doneDate` and every other parsed date came back `undefined` for a receipt
whose dates are 14 digits, while `dlr.receipt.doneDate` still carried the raw string — so the loss
was silent.

**What the operator's docs say.** CM.com gives its receipt body template as
`id:… submit date:yyyyMMddHHmmss done date:yyyyMMddHHmmss stat:SSSSSSS err:EEE`, with "Formatted:
yyyyMMddHHmmss" spelled out (https://developers.cm.com/messaging/docs/smpp). `receiptDate()` read 10
and 12 digits only — smpp.org's `YYMMDDhhmm` and the same with seconds.

**Reproducer.** `dlr.test.ts` "reads a receipt date whichever of the three widths the peer writes it
in", and the CM.com row of the operator table.

**Severity.** Goal 3: a date the receipt states plainly is one the library can determine, and
dropping it leaves the application to re-parse `dlr.receipt.doneDate` itself. The three widths are
10, 12 and 14, so none can be read as another and nothing is guessed.

**Fixed** in this phase: `receiptDate()` in `src/dlr.ts` takes a four-digit year as the year, where a
two-digit one still means this century, and the rolled-over check now covers the year as well —
`Date.UTC` reads 26 as 1926.

## Peer quirks

Not peer behaviour this time — operator behaviour, from documentation rather than from a run. What
the fixtures pin that a reader would not otherwise expect:

- **`sub:` and `dlvrd:` say nothing.** LINK Mobility hardcodes both to `000` on every receipt,
  delivered ones included, and CM.com omits them entirely. Nothing in this library derives anything
  from either, which is what makes both readable.
- **`text:` can only end where the line does**, because it is the one field allowed to hold spaces.
  Every researched operator writes it last, and one that did not would have the rest of its line
  read as the text. The other seven fields are order-independent.
- **A receipt's `esm_class` and its `stat:` can disagree about finality.** Infobip writes
  `stat:ENROUTE` under 0x04, the marker for a final receipt; the state wins, which is why the
  library tests both.
- **An operator that hands out an unrelated id per segment gets no `messageDlr`.** Vonage sends one
  receipt per segment under ids that carry no `<base>-<n>` numbering, so nothing merges them. An
  application wanting one report per message compares each `dlr.smsId` against the `smsIds` array
  `sendSms()` returned and merges them itself.
- **Telesign answers only the first segment of a concatenated submit with a `message_id`.**
  `sendSms()` returns `['<id>', '', '']` — one entry per segment, positional with `pduObjs`, empty
  where the SMSC named nothing. `dlr.smsId` is never empty, so an empty entry matches no receipt,
  and no merge is armed.

## Open questions

- **Whether LINK Mobility really writes a space after the colon.** Its guide prints the extended
  format as `id: xxx sub:000 dlvrd:000 submit date: yyMMddHHmm ... stat: <status> err: <error code>
  text:` — spaced before every placeholder and unspaced before both literal `000`s, which reads as a
  typographic convention for placeholders rather than as the wire shape. The fixture takes the
  unspaced form every other operator documents. It matters because the parser reads a field as
  ending at the first space, so a genuinely spaced receipt yields every field empty, and an unmarked
  one would arrive as an inbound message. Tolerating a space cannot simply be added: `sub: stat:UNDELIV`
  would then read `stat:UNDELIV` as the value of `sub`, which is the same ambiguity the other way
  round. A single receipt off a real LINK link settles it; until then the shape is not guessed at.
- Whether Telesign's `err:` is really three hex characters or eight. Both readings reach the
  application unchanged — "hands the err field over as it arrived, whichever width the operator
  writes" pins that — so nothing in this library turns on it, but a real Telesign link would settle
  it in one receipt.
- What `stat:` tyntec's buffered receipt actually carries. The library reads any of `ENROUTE`,
  `SCHEDULED` or `esm_class` 0x20 as non-final, so all three plausible answers behave correctly; a
  fourth, vendor-invented token would read as `UNKNOWN` and final.
- Whether any operator writes a `stat:` outside Appendix B beyond the two this phase found,
  `FAILED` and CM.com's `DELIVERD`. The documented-codes table in `operator-receipts.test.ts` is
  the place a new one goes, and it fails loudly for anything nothing names.
- Whether `smsIds` carrying an empty entry for a segment the SMSC took but named no id for is the
  right shape for a caller, or whether that case wants saying differently. It is documented in
  `README.md` and pinned by the Telesign scenario; the question is a product one, not a correctness
  one, and belongs to the phase 11 product-owner pass.
