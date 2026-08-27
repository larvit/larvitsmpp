# @larvit/smpp

A simplified implementation of the SMPP protocol, in TypeScript. ESM only, types included.

Successor to [larvitsmpp](https://www.npmjs.com/package/larvitsmpp) 0.4.0. The API is the same shape
it has always been — connect, send an SMS, listen for delivery reports — with callbacks replaced by
promises and the rough edges taken off.

> **Not published yet.** The implementation is complete and tested, but 1.0.0 has not been released
> to npm. Until it is, use `larvitsmpp` 0.4.0. Remaining release steps are in [todo.md](todo.md).

## Requirements

Node 18 or later. No runtime dependencies.

## Install

```bash
npm install @larvit/smpp
```

## Client

The simplest possible client — connects to localhost:2775 with no credentials and sends a message:

```javascript
import { client } from '@larvit/smpp';

const { err, session } = await client();
if (err) throw err;

await session.sendSms({
	from:    '46701113311',
	message: 'Hello world',
	to:      '46709771337',
});

await session.unbind();
```

With connection parameters, a delivery report and logging:

```javascript
import { Log } from '@larvit/log';
import { client } from '@larvit/smpp';

const log = new Log('debug');

const { err, session } = await client({
	host:     'smpp.somewhere.com',
	log,
	password: 'bar',
	port:     2775,
	username: 'foo',
});
if (err) throw err;

session.on('dlr', dlr => {
	// dlr.smsId, dlr.statusMsg, dlr.statusId
});

const { err: sendErr, smsIds } = await session.sendSms({
	dlr:     true,
	from:    '46701113311',
	message: '«baff»',
	to:      '46709771337',
});
```

### Client options

Every one is optional.

| Option | Default | |
| --- | --- | --- |
| `host` / `port` | `localhost` / `2775` | Where to connect. |
| `username` / `password` | `user` / `pass` | Bind credentials (`system_id` and `password`). |
| `bindType` | `transceiver` | `transceiver`, `transmitter` or `receiver`. |
| `interfaceVersion` | `0x34` | The SMPP version declared at bind. `0x50` for an SMSC that requires SMPP 5.0. |
| `systemType`, `addressRange`, `addrTon`, `addrNpi` | `''`, `''`, `0`, `0` | The remaining bind fields, for operators that require them. |
| `tls` | `false` | `true` for defaults, or a `tls.ConnectionOptions` object for a private CA or a client certificate. |
| `enquireLinkInterval` | `20000` | How often to send `enquire_link` on a quiet link. |
| `idleTimeout` | `2 × enquireLinkInterval` | Give up on a link the peer has stopped answering; with `reconnect` set, it re-binds. |
| `responseTimeout` | `30000` | How long to wait for a response before giving up on it; `0` waits forever. |
| `maxOutstanding` | `10` | Requests allowed on the wire at once; further sends queue. |
| `reconnect` | off | `{ minDelay, maxDelay }` to re-bind automatically after a drop or an idle timeout, with exponential backoff. |
| `log` | silent | Any object with `debug`, `error`, `info`, `verbose` and `warn` methods — see [Logging](#logging). |
| `signal` | — | An `AbortSignal` that cancels connecting and tears the session down. |

### Sending

```javascript
await session.sendSms({
	dlr:                  true,        // ask for a delivery report
	destinationAddrNpi:   0,           // override the numbering plan of the recipient
	destinationAddrTon:   1,
	encoding:             'UCS2',      // override the automatic choice
	flash:                false,
	from:                 'MyBrand',   // alphanumeric -> TON 5, digits -> TON 1
	maxSegments:          10,          // refuse a longer message instead of sending it
	message:              'Hello world',
	scheduleDeliveryTime: new Date(Date.now() + 3600_000),
	sourceAddrNpi:        0,           // override the numbering plan of the sender
	sourceAddrTon:        5,
	to:                   '46709771337',
	validityPeriod:       3600,        // seconds, or a Date
}, { signal });                       // optional per-call AbortSignal
```

`sourceAddrTon` and `destinationAddrTon` default to 5 for an alphanumeric address and 1 for a
numeric one; the NPI fields default to 0. Set them for an operator that requires something else.

Messages too long for one SMS are split automatically and sent as a concatenated message. You get
one id per segment:

```javascript
const { err, pduObjs, smsIds } = await session.sendSms({ from, message, to });
```

`err` is set when the SMSC refuses a segment, and it names the status it refused with. Because every
segment goes on the wire together, `pduObjs` and `smsIds` then hold what the SMSC did accept — enough
to reconcile against a later receipt, not enough to resend the rest, so treat a partial failure as a
failed message. A message needing more than 255 segments is refused before anything is sent, since
the concatenation header numbers segments in a single octet. `maxSegments` lowers that ceiling:
most handsets and SMSCs stop well short of 255, and refusing beats a message only half delivered.

### Receiving

A `receiver` or `transceiver` client gets mobile-originated messages as `sms` events — the same
handle the server side gets, answered the same way:

```javascript
session.on('sms', async sms => {
	// sms.from, sms.to, sms.message
	await sms.sendResp();
});
```

Delivery receipts travel on the same SMPP command but reach you as `dlr`, so nothing you write has
to tell the two apart.

## Server

The simplest possible server — no authentication, listening on port 2775:

```javascript
import { server } from '@larvit/smpp';

const { err, server: smpp } = await server();
if (err) throw err;

smpp.on('session', session => {
	session.on('sms', async sms => {
		// sms.from, sms.to, sms.message, sms.dlr
		await sms.sendResp();
	});
});
```

With authentication and delivery reports:

```javascript
import { server } from '@larvit/smpp';

const { err, server: smpp } = await server({
	// Replace with your own auth. Returning an object attaches it to session.userData.
	authenticate: async ({ password, systemId }) => {
		if (systemId !== 'foo' || password !== 'bar') return false;

		return { userData: { userId: 123 } };
	},
});
if (err) throw err;

smpp.on('session', session => {
	session.on('sms', async sms => {
		// Responding is part of the protocol, not optional. Without arguments it answers
		// ESME_ROK with a generated id; pass your own, and a status to refuse the message.
		await sms.sendResp();
		// await sms.sendResp({ smsId: yourOwnId, status: 'ESME_RMSGQFUL' });

		if (sms.dlr) {
			await sms.sendDlr(); // same as sms.sendDlr('DELIVERED')
		}
	});
});

console.log(smpp.port);  // the port actually bound, useful when 0 was requested
await smpp.close();      // stop listening and close every live session
```

`sendDlr` accepts `SCHEDULED`, `ENROUTE`, `DELIVERED`, `EXPIRED`, `DELETED`, `UNDELIVERABLE`,
`ACCEPTED`, `UNKNOWN`, `REJECTED` and `SKIPPED`.

A message whose `data_coding` says 8-bit binary arrives as Latin-1, so `Buffer.from(sms.message,
'latin1')` gives you back the original octets.

### Server options

| Option | Default | |
| --- | --- | --- |
| `host` / `port` | all interfaces / `2775` | Where to listen. Pass `0` for any free port. |
| `authenticate` | accept everything | `({ password, session, systemId, systemType }) => false \| { userData }`, sync or async. |
| `systemId` | `''` | The SMSC identity returned to the ESME in the bind response. |
| `interfaceVersion` | `0x34` | The SMPP version advertised in the bind response. The floor for sending a peer optional parameters stays `0x34`, whatever this is set to. |
| `tls` | `false` | A `tls.TlsOptions` object with your certificate and key. |
| `idleTimeout` | `40000` | Drop a peer that has been silent this long. |
| `maxReassembly` | `1000` | Incomplete multipart messages held per session. |
| `maxOctets` | `67108864` | Bytes of incomplete multipart messages held per session. |
| `reassemblyTimeout` | `300000` | How long a late segment can still join an incomplete message. |
| `responseTimeout`, `maxOutstanding`, `log`, `signal` | as for the client | |

### Bind direction

The three bind types are honoured in both directions, not just accepted. A receiver-bound ESME
carries no `submit_sm` and a transmitter-bound one is sent no `deliver_sm`, whichever end of the
link the session is:

- `session.sendSms()` on a receiver-bound session, and `sms.sendDlr()` to a transmitter-bound peer,
  fail with an `err` before anything reaches the wire.
- A `submit_sm` arriving on a receiver-bound session, or a `deliver_sm` on a transmitter-bound one,
  is answered `ESME_RINVBNDSTS`.

A `transceiver` bind, the default, carries both. `session.send()` stays a low-level passthrough and
is not checked, so the raw surface can still put whatever a test or a proxy needs on the wire.

## Errors

Nothing in this library throws. Every fallible call returns a result carrying an optional `err`, so
failures are handled in one place instead of two:

```javascript
const { err, session } = await client({ host: 'smpp.somewhere.com' });
if (err) return;

const { err: sendErr, smsIds } = await session.sendSms({ from, message, to });
```

Runtime failures on a live connection arrive as `sessionError` and `serverError` events. They are
deliberately not called `error`: Node turns an unhandled `error` event into a thrown exception, which
is exactly what this library promises not to do.

## Logging

`log` takes any object with `debug`, `error`, `info`, `verbose` and `warn` methods, each
`(msg: string, metadata?: Record<string, boolean | number | string>) => void`. Message strings are
static and every dynamic value goes in the metadata, so entries group by message.

[`@larvit/log`](https://www.npmjs.com/package/@larvit/log) implements it as it stands:

```javascript
import { Log } from '@larvit/log';
import { client } from '@larvit/smpp';

const { err, session } = await client({ log: new Log('debug') });
```

So does an object of your own, forwarding wherever you want it:

```javascript
const log = {
	debug:   () => undefined,
	error:   (msg, metadata) => { console.error(msg, metadata); },
	info:    (msg, metadata) => { console.info(msg, metadata); },
	verbose: () => undefined,
	warn:    (msg, metadata) => { console.warn(msg, metadata); },
};
```

TypeScript users can import `SmppLog` to have the compiler check one.

## Sessions

### Events

| Event | Fires when |
| --- | --- |
| `sms` | An SMS arrives, reassembled if it was multipart. Carries `sendResp()`, `sendDlr()` and the `smsId` it was answered with. |
| `dlr` | A delivery report arrives, one per segment. |
| `messageDlr` | Every segment of a multipart message sent with `dlr: true` has been reported on, carrying the worst status of the segments. |
| `close` | The connection closed. |
| `reconnected` | The client re-bound after a drop (only with `reconnect` configured). |
| `sessionError` | Something failed on a live session, including a hook or listener that threw. |
| `data` | Raw bytes arrived on the socket. |
| `incomingPdu` | A complete PDU arrived, as a buffer. |
| `incomingPduObj` | The same PDU, parsed into an object. |

### Methods

`sendSms()`, `send()`, `sendReturn()`, `unbind()` and `close()`. `send()` reaches any of the 33 SMPP
commands the codec knows, not just the four the session handles natively:

```javascript
const { err, pduObj } = await session.send({
	cmdName: 'query_sm',
	params: { message_id: smsId },
});
```

`acceptsOptionalParams()` answers whether the peer declared SMPP 3.4 or later, which is the version
at and above which the spec allows optional parameters to be sent to it; `peerInterfaceVersion` is
the version it declared, `0x00` if it declared none. The library's own senders consult the first before attaching a TLV — a
`send()` you build yourself is passed through as written, so consult it too when you attach TLVs.

`bindAllows(cmdName)` answers the same question for the bind direction, and `boundAs` is the role
the ESME bound with — see [Bind direction](#bind-direction).

## Working with PDUs directly

The codec is exported, synchronous, and never throws — handy for inspecting captured traffic:

```javascript
import { isCommand, objToPdu, pduToObj } from '@larvit/smpp';

const { err, pduObj } = pduToObj(buffer);
if (err) return;

if (isCommand(pduObj, 'submit_sm')) {
	pduObj.params.destination_addr; // typed as a string
}
```

The spec tables are exported both individually (`cmds`, `consts`, `encodings`, `errors`, `tlvs`,
`types`, and the matching `*ById` maps) and grouped as `defs`.

## Migrating from larvitsmpp 0.4.0

- **The package is now `@larvit/smpp`** and is ESM only. `require()` no longer works.
- **Callbacks are gone.** `client`, `server`, `sendSms`, `sendResp` and `sendDlr` are all promises
  resolving to a result object with an optional `err`. Nothing rejects.
- **`server()` resolves once, when it is listening**, and gives you a handle with `close()`, `port`
  and a `session` event. It no longer calls your callback once per incoming connection.
- **The id a message is answered with goes to `sendResp({ smsId })`**, and `sms.smsId` is read-only:
  it reports what the response actually carried. Delete any `sms.smsId = …` line — assigning to it
  throws a `TypeError`, since modules are always strict mode — and pass the id to `sendResp()`.
- **`checkuserpass` is now `authenticate`**, takes `{ password, session, systemId, systemType }` and
  returns `false` or `{ userData }`.
- **Renamed options:** `enqLinkTiming` → `enquireLinkInterval`, server `timeout` → `idleTimeout`.
- **`larvitsmpp.utils` is gone.** Its contents are named exports: `bitCount`, `decodeMessage`,
  `encodeMessage`, `objToPdu`, `pduReturn`, `pduToObj`, `smppDate`, `smppTime`, `splitMessage`. The
  PDU codec is synchronous and returns `{ err, pduObj }` / `{ err, buffer }`.
- **`pduObj.isResp()` is now the standalone `isResp(pduObj)`**, and `pduObj.cmdStatus` is `undefined`
  for a status code the library does not know, with the raw number in `pduObj.cmdStatusId`.
- **`defs.filters` is gone.** It was declared on every command and TLV but never invoked, so it did
  nothing. SMPP time formatting, the one part worth keeping, is exported as `smppTime`.
- **The `error` event is `sessionError`** (and `serverError` on the server handle).
- **`log`** takes any object with `debug`, `error`, `info`, `verbose` and `warn` methods instead of a
  `larvitutils` one, and is silent by default. See [Logging](#logging).

### Behaviour that changed on the wire

0.4.0 had a number of protocol defects. Fixing them changes the bytes it puts on the wire, so if you
have worked around any of these, remove the workaround:

- Every multipart segment was one character short (152 GSM characters instead of 153, 66 UCS2
  instead of 67), so long messages were split into more segments than necessary — and each extra
  segment costs a message.
- LATIN1 (`data_coding` 0x03) was silently decoded as ASCII, corrupting the message.
- Delivery receipt dates were a month off, and the status field read `UNDELIVERABLE` where the spec
  defines the 7-character `UNDELIV`.
- `flash: true` discarded UCS2, mangling flash messages containing non-GSM characters.
- The multipart reference counter was shared by every session in the process.
- `tls: true` never performed a handshake, so the connection was not actually encrypted.
- Alphanumeric senders were sent with TON 1 (international) instead of TON 5.
- Delivery receipts carrying only the standard receipt text, with no TLVs — what Kannel and several
  other SMSCs send — were rejected outright. They are now parsed.
- A message whose last octet was `0x00` was allocated one octet short while `sm_length` still
  reported the full length, so it went out corrupt. In UCS2 that is any message ending in a
  character like 一 (U+4E00), which made the bug routine for CJK text.
- Binary TLVs (`message_payload`, `network_error_code`, `callback_num` and the rest) were parsed
  into a hex string and written back as the ASCII of that string, so every one that made a round
  trip went out corrupt. They are `Buffer`s in both directions now, so drop any hex encoding of
  your own.
- Short or malformed PDUs threw out of the codec instead of being reported as a parse failure.
- Binds now declare `interface_version` 0x34. 0.4.0 declared 0x00, which tells the SMSC the ESME
  speaks SMPP 3.3 or earlier — and a spec-following SMSC then withholds every optional parameter,
  including the TLVs delivery receipts are carried in.
- A response reporting a failure now carries no body, which is what the spec defines and what other
  implementations send. 0.4.0 filled the body with empty defaults, so a refused `submit_sm_resp` went
  out with an empty `message_id` a caller could mistake for a real one.
- `submit_multi` was missing its `sm_length` field, so its `short_message` never round-tripped.

The corrected framing is cross-checked against [node-smpp](https://github.com/farhadi/node-smpp), an
independent implementation, in both directions and over a live session.

## Development

Everything runs in the container; nothing is installed on the host.

```bash
docker compose run --rm node npm install
docker compose run --rm node npm test                # lint, typecheck and tests
docker compose run --rm node npm run build
docker compose run --rm node npm run test:compiled   # what CI runs on older Node versions
```

Tests are TypeScript and run directly under Node's type stripping, so there is no build step in the
development loop. CI additionally compiles and runs them on Node 18, 20, 22 and 24 to verify the
supported range.

## License

MIT
