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
  `objToPdu`, `pduReturn`, `pduToObj`, `smppDate`, `splitMessage`.
- **The PDU codec is synchronous** and returns `{ err?, pduObj? }` / `{ err?, buffer? }`.
- **Low-level surface stays public**, including `session.sock`, `session.send()` and
  `session.sendReturn()` — that is how the other 29 commands are reached.
- `pduObj.isResp()` is now the standalone export `isResp(pduObj)`; PDU objects are pure data.

## Tasks

### 1. Definition tables — `src/defs/`

- [x] `constants.ts` — `consts` + `constsById`.
- [ ] `errors.ts` — all `ESME_*` codes plus `errorsById`. Port from 0.4.0 `lib/defs.js`; note that
      0.4.0 has a typo, `ESME_RINVBCASTCHANIND = 0x011` (three digits), which should be `0x0111`.
      Verify every code against the SMPP 3.4/5.0 spec while porting.
- [ ] `types.ts` — wire types `int8`, `int16`, `int32`, `string`, `cstring`, `buffer`,
      `dest_address_array`, `unsuccess_sme_array`, and the `tlv` variants. Each is
      `{ default, read(buffer, offset, length?), size(value), write(value, buffer, offset) }`.
      `read` must be bounds-checked and return a result rather than throwing.
- [ ] `encodings.ts` — GSM 03.38 (`ASCII`), `LATIN1`, `UCS2`, `FLASH` (alias of ASCII) and `detect`.
      Drop `iconv-lite`: LATIN1 is `Buffer.from(str, 'latin1')`, UCS2 is `Buffer.from(str,
      'utf16le').swap16()` (copy before swapping, and reject odd-length input on decode).
- [ ] `filters.ts` — `time`, `message`, `billing_identification`, `broadcast_area_identifier`,
      `broadcast_content_type`, `broadcast_frequency_interval`, `callback_num`, `callback_num_atag`.
- [ ] `tlvs.ts` — the 67 TLV definitions plus `tlvsById` and the two aliases
      (`alert_on_msg_delivery`, `failed_broadcast_area_identifier`).
- [ ] `commands.ts` — all 33 commands with ids and **wire-ordered** parameter lists, plus `cmdsById`.

### 2. Message helpers — `src/message.ts`

- [ ] `bitCount(msg, encoding?)`, `encodeMessage`, `decodeMessage`, `smppDate`, `splitMessage`.
- [ ] **Fix:** segments are 134 GSM characters or 67 UCS2 characters, so that segment + 6-byte UDH
      is exactly 140 octets. 0.4.0 produces 152/66.
- [ ] **Fix:** `smppDate` must add 1 to `getMonth()` and zero-pad correctly.
- [ ] **Fix:** LATIN1 must actually decode — resolve `data_coding` to a concrete encoding, not to
      whichever alias happens to sort last.
- [ ] The concatenation reference counter is per session, not module-global. `splitMessage` therefore
      takes the reference as an argument instead of owning a counter.

### 3. PDU codec — `src/pdu.ts`

- [ ] `pduToObj(buffer)` → `{ err?, pduObj? }`, `objToPdu(obj)` → `{ err?, buffer? }`,
      `pduReturn(pdu, status?, params?, tlvs?)` → `{ err?, buffer? }`, `isResp(pduObj)`.
- [ ] Keep the trailing-NULL-octet retry for `short_message` that 0.4.0 has — real peers send it.
- [ ] Guard `cmdLength` against a maximum before allocating, so a hostile peer cannot ask for a 4 GiB
      buffer. 0.4.0 has no such guard.
- [ ] Per-command typed params: `pduToObj` returns a union discriminated on `cmdName`, and
      `objToPdu` narrows `params` to the named command's fields.

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
