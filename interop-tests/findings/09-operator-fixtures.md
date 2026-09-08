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

Three things in topic 5 could not be taken at face value, and are recorded rather than guessed at:

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
- **The Telesign fixture's body and TLV deliberately disagree**, where its own page says the status
  is given redundantly in both. The disagreement is forced rather than sourced: `message_state` 9 is
  Telesign's `SKIPPED`, and Appendix B has no seven-character code for it, so the body carries
  `stat:UNKNOWN` — which is what this library itself writes for that state (`receiptCodes.SKIPPED`).
  The fixture is there for the TLV-wins rule over a state only a vendor names; nothing in it should
  be read as a claim about what Telesign puts in the two fields together.

Two further items in topic 5 are not receipt-body shapes at all and are out of this phase:
Syniverse's and Route Mobile's numeric status tables are vendor fields of their own rather than the
seven characters `stat:` holds, and LINK Mobility's `registered_delivery=0x21` is a submit field.

## Scenarios (PLAN.md)

| Id | Result | Evidence |
| --- | --- | --- |
| C16 LINK Mobility: `sub:000`, `dlvrd:000`, empty `text:`, finals only | pass | `operator-receipts.test.ts` "LINK Mobility, whose sub and dlvrd are always 000…" — `receipt.sub`/`receipt.dlvrd` read 0 and nothing is derived from them, `receipt.text` is `''`; "reads none of LINK Mobility's as anything but final" |
| C16 Vonage: `stat:FAILED` outside Appendix B, eight-value set, `err:` off `DELIVRD`/`ACCEPTD` only | fail, then fixed | "Vonage, whose stat:FAILED is six characters and outside Appendix B" and "names a state of its own for every one of them" — both failed against `83176f5`; see Defects |
| C16 Vonage: one receipt per segment | pass | "reports every segment and merges nothing" — three `dlr` events under the SMSC's own three unrelated ids, no `messageDlr` |
| C16 tyntec: a buffered receipt then a final one for one id | pass | "hands both receipts to the application rather than taking the second for a duplicate" — two `dlr` events, `intermediate` `[true, false]`, one `smsId` |
| C16 Infobip: `stat:ENROUTE` marked `esm_class` 0x04 | pass | "Infobip, reporting ENROUTE in an ordinary receipt that carries no text field at all" — `intermediate` true off the state where the marker says final, and `receipt.text` stays `undefined` |
| C16 Clickatell: the exact documented body | pass | "Clickatell, whose dates carry seconds" — every field of the documented order, 12-octet dates |
| C16 Telesign: hex `err:`, `message_state` 9, one id per concatenated send | pass | "Telesign, whose err is hexadecimal and whose message_state 9 the body has no code for"; "hands back what landed where only the first segment is answered with one" |
| C16 CM.com: a body with neither `sub:` nor `dlvrd:` | pass | "CM.com, which writes neither sub nor dlvrd and states the same status twice" — absent fields stay `undefined`, and the `message_state` TLV agrees with `stat:` |
| C16 a receipt with no `id:` at all | pass | "settles a status against no message where a marked receipt names no id" — marked, `smsId` is undefined and the status still settles; unmarked, the same body arrives as an `sms`. "takes the id from the TLV where the body names none" covers the third case |
| C16 fields in another order | pass | "reads the same fields whatever order they arrive in"; "reads the rest of the line as the text where a peer does not write text last" |
| C16 hex `message_id` against a decimal `id:` | pass | "correlates the receipt against the send once both notations are named" and "leaves the two incomparable where neither notation is named" |
| C16 a zero-padded id | pass | "strips the padding an operator writes the same number with" |
| C16 dates with and without seconds | pass | The LINK Mobility and Infobip fixtures carry 10-octet dates, Clickatell and Telesign 12-octet ones; every one asserts the `Date` it resolves to |
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

- Whether Telesign's `err:` is really three hex characters or eight. Both readings reach the
  application unchanged, so nothing in this library turns on it, but a real Telesign link would
  settle it in one receipt.
- What `stat:` tyntec's buffered receipt actually carries. The library reads any of `ENROUTE`,
  `SCHEDULED` or `esm_class` 0x20 as non-final, so all three plausible answers behave correctly; a
  fourth, vendor-invented token would read as `UNKNOWN` and final.
- Whether any operator writes a `stat:` outside Appendix B other than `FAILED`. The
  documented-codes table in `operator-receipts.test.ts` is the place a new one goes, and it fails
  loudly for anything nothing names.
