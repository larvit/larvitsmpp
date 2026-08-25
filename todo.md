# todo.md

Remaining work for the `@larvit/smpp` 1.0.0 rewrite. Read [AGENTS.md](AGENTS.md) first — the hard
rules there constrain every item below.

## How to resume

```bash
docker compose run --rm node npm install
docker compose run --rm node npm test
```

Work top to bottom. Each task states what "done" means. Tests come before implementation: write the
failing test for the behaviour, then implement until it passes. The 0.4.0 implementation is on the
`master` branch of this repository and is the reference for protocol behaviour — read it, do not
copy its structure.

## The agreed API

Settled with the maintainer before implementation started. Do not change any of it without asking;
it is the contract the tasks below implement.

```ts
import { client, server, consts, defs, errors, objToPdu, pduToObj } from '@larvit/smpp';

// --- client ---------------------------------------------------------------
const { err, session } = await client({
	addrNpi:             0,              // optional, bind field
	addrTon:             0,              // optional, bind field
	addressRange:        '',             // optional, bind field
	bindType:            'transceiver',  // 'transceiver' | 'transmitter' | 'receiver'
	enquireLinkInterval: 20000,
	host:                'localhost',
	interfaceVersion:    0x50,           // optional, bind field
	log,                                 // @larvit/log LogInt, silent by default
	maxOutstanding:      10,             // in-flight requests before sends queue
	password:            'pass',
	port:                2775,
	reconnect:           { maxDelay: 30000, minDelay: 1000 },  // optional, opt-in
	responseTimeout:     30000,
	signal,                              // optional AbortSignal
	systemType:          '',             // optional, bind field
	tls:                 false,          // boolean or tls.ConnectionOptions
	username:            'user',
});

const { err, pduObjs, smsIds } = await session.sendSms({
	dlr:                  false,
	encoding:             'UCS2',        // optional, overrides auto-detection
	flash:                false,
	from:                 'MyBrand',     // alphanumeric -> TON 5, digits -> TON 1
	message:              'Hello world',
	scheduleDeliveryTime: undefined,     // optional
	to:                   '46709771337',
	validityPeriod:       undefined,     // optional
}, { signal });                          // optional per-call AbortSignal

await session.unbind();
await session.close();

// --- server ---------------------------------------------------------------
const { err, server: smpp } = await server({
	authenticate: async ({ password, systemId }) => {
		if (systemId !== 'foo' || password !== 'bar') return false;

		return { userData: { userId: 123 } };   // attached to session.userData
	},
	idleTimeout:       40000,
	log,
	maxReassembly:     1000,
	port:              2775,
	reassemblyTimeout: 300000,
	signal,
	tls:               false,
});

smpp.port;             // resolved port, useful when 0 was requested
await smpp.close();

smpp.on('session', session => {
	session.on('sms', async sms => {
		const { err } = await sms.sendResp();          // defaults to ESME_ROK
		if (sms.dlr) await sms.sendDlr('DELIVERED');   // defaults to DELIVERED
	});
});
```

### Events

| Emitter | Event | Payload |
| --- | --- | --- |
| server | `session` | `Session` |
| server | `serverError` | `Error` |
| session | `sms` | `Sms` (live handle: `sendResp()`, `sendDlr()`) |
| session | `dlr` | one per segment — `{ doneDate?, errorCode?, smsId, statusId, statusMsg }` |
| session | `messageDlr` | merged once all segments of a message are accounted for — adds `segments` and the worst status across them |
| session | `sessionError` | `Error` |
| session | `close` | — |
| session | `reconnected` | — (only when `reconnect` is configured) |
| session | `data` | `Buffer` |
| session | `incomingPdu` | `Buffer` |
| session | `incomingPduObj` | `PduObject` |

### Rules the API follows

- **Never throws.** Everything fallible resolves to `{ err?, … }`. See AGENTS.md rule 1.
- **Named exports only.** No default export. `defs` stays as a grouped export alongside the
  individual tables (`cmds`, `consts`, `encodings`, `errors`, `tlvs`, `types`, and the `*ById` maps).
- **`utils` is gone.** Its contents are named exports: `bitCount`, `decodeMessage`, `encodeMessage`,
  `objToPdu`, `pduReturn`, `pduToObj`, `smppDate`, `smppTime`, `splitMessage`.
- **`defs.filters` is gone** — it never did anything. `smppTime` replaces the one useful part.
- **The PDU codec is synchronous** and returns `{ err?, pduObj? }` / `{ err?, buffer? }`.
- **Low-level surface stays public**, including `session.sock`, `session.send()` and
  `session.sendReturn()` — that is how the other 29 commands are reached.
- `pduObj.isResp()` is now the standalone export `isResp(pduObj)`; PDU objects are pure data.

## Tasks

### 1. Definition tables — `src/defs/`

All done, with tests in `test/encodings.test.ts`, `test/types.test.ts` and `test/commands.test.ts`.

- [x] `constants.ts` — `consts` + `constsById`.
- [x] `errors.ts` — all `ESME_*` codes plus `errorsById`, `isErrorName`, `errorNameById`.
- [x] `types.ts` — wire types. `read` is bounds-checked and reports `bytesRead`, so no caller has to
      re-derive a length that could disagree with what was written. `size` and `write` validate their
      input and return results.
- [x] `encodings.ts` — GSM 03.38, LATIN1, UCS2, FLASH, `detect` and `encodingByDataCoding`.
      `iconv-lite` is gone; Buffer does it natively.
