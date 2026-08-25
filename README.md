# @larvit/smpp

A simplified implementation of the SMPP protocol, in TypeScript. ESM only, types included.

Successor to [larvitsmpp](https://www.npmjs.com/package/larvitsmpp) 0.4.0. The API is the same shape
it has always been — connect, send an SMS, listen for delivery reports — with callbacks replaced by
promises and the rough edges taken off.

> **Not published yet.** The implementation is complete and tested, but 1.0.0 has not been released
> to npm. Until it is, use `larvitsmpp` 0.4.0. Remaining release steps are in [todo.md](todo.md).

## Requirements

Node 18 or later. The only runtime dependency is
[`@larvit/log`](https://www.npmjs.com/package/@larvit/log).

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
| `systemType`, `addressRange`, `addrTon`, `addrNpi`, `interfaceVersion` | `''`, `''`, `0`, `0`, `0x50` | The remaining bind fields, for operators that require them. |
| `tls` | `false` | `true` for defaults, or a `tls.ConnectionOptions` object for a private CA or a client certificate. |
| `enquireLinkInterval` | `20000` | How often to send `enquire_link` on a quiet link. |
| `responseTimeout` | `30000` | How long to wait for a response before giving up on it. |
| `maxOutstanding` | `10` | Requests allowed on the wire at once; further sends queue. |
| `reconnect` | off | `{ minDelay, maxDelay }` to re-bind automatically after a drop, with exponential backoff. |
| `log` | silent | A `@larvit/log` instance. |
| `signal` | — | An `AbortSignal` that cancels connecting and tears the session down. |

### Sending

```javascript
await session.sendSms({
	dlr:                  true,        // ask for a delivery report
	encoding:             'UCS2',      // override the automatic choice
	flash:                false,
	from:                 'MyBrand',   // alphanumeric -> TON 5, digits -> TON 1
	message:              'Hello world',
	scheduleDeliveryTime: new Date(Date.now() + 3600_000),
	to:                   '46709771337',
	validityPeriod:       3600,        // seconds, or a Date
}, { signal });                       // optional per-call AbortSignal
```

Messages too long for one SMS are split automatically and sent as a concatenated message. You get
one id per segment:

```javascript
const { err, pduObjs, smsIds } = await session.sendSms({ from, message, to });
```

## Server

The simplest possible server — no authentication, listening on port 2775:

```javascript
import { server } from '@larvit/smpp';

const { err, server: smpp } = await server();
if (err) throw err;

smpp.on('session', session => {
	session.on('sms', async sms => {
		// sms.from, sms.to, sms.message, sms.dlr
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
		// Responding is part of the protocol, not optional.
		// Defaults to ESME_ROK; see the SMPP spec for the other status codes.
		await sms.sendResp();

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

### Server options

| Option | Default | |
| --- | --- | --- |
| `host` / `port` | all interfaces / `2775` | Where to listen. Pass `0` for any free port. |
| `authenticate` | accept everything | `({ password, session, systemId, systemType }) => false \| { userData }`, sync or async. |
| `tls` | `false` | `true`, or a `tls.TlsOptions` object with your certificate and key. |
| `idleTimeout` | `40000` | Drop a peer that has been silent this long. |
| `maxReassembly` | `1000` | Incomplete multipart messages held per session. |
| `reassemblyTimeout` | `300000` | How long an incomplete multipart message is held. |
| `responseTimeout`, `maxOutstanding`, `log`, `signal` | as for the client | |

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

## Sessions

### Events

| Event | Fires when |
| --- | --- |
| `sms` | An SMS arrives, reassembled if it was multipart. Carries `sendResp()` and `sendDlr()`. |
| `dlr` | A delivery report arrives, one per segment. |
| `messageDlr` | Every segment of a multipart message has been reported on. |
| `close` | The connection closed. |
| `reconnected` | The client re-bound after a drop (only with `reconnect` configured). |
| `sessionError` | Something failed on a live session. |
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
- **`log`** takes a [`@larvit/log`](https://www.npmjs.com/package/@larvit/log) instance instead of a
  `larvitutils` one, and is silent by default.

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
- Short or malformed PDUs threw out of the codec instead of being reported as a parse failure.
- Binds now declare `interface_version` 0x50. 0.4.0 declared 0x00, because the default in its own
  command table was never applied. Pass `interfaceVersion: 0x34` to bind as SMPP 3.4.
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
