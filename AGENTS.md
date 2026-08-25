# AGENTS.md

Guidance for LLM agents working in this repository. Human-facing documentation lives in
[README.md](README.md); the remaining work is tracked in [todo.md](todo.md).

## What this is

A ground-up TypeScript rewrite of `larvitsmpp` 0.4.0, published as `@larvit/smpp` 1.0.0. The branch
started from an orphan commit — no history from 0.4.0 is carried over. The 0.4.0 source is still
readable on the `master` branch of the same repository and is the reference for protocol behaviour,
not for structure or style.

The library's value is its very small API. Do not grow the public surface without being asked.

## Hard rules

These are not preferences. Breaking one is a defect.

1. **Nothing throws.** Every fallible function returns (or resolves to) a DTO carrying an optional
   `err`. No `throw`, no rejected promises, no exceptions as control flow. Node APIs that throw are
   wrapped at the boundary and converted into a result. Programmer errors (bad arguments) are
   results too.
2. **Log messages are static strings.** Every dynamic value goes into `@larvit/log` metadata. Never
   interpolate, never concatenate.
   - GOOD: `log.debug('sendSms() - splitting message', { parts: msgs.length, to });`
   - BANNED: `log.debug('sendSms() - splitting into ' + msgs.length + ' parts');`
3. **No `error` event.** Node makes an unhandled `error` event throw, which would break rule 1.
   Sessions emit `sessionError`, servers emit `serverError`.
4. **No casts, no non-null assertions.** `as`, `as unknown as` and `!` are all banned. Parse untyped
   input once through a type guard at the boundary; everything past it is typed.

## Architecture

```
src/
	index.ts          Public surface. Named exports only, no default export.
	client.ts         client() -> { err, session }
	server.ts         server() -> { err, server }, server owns the listener + close()
	session.ts        Session: framing, sequence numbers, the send window, events
	sms.ts            The live handle emitted as the 'sms' event (sendResp/sendDlr)
	message.ts        Encoding detection, splitting, bit counting, SMPP date formatting
	pdu.ts            pduToObj / objToPdu / pduReturn — synchronous, result-returning
	defs/
		commands.ts   The 33 commands, their ids and ordered parameter lists
		constants.ts  consts + constsById (TON, NPI, ENCODING, MESSAGE_STATE, …)
		encodings.ts  GSM 03.38, LATIN1, UCS2 and detection
		errors.ts     errors + errorsById (ESME_*)
		filters.ts    Per-field encode/decode hooks (time, message, callback_num, …)
		tlvs.ts       TLV definitions, tlvsById
		types.ts      Wire types: int8/int16/int32/string/cstring/buffer/arrays
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

Confirmed by reading the 0.4.0 source. The rewrite fixes all of them; each needs a regression test
naming the behaviour, and the wire-affecting ones are cross-checked against a reference
implementation (see todo.md).

| Defect | 0.4.0 behaviour |
| --- | --- |
| LATIN1 never decodes | `decodeMsg` loops `consts.ENCODING` without breaking, so `data_coding` 0x03 lands on the alias `ISO_8859_1`, which has no decoder, and silently falls back to ASCII |
| Oversized segments | `splitMsg` emits 152 GSM chars + 6-byte UDH = 158 octets, over the 140-octet limit; UCS2 gets 66 chars where 67 fit |
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

## Conventions

- Hard tabs. Alphabetical ordering for keys, imports and lists unless order is logic-significant
  (see the wire-order note above).
- Comments are the exception, not the default — see the root `CLAUDE.md` rules. Do not write file
  preambles or restate what the code says.
- Test data uses real randomised UUID v7 values, never `aaaa-0000` placeholders.
- `message_id` values the library generates are UUID v7.