- [x] `tlvs.ts` — 67 TLV definitions, `tlvsById`, and the two aliases.
- [x] `commands.ts` — all 33 commands, wire-ordered, plus `cmdsById` and the `PduParams<C>` /
      `PduParamsInput<C>` per-command types.
- [x] `filters.ts` — **not ported.** `defs.filters` was declared on commands and TLVs but never
      invoked anywhere in 0.4.0. The one piece that is genuinely needed, SMPP time formatting, is
      task 2's `smppTime`.

### 2. Message helpers — `src/message.ts`

Done, tested in `test/message.test.ts`. Segments are 153 GSM / 67 UCS2 characters, `smppDate` is
UTC and one-based, `decodeMessage` goes through `encodingByDataCoding`, and `splitMessage` takes the
concatenation reference as an argument rather than owning a module-global counter.

- [x] `bitCount`, `encodeMessage`, `decodeMessage`, `smppDate`, `splitMessage`, `smppTime`.

### 3. PDU codec — `src/pdu.ts`

Done, tested in `test/pdu.test.ts` — which includes the two byte-for-byte comparisons against 0.4.0's
output and the real captured SMSC PDUs from its suite.

- [x] `pduToObj`, `objToPdu`, `pduReturn`, `isResp`, `isCommand`.
- [x] Trailing-NULL retry kept, now an explicit second parse rather than a side effect of a length
      function.
- [x] `cmdLength` guarded by `maxPduLength` (1 MiB) before anything is allocated.
- [x] `objToPdu` narrows `params` to the named command. `pduToObj` returns loosely-typed params —
      the command is only known at runtime — and `isCommand(pduObj, 'submit_sm')` narrows them.

The encoder measures each field, allocates exactly that, and writes into it, so a `size`/`write`
disagreement surfaces as an error instead of a corrupt PDU. That class of bug is what the trailing
NULL defect was.

### 4. Session — `src/session.ts`

- [ ] Framing off the socket. Replace 0.4.0's `Buffer.concat` per chunk with an accumulating reader —
      concatenating the whole queue on every `data` event is quadratic.
- [ ] Sequence numbers, wrapping at 2147483646.
- [ ] `send()` with `responseTimeout`, `maxOutstanding` windowing and a queue, and `AbortSignal`.
      Listeners must be removed on every exit path — timeout, abort and close included.
- [ ] `sendReturn()`, `unbind()`, `close()`.
- [ ] `submit_sm` handling, including long-SMS reassembly with `maxReassembly` and a real
      `reassemblyTimeout` timer.
- [ ] `deliver_sm` handling: prefer the TLVs, fall back to parsing the receipt text
      (`id:… sub:001 dlvrd:1 submit date:… done date:… stat:DELIVRD err:0 text:…`).
- [ ] Per-segment `dlr` plus merged `messageDlr`.
- [ ] `enquire_link` and `unbind` handling.

### 5. Sms handle — `src/sms.ts`

- [ ] `sendResp(status?)` and `sendDlr(status?)` returning result DTOs.
- [ ] Generated `message_id` values are UUID v7.
- [ ] **Fix:** `sendDlr` emits the 7-character spec status (`UNDELIV`, not `UNDELIVERABLE`).

### 6. Client and server — `src/client.ts`, `src/server.ts`

- [ ] `client()` — bind by `bindType`, all bind fields optional with 0.4.0's defaults.
- [ ] **Fix:** real TLS via `tls.connect()` / `tls.createServer()`, accepting an options object.
- [ ] Opt-in reconnect with exponential backoff between `minDelay` and `maxDelay`, re-binding and
      emitting `reconnected`. Decide and document what happens to in-flight sends across a reconnect.
- [ ] `server()` — resolves once when listening, exposes `port`, `close()` and the `session` event.
- [ ] `authenticate` hook; `userData` attached to the session.
- [ ] `idleTimeout` drops silent peers.

### 7. Public surface — `src/index.ts`

- [ ] Named exports only, matching "The agreed API" above exactly.

### 8. Tests

Port the 0.4.0 suite (`test/01_encodings.js` … `test/04_session.js` on `master`) and extend it. Every
defect in the AGENTS.md table needs a test that fails against 0.4.0 behaviour.

- [ ] Encodings, wire types, PDU round-trips, return PDUs, message sizing and splitting.
- [ ] Sessions: bind, auth success and failure, simple SMS, long SMS, DLRs, and the Kannel capture
      with the large UDH from `test/04_session.js`.
- [ ] **Interop:** add the reference `smpp` package (farhadi/node-smpp) as a dev dependency and assert
      both directions — our encoder against its parser, its encoder against our parser. This is how
      the wire-format fixes are validated; the maintainer asked specifically for proof that the
      corrected framing is right rather than differently wrong.
- [ ] Reassembly bounds, response timeouts, abort, and the send window.

### 9. CI and release

- [ ] `.github/workflows/test.yaml` — lint, typecheck and test on Node 18, 20, 22 and 24. The 18/20
      legs need the tests compiled first, since type stripping needs Node 22.18+.
- [ ] `.github/workflows/release.yaml` — `npm publish --provenance` on a `v*` tag.
- [ ] `renovate.json`.
- [ ] Delete nothing from `master`; this branch simply does not carry `.travis.yml`.

### 10. Release chores

- [ ] Fill in README usage docs as each part lands — right now the README documents the target API,
      and it must not claim anything that is not implemented and tested.
- [ ] `npm deprecate larvitsmpp` pointing at `@larvit/smpp` once 1.0.0 is published. Maintainer's
      call to run it; not something CI should do.

## Open questions

None outstanding. Everything above was settled with the maintainer; anything genuinely new that comes
up during implementation should be asked rather than assumed.
