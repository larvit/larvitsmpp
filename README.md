# @larvit/smpp

A simplified implementation of the SMPP protocol, in TypeScript. ESM only, types included.

Successor to [larvitsmpp](https://www.npmjs.com/package/larvitsmpp) 0.4.0. The API is the same shape
it has always been — connect, send an SMS, listen for delivery reports — with callbacks replaced by
promises and the rough edges taken off.

> **Status: not released.** This branch is a rewrite in progress and nothing here is published yet.
> The API below is the agreed design and is being implemented against it; see
> [todo.md](todo.md) for what is done and what is not. Use `larvitsmpp` 0.4.0 until 1.0.0 ships.

## Requirements

Node 18 or later.

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

await smpp.close();
```

`sendDlr` accepts `SCHEDULED`, `ENROUTE`, `DELIVERED`, `EXPIRED`, `DELETED`, `UNDELIVERABLE`,
`ACCEPTED`, `UNKNOWN`, `REJECTED` and `SKIPPED`.

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
| `sms` | An SMS arrives. Carries `sendResp()` and `sendDlr()`. |
| `dlr` | A delivery report arrives, one per segment. |
| `messageDlr` | Every segment of a multipart message has been reported on. |
| `close` | The socket closed. |
| `reconnected` | The client re-bound after a drop (only with `reconnect` configured). |
| `sessionError` | Something failed on a live session. |
| `data` | Raw bytes arrived on the socket. |
| `incomingPdu` | A complete PDU arrived, as a buffer. |
| `incomingPduObj` | The same PDU, parsed into an object. |

### Methods

`sendSms()`, `send()`, `sendReturn()`, `unbind()` and `close()`. `send()` reaches any of the 33 SMPP
commands the codec knows, not just the four the session handles natively.

## Migrating from larvitsmpp 0.4.0

- **The package is now `@larvit/smpp`** and is ESM only. `require()` no longer works.
- **Callbacks are gone.** `client`, `server`, `sendSms`, `sendResp` and `sendDlr` are all promises
  resolving to a result object with an optional `err`. Nothing rejects.
- **`server()` resolves once, when it is listening**, and gives you a handle with `close()` and a
  `session` event. It no longer calls your callback once per incoming connection.
- **`checkuserpass` is now `authenticate`**, takes `{ password, systemId }` and returns `false` or
  `{ userData }`.
- **Renamed options:** `enqLinkTiming` → `enquireLinkInterval`, server `timeout` → `idleTimeout`.
- **`larvitsmpp.utils` is gone.** Its contents are named exports: `bitCount`, `decodeMessage`,
  `encodeMessage`, `objToPdu`, `pduReturn`, `pduToObj`, `smppDate`, `splitMessage`. The PDU codec is
  synchronous and returns `{ err, pduObj }` / `{ err, buffer }`.
- **`pduObj.isResp()` is now the standalone `isResp(pduObj)`.**
- **The `error` event is `sessionError`** (and `serverError` on the server handle).
- **`log`** takes a [`@larvit/log`](https://www.npmjs.com/package/@larvit/log) instance instead of a
  `larvitutils` one, and is silent by default.

### Behaviour that changed on the wire

0.4.0 had a number of protocol defects. Fixing them changes the bytes it puts on the wire, so if you
have worked around any of these, remove the workaround:

- Multipart segments were 158 octets, over the 140-octet limit. They are now correctly sized.
- LATIN1 (`data_coding` 0x03) was silently decoded as ASCII, corrupting the message.
- Delivery receipt dates were a month off, and the status field read `UNDELIVERABLE` where the spec
  defines the 7-character `UNDELIV`.
- `flash: true` discarded UCS2, mangling flash messages containing non-GSM characters.
- The multipart reference counter was shared by every session in the process.
- `tls: true` never performed a handshake, so the connection was not actually encrypted.
- Alphanumeric senders were sent with TON 1 (international) instead of TON 5.
- Delivery receipts carrying only the standard receipt text, with no TLVs — what Kannel and several
  other SMSCs send — were rejected outright. They are now parsed.

## Development

Everything runs in the container; nothing is installed on the host.

```bash
docker compose run --rm node npm install
docker compose run --rm node npm test     # lint, typecheck and tests
docker compose run --rm node npm run build
```

Tests are TypeScript and run directly under Node's type stripping, so there is no build step in the
development loop. CI additionally compiles and runs them on Node 18, 20, 22 and 24 to verify the
supported range.

## License

MIT
