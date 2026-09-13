# @larvit/smpp

[![npm](https://img.shields.io/npm/v/@larvit/smpp)](https://www.npmjs.com/package/@larvit/smpp)

SMPP 3.4 client and server for Node.js with the session layer built in: keepalive, reconnect, send
window, long messages and delivery receipts. TypeScript, ESM, no dependencies.

- **Keepalive.** `enquire_link` every 20 s on a quiet link; a peer that stops answering is dropped.
- **Reconnect.** A dropped client link re-binds on its own, backing off from 1 s to 30 s.
- **Send window.** 10 requests in flight; further sends queue instead of overrunning the SMSC.
- **Long messages.** Split on send, reassembled on receive, in both the UDH and `sar_*` spellings.
- **Delivery receipts.** Read from TLVs or from receipt text, matched to the ids you were given.
- **Graceful shutdown.** `close()` waits for what is in flight, so neither end has to guess.
- **Never throws.** Every fallible call resolves to `{ err?, … }`.
- **Interoperable.** Tested as a client against Jasmin and SMPPSim, and as a server against Kannel,
  jsmpp, Cloudhopper, python-smpplib and php-smpp:
  [interop-tests/](https://gitea.larvit.se/larvit/smpp-js/src/branch/main/interop-tests/README.md).

[Install](#install) · [Send an SMS](#send-an-sms) · [Delivery reports](#delivery-reports) ·
[Receive SMS](#receive-sms) · [Run an SMPP server](#run-an-smpp-server) · [Errors](#errors) ·
[Client options](#client-options) · [Server options](#server-options) ·
[Send options](#send-options) · [Session](#session) · [Receiving in depth](#receiving-in-depth) ·
[Server in depth](#server-in-depth) · [Logging](#logging) ·
[PDUs and the low-level API](#pdus-and-the-low-level-api) ·
[Migrating from 0.4.0](#migrating-from-larvitsmpp-040) · [Development](#development)

## Install

```bash
npm install @larvit/smpp
```

Node 18 or later. ESM only, types included.

## Send an SMS

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

Without options this binds to `localhost:2775` as a transceiver with the default credentials. A real
SMSC needs `host`, `port`, `username` and `password`: [Client options](#client-options). A message
longer than one SMS is split and sent as one concatenated message: [Send options](#send-options).

## Delivery reports

Connection parameters, a receipt per segment, and logging:

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

`dlr: true` asks the SMSC to report on each segment. Match `dlr.smsId` against the `smsIds` the send
returned. `statusMsg` is `DELIVERED`, `UNDELIVERABLE`, `EXPIRED` and so on; `intermediate` is true
for a report that is not final. The full shape, the `messageDlr` event that merges a long message's
receipts into one, and SMSCs that write ids in two notations: [Delivery receipts](#delivery-receipts).

## Receive SMS

A `receiver` or `transceiver` client gets mobile-originated messages as `sms` events:

```javascript
session.on('sms', async sms => {
	// sms.from, sms.to, sms.message
	await sms.sendResp();
});
```

Call `sendResp()` for every message; it is part of the protocol. Delivery receipts reach you as
`dlr` events, not here. A multipart message arrives reassembled and already answered segment by
segment, so `sendResp()` there only says you are done with it: [Receiving in depth](#receiving-in-depth).

## Run an SMPP server

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
		if (sms.answeredOnArrival) {
			await sms.sendResp(); // multipart: already answered per segment; this only releases the shutdown drain
		} else {
			// no args: ESME_ROK + generated id; or sendResp({ smsId, status: 'ESME_RMSGQFUL' })
			await sms.sendResp();
		}

		if (sms.dlr) {
			await sms.sendDlr(); // same as sms.sendDlr('DELIVERED')
		}
	});
});

console.log(smpp.port);  // the port actually bound, useful when 0 was requested
await smpp.close();      // stop listening, then drain and close every live session
```

- `sendResp()` answers `ESME_ROK` with a generated UUID v7 as the message id.
  `sendResp({ smsId, status })` names the id or refuses the message.
- `sms.dlr` is true where the sender asked for a receipt. `sendDlr()` reports `DELIVERED`,
  `sendDlr('UNDELIVERABLE')` any other state: [Server in depth](#server-in-depth).
- A message that arrived in several segments was answered as they arrived, so `sendResp()` there
  takes no `smsId` or refusing `status`. `sms.answeredOnArrival` says which case you are in.
- `smpp.close()` stops listening, then drains and closes every live session.

## Errors

Nothing throws. Every fallible call returns a result with an optional `err`:

```javascript
const { err, session } = await client({ host: 'smpp.somewhere.com' });
if (err) return;

const { err: sendErr, smsIds } = await session.sendSms({ from, message, to });
```

Failures on a live session arrive as `sessionError` events, on a server handle as `serverError`.
Neither is named `error`, because Node throws on an unhandled `error` event.

`sessionError` carries three kinds of failure:

| Kind | Type | |
| --- | --- | --- |
| A PDU the peer sent that the codec could not read. The link stays up; only that PDU is lost. | `PduRefusedError` | Count it. |
| A concatenated message given up on before it was whole. Its segments were answered, so the peer will not resend, and no `sms` fired for it. | `Error` | Count it as lost traffic. |
| The session or socket failing, or a hook or listener that threw or rejected. | `Error` | Alert. |

The last two are told apart by message text only, so this alerts on both:

```javascript
import { PduRefusedError } from '@larvit/smpp';

session.on('sessionError', err => {
	if (err instanceof PduRefusedError) {
		log.warn('the peer sent a PDU that could not be read', {
			cmdName: err.header.cmdName ?? err.header.cmdId,
			reason: err.reason,
		});

		return;
	}

	log.error('a session failure or lost traffic', { message: err.message });
});
```

- `reason` is `command`, `body` or `tlvs`: the part the codec stopped at.
- `header` is the 16 octets that did parse: `cmdId`, `cmdLength`, `cmdName`, `cmdStatusId` and
  `seqNr`. `cmdName` is undefined for a command id this library does not know. `PduHeader` is its type.
- A refused request is answered with the status SMPP names for it. A refused response is answered
  with nothing, and settles the request it named as `unanswered`.
- A refused inbound `deliver_sm` is lost traffic: a message or receipt that never arrives as `sms`
  or `dlr`. A refused response is reported twice, as the `err` of the `sendSms()` or `send()`
  waiting on it and here.
- A `PduRefusedError` is always a PDU that arrived. What this library refuses to build or send (an
  alphabet, a time, a body its `data_coding` cannot carry) is a plain `Error` in the call's result.

## Client options

All optional. Timeouts and delays are milliseconds.

| Option | Default | |
| --- | --- | --- |
| `host`, `port` | `localhost`, `2775` | Where to connect. |
| `username`, `password` | `user`, `pass` | Bind credentials: `system_id` and `password`. |
| `bindType` | `transceiver` | `transceiver`, `transmitter` or `receiver`. |
| `interfaceVersion` | `0x34` | The SMPP version declared at bind. `0x50` for an SMSC that requires SMPP 5.0. |
| `systemType`, `addressRange`, `addrTon`, `addrNpi` | `''`, `''`, `0`, `0` | The remaining bind fields, for operators that require them. |
| `tls` | `false` | `true` for defaults, or a `tls.ConnectionOptions` object for a private CA or a client certificate. |
| `enquireLinkInterval` | `20000` | Interval between `enquire_link` on a quiet link. |
| `idleTimeout` | `2 × enquireLinkInterval` | Give up on a link the peer has stopped answering, and re-bind unless `reconnect` is `false`. |
| `responseTimeout` | `30000` | How long to wait for a response, and how long a send with no link waits for the next one. `0` waits forever. |
| `shutdownTimeout` | `5000` | How long `close()` and `unbind()` wait for requests already sent and messages not yet answered. `0` waits forever for the requests, which end when the peer answers or `responseTimeout` expires, so both at `0` never ends. The messages then fall back to `responseTimeout`, or to its default where that is `0` too. |
| `maxOutstanding` | `10` | Requests on the wire at once; further sends queue. |
| `smsIdFormat` | — | The notation the SMSC writes message ids in, per place: `{ receipt: 'decimal', submitResp: 'hex' }`. Only where the two disagree: [Delivery receipts](#delivery-receipts). |
| `reconnect` | on | `{ minDelay, maxDelay }` retunes the backoff; `false` turns it off, so a drop ends the session; `{ fromStart: true }` retries the first connect too. |
| `log` | silent | Any object with `debug`, `error`, `info`, `verbose` and `warn` methods: [Logging](#logging). |
| `signal` | — | An `AbortSignal` that cancels connecting and tears the session down. |

**Reconnect.** After a drop, an idle timeout, or a stream the library cannot frame, the client
reopens the socket and re-binds, doubling the delay from `minDelay` (1 s) to `maxDelay` (30 s), and
starts over at `minDelay` once a link has lasted `maxDelay`.

`reconnect: { fromStart: true }` puts the first connect and bind through the same loop, a bind the
SMSC refuses included, so a client started while its SMSC is down keeps retrying. `client()` then
resolves once bound, and only an aborted `signal` ends the wait. That signal also closes the session
once bound, so write a deadline as an `AbortController` you stop arming when `client()` returns,
not as `AbortSignal.timeout(ms)`.

## Server options

All optional. Timeouts are milliseconds.

| Option | Default | |
| --- | --- | --- |
| `host`, `port` | all interfaces, `2775` | Where to listen. `port: 0` takes any free port; `smpp.port` says which. |
| `authenticate` | accept everything | `({ password, session, systemId, systemType }) => false \| { userData }`, sync or async. |
| `onRequest` | none | `(session, pduObj) => true \| false`, sync or async. First refusal on every request a bound peer sends: [Server in depth](#server-in-depth). |
| `systemId` | `''` | The SMSC identity returned in the bind response. |
| `interfaceVersion` | `0x34` | The SMPP version advertised in the bind response. Optional parameters are sent to a peer from `0x34` up, whatever this is set to. |
| `tls` | `false` | A `tls.TlsOptions` object with your certificate and key. A bare `true` is refused. |
| `idleTimeout` | `40000` | Drop a peer that has been silent this long. |
| `maxReassembly` | `1000` | Incomplete multipart messages held per session. |
| `maxOctets` | `67108864` | Bytes of incomplete multipart messages held per session. |
| `reassemblyTimeout` | `300000` | How long a late segment can still join an incomplete message. |
| `responseTimeout`, `shutdownTimeout`, `maxOutstanding`, `log`, `signal` | as for the client | |

## Send options

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
	messagingMode:        'SMSC_DEFAULT', // or DATAGRAM or STORE_FORWARD
	scheduleDeliveryTime: new Date(Date.now() + 3600_000),
	sourceAddrNpi:        0,           // override the numbering plan of the sender
	sourceAddrTon:        5,
	to:                   '46709771337',
	validityPeriod:       3600,        // seconds, or a Date
}, { signal });                       // optional per-call AbortSignal
```

**Addresses.** `sourceAddrTon` and `destinationAddrTon` default to 5 for an alphanumeric address
and 1 for a numeric one; the NPI fields default to 0.

**Encoding.**

| `encoding` | Alphabet | Characters per SMS | Per segment of a long message |
| --- | --- | --- | --- |
| `ASCII` | GSM 03.38 7-bit | 160 | 153 |
| `LATIN1` | ISO 8859-1 | 140 | 134 |
| `UCS2` | UCS-2 | 70 | 67 |

- Omitted: `ASCII` where the message fits GSM 7-bit, otherwise `UCS2`. `LATIN1` only when named.
  Any other name is refused.
- GSM extension characters (`{}[]\~^|€` and form feed) count as two, as does a character outside
  the basic multilingual plane in `UCS2`.
- An alphabet you name has to carry every character, or the send is refused before anything goes
  out, naming the character, its code point and its index. Detection never refuses.
- `LATIN1` carries every octet, so `buffer.toString('latin1')` reaches the SMSC byte for byte, under
  `data_coding` 0x03, which declares Latin-1 text. To declare 8-bit binary, hand `session.send()` a
  `Buffer` body and the `data_coding` you want: [PDUs and the low-level API](#pdus-and-the-low-level-api).
- `consts.ENCODING` is the low-level `data_coding` table, not this option's list.

**Long messages.**

```javascript
const { err, pduObjs, smsIds, unanswered } = await session.sendSms({ from, message, to });
```

- One id per segment. `smsIds` is positional with `pduObjs`, and an entry is `undefined` where the
  SMSC took the segment without naming an id; some name one for the first segment only. No receipt
  ever carries an empty id, so an unnamed entry matches nothing.
- `err` is set when the SMSC refuses a segment, naming the status. Every segment goes out together,
  so `pduObjs` and `smsIds` then hold what was accepted: enough to reconcile a later receipt, not
  enough to resend the rest. Treat a partial failure as a failed message.
- `unanswered` counts segments that went out and were never answered. The SMSC may have taken each
  and lost only the response, so a message with `unanswered` above zero cannot be resent without
  risking a duplicate.
- More than 255 segments is refused before anything is sent, since the concatenation header numbers
  segments in one octet. `maxSegments` lowers that ceiling; most handsets and SMSCs stop well short.

**Flash.** `flash: true` asks for GSM 03.38 message class 0, shown on arrival instead of stored. It
travels in `data_coding` beside the alphabet, so a flash UCS2 message stays UCS2. `flash` with
`encoding: 'LATIN1'` is refused: no `data_coding` carries both.

**Messaging mode.** `messagingMode` names the `esm_class` mode: `SMSC_DEFAULT`, which is what an
omitted option sends, `DATAGRAM` or `STORE_FORWARD`. Every segment of a long message also carries the
user data header indicator, so `STORE_FORWARD` on one sends `esm_class` 0x43. `DATAGRAM` with
`dlr: true` is refused, since datagram mode has no delivery reports. Transaction mode
(`consts.MESSAGING_MODE.FORWARD`) exists only on `data_sm`, which is never sent, and is refused too.

**Times.** `scheduleDeliveryTime` and `validityPeriod` take a `Date`, a number of seconds, or a stamp
you formatted. Refused before anything goes out: an invalid `Date`, `NaN`, `Infinity`, a negative
count, and a count past 99 days 23:59:59, since a count in seconds is spelled in days and below.
Name a later instant as a `Date`, which goes out absolute.

**What gets checked.** The library checks what it composes: an alphabet or a time you named, a string
body under a `data_coding` you named. What you formed yourself, a `Buffer` body or a stamp you
formatted, passes through as written. The same rule holds for `session.send()`.

## Session

### Events

| Event | Fires when |
| --- | --- |
| `sms` | An SMS arrives, reassembled if it was multipart. Carries `sendResp()`, `sendDlr()` and `smsId`. |
| `dlr` | A delivery report arrives, one per segment, with its PDU as the second argument: [Delivery receipts](#delivery-receipts). |
| `messageDlr` | Every segment of a long message sent with `dlr: true` has a final report: [Delivery receipts](#delivery-receipts). |
| `close` | The session is over and nothing will bring the link back. Fires once, whether you closed it or the link failed for good. |
| `disconnected` | The link dropped and the reconnect loop will retry. Do not open a replacement client: this session comes back on its own, and `reconnected` says when. Fires again for each attempt that reconnects and then fails, so it is not one-to-one with `reconnected`. |
| `reconnected` | The client re-bound after a drop. |
| `sessionError` | Something failed on a live session, a PDU the codec refused included: [Errors](#errors). |
| `data` | Raw bytes arrived on the socket. |
| `incomingPdu` | A complete PDU arrived, as a buffer. |
| `incomingPduObj` | The same PDU, parsed into an object. |

### Methods

`sendSms()`, `send()`, `sendReturn()`, `unbind()` and `close()`.

**Shutdown.** `close()` and `unbind()` both:

1. Refuse further sends. `sendDlr()` is the one send let past, when issued straight after
   `sendResp()`; await anything in between and it races the shutdown like any other send.
2. Wait up to `shutdownTimeout` for the requests already sent, and for every `sms` the application
   has not answered. That wait ends when `sendResp()` puts the response on the wire (or, for a
   message answered on arrival, when it is called at all), or when every listener that took the
   message has failed. Answering through `sendReturn()` instead leaves the wait running.
3. Tear down what is left, resolving to an `err` that says what was lost.

At most 1000 unanswered messages are held, for five minutes each; what falls out of either bound is
dropped with a warning on the log and waited for no longer. Neither bound is an option.
`close({ signal })` cuts the wait short. `unbind()` takes no signal, and waits a further
`responseTimeout` for its own response.

**Sends and the link.**

- A send issued while the link is down waits for the reconnect and goes out once the new link is
  bound, up to `responseTimeout`, after which it gives up having sent nothing.
- A request already on the wire when the link drops, when the peer fails to answer in time, or when
  you abort it, fails and counts in `unanswered`: the SMSC may have taken it and lost only the
  response.
- With `reconnect: false` a drop ends the session, and every send after it is refused.
- `sms.sendResp()` on a message whose link dropped writes nothing and returns `err`, since a response
  carries the sequence number of the link it arrived on. `sms.sendDlr()` still goes out on the new
  link.
- `responseTimeout` bounds the wait for a link and the wait for an answer separately, and the wait
  for a `maxOutstanding` slot is unbounded, so it is not a deadline. For a deadline pass
  `{ signal: AbortSignal.timeout(ms) }`: it cuts all three waits short, and a send it stops before
  anything reached the socket adds nothing to `unanswered`. A message with more segments than slots
  goes out a slot at a time, so a deadline that expires mid-message is how you get a partial failure.
- There is no throughput limit. An operator's rate limit is per account, across every process bound
  to it, so enforce it outside this library. `ESME_RTHROTTLED` reaches you as a send's `err`.

**Raw commands.** `send()` reaches all 33 SMPP commands, not just the four the session handles itself:

```javascript
const { err, pduObj } = await session.send({
	cmdName: 'query_sm',
	params: { message_id: smsId },
});
```

**The peer.**

- `acceptsOptionalParams()`: whether the peer declared SMPP 3.4 or later, the version from which
  optional parameters may be sent to it. The library's own senders check it before attaching a TLV;
  a `send()` you build is passed through as written, so check it yourself.
- `peerInterfaceVersion`: the version the peer declared, `0x00` if none.
- `bindAllows(cmdName)` and `boundAs`: what the bind direction carries: [Bind direction](#bind-direction).

## Receiving in depth

- **Multipart.** Segments tied together by a user data header, or by the `sar_msg_ref_num`,
  `sar_total_segments` and `sar_segment_seqnum` TLVs, reassemble into one `sms` alike. A PDU carrying
  both is read from the header. The two reference numbers are separate counters: the same number in
  each is two messages.
- **Answered on arrival.** Each segment was answered as it landed, before you see the message:
  [Server in depth](#server-in-depth).
- **Where the body is.** A body in the `message_payload` TLV, SMPP's way of carrying up to 64 KB and
  the only place a `data_sm` has, reads exactly like one in `short_message`, concatenated messages
  and receipts included. A PDU filling both is read from `short_message`.
- **`data_sm`.** A client reads an inbound `data_sm` as a delivery: a message arrives as `sms`, a
  receipt as `dlr`. A `server()` session reads it as a submission and always emits `sms`. Either way
  it is answered `data_sm_resp`.
- **Flash.** `sms.flash` is true where `data_coding` carries GSM 03.38 message class 0, in every
  coding group that carries one: `0x10`, `0x18`, `0x50` and `0xF0` alike. Classes 1 to 3 name where
  the handset stores the message and are not flash.
- **Binary.** A message whose `data_coding` says 8-bit binary arrives as Latin-1:
  `Buffer.from(sms.message, 'latin1')` gives the original octets.

### Delivery receipts

Receipts travel on the same command as messages but reach you as `dlr`, one per segment. What marks
one: `esm_class`; where that names no type, a `receipted_message_id` TLV; failing both, `id:` and
`stat:` in the body. The body is read as text whatever `data_coding` the receipt declares, since
SMSCs commonly copy the reported message's onto it. An intermediate delivery notification is a report
too, never an inbound message.

| `Dlr` field | |
| --- | --- |
| `smsId` | The id reported on. `undefined` where the receipt carries no readable id. |
| `statusMsg` | `DELIVERED`, `UNDELIVERABLE`, `EXPIRED`, `REJECTED`, `DELETED`, `ACCEPTED`, `UNKNOWN`, `ENROUTE`, `SCHEDULED` or `SKIPPED`. `stat:FAILED`, which several operators write and SMPP does not define, reads as `UNDELIVERABLE`. |
| `statusId` | The numeric `message_state`. Where the peer sent one this library cannot name, its raw value, with `statusMsg` from the body or `UNKNOWN`. |
| `intermediate` | The report is not final: marked an intermediate notification, or reporting `ENROUTE` or `SCHEDULED`. |
| `receipt` | The receipt text parsed: `id`, `sub`, `dlvrd`, `submitDate`, `doneDate`, `stat` as the SMSC wrote it, `err` and `text`. |
| `doneDate`, `errorCode` | The `done date:` field as a `Date`, and the `err:` field. |

**Matching a receipt to a send** means comparing `dlr.smsId` with the `smsIds` from `sendSms()`.
Some SMSCs write the two in different notations, a hex `message_id` on the `submit_sm_resp` and a
decimal `id:` in the receipt, or one of them zero-padded, and the comparison then matches nothing.
Name each notation and both are read into plain decimal:

```javascript
const { err, session } = await client({ smsIdFormat: { receipt: 'decimal', submitResp: 'hex' } });
```

`receipt` is the notation of the body's `id:`; `submitResp` that of the `message_id` in
`submit_sm_resp` and of the `receipted_message_id` TLV, which carries that same id. An id that is not
a number in the notation named is left as it arrived. The PDUs carry what the peer wrote either way:
`pduObjs` from the send, and the `dlr` event's second argument.

**`messageDlr`** fires once every segment of a long message sent with `dlr: true` has a final report,
carrying the worst status of the segments and each of them under `segments`. An `intermediate`
report never counts. Merging needs the SMSC to number its segment ids `<base>-<n>`, this library's
own server's convention; an SMSC that hands out unrelated ids per segment never fires it. A base is
merged once: a later message the SMSC gives the same ids is reported through `dlr` alone, and an
earlier one still collecting loses its merged report.

## Server in depth

**Multipart is answered on arrival.** Each segment is answered as it lands, because a relaying SMSC
will not send the next until the last is answered. The answer is `ESME_ROK`, unless the segment
numbers itself into no message this session can join, which refuses it, or the reassembly buffer is
full, which asks the SMSC to keep it and try again. `sms.answeredOnArrival` says whether the message
you hold was answered that way; a segment count cannot, since a peer may number a message one part
of one.

- The id was fixed with the first segment, so `sendResp()` there only says you are done, and
  returns `err` for an `smsId` or a refusing `status`.
- `sms.smsId` is the base. `sendDlr()` names `<smsId>-1`, `<smsId>-2` and so on: the ids the
  `submit_sm` responses carried.
- A `deliver_sm` is answered with no id at all, since SMPP marks that field unused, so an inbound
  message's base is a handle of your own only.

**Refusing a request** for a reason in the request rather than the message (a full queue, an unknown
recipient, an unauthorised sender) has to land before a segment is answered. `onRequest` runs on
every request a bound peer sends, before reassembly and before the `sms` event:

```javascript
import { isCommand, server } from '@larvit/smpp';

const knownRecipients = new Set(['46709771337']);

const { err } = await server({
	onRequest: async (session, pduObj) => {
		if (!isCommand(pduObj, 'submit_sm') || knownRecipients.has(pduObj.params.destination_addr)) {
			return false;
		}

		await session.sendReturn(pduObj, 'ESME_RINVDSTADR');

		return true;
	},
});
if (err) throw err;
```

- Return `true`: the hook answered the PDU and the library leaves it alone. `false`: the built-in
  handling runs.
- Every segment of a long message is a request of its own, so the hook sees each one.
- No bind reaches it, nor anything a peer sends before one: `server()` answers those and runs
  `authenticate` itself.
- A hook that throws or rejects reaches `sessionError`, and nothing is written for that request;
  the peer's own response timeout settles it. `authenticate` fails the same way, leaving the bind
  unanswered.
- `enquire_link` and `unbind` reach the hook too, and an unanswered `enquire_link` has the peer drop
  the link. Guard on the command name, as above, and a failing hook costs only its own request.
- A `Session` you construct yourself takes the same hook as a session option, and that is where a
  peer's bind gets accepted, since a hand-wired session has no bind handling of its own.

**`sendDlr()`** takes `SCHEDULED`, `ENROUTE`, `DELIVERED`, `EXPIRED`, `DELETED`, `UNDELIVERABLE`,
`ACCEPTED`, `UNKNOWN`, `REJECTED` or `SKIPPED`. The first two go out as intermediate delivery
notifications (`esm_class` 0x20), the rest as delivery receipts (0x04).

### Bind direction

The three bind types are honoured in both directions, whichever end of the link the session is:

- `session.sendSms()` on a receiver-bound session, and `sms.sendDlr()` to a transmitter-bound peer,
  return `err` before anything reaches the wire.
- A `submit_sm` arriving on a receiver-bound session, or a `deliver_sm` on a transmitter-bound one,
  is answered `ESME_RINVBNDSTS`.
- `data_sm` carries a message either way, so which end the session is decides: a client refuses one
  on a transmitter bind, a `server()` session on a receiver bind. `bindAllows('data_sm')` answers for
  the inbound direction. A `Session` you construct yourself is the ESME end, as `client()` builds;
  a hand-wired SMSC sets `session.linkEnd = 'smsc'`, as `server()` does.
- `transceiver`, the default, carries both. `session.send()` is a passthrough and is not checked.

## Logging

`log` takes any object with `debug`, `error`, `info`, `verbose` and `warn` methods, each
`(msg: string, metadata?: Record<string, boolean | number | string>) => void`. Message strings are
static; every dynamic value is in the metadata, so entries group by message.

[`@larvit/log`](https://www.npmjs.com/package/@larvit/log) implements it as it stands:

```javascript
import { Log } from '@larvit/log';
import { client } from '@larvit/smpp';

const { err, session } = await client({ log: new Log('debug') });
```

So does an object of your own:

```javascript
const log = {
	debug:   () => undefined,
	error:   (msg, metadata) => { console.error(msg, metadata); },
	info:    (msg, metadata) => { console.info(msg, metadata); },
	verbose: () => undefined,
	warn:    (msg, metadata) => { console.warn(msg, metadata); },
};
```

`SmppLog` is the type.

## PDUs and the low-level API

The codec is exported, synchronous, and never throws:

```javascript
import { isCommand, objToPdu, pduToObj } from '@larvit/smpp';

const { err, pduObj } = pduToObj(buffer);
if (err) return;

if (isCommand(pduObj, 'submit_sm')) {
	pduObj.params.destination_addr; // typed as a string
}
```

**Reading.**

- `params.short_message` is decoded with the PDU's own `data_coding`; `shortMessageOctets` is that
  field as it arrived. Neither holds a body carried in the `message_payload` TLV, which a `data_sm`
  always uses.
- `messageOctets(pduObj)` is the one answer to which of the two the peer used, undecoded.
  `decodeMessage(octets, pduObj.params.data_coding, pduObj.params.esm_class)` turns them into text
  and hands back the UDH where the PDU carries one.
- `concatOf(pduObj)`: the `part`, `total` and `reference` a PDU declares and the `spelling` that
  carried them, `'udh'` or `'sar'`, or `undefined` for a whole message.
- `messageClassOf(dataCoding)`: `0` for the flash class, `1`, `2` and `3` for the ME-, SIM- and
  TE-specific ones, `undefined` where that `data_coding`'s coding group carries no class.

**Building.**

- A string `short_message` or `message_payload` is encoded in the alphabet the PDU's `data_coding`
  names, detected from the text where you name none. One that alphabet cannot carry is refused,
  naming the character, its code point and where it is.
- A `Buffer` goes out exactly as given under any `data_coding`: binary payloads, hand-built user
  data headers, deliberately malformed bodies.
- `session.send()` and `session.sendReturn()` build through the same codec and refuse the same bodies.
- `unencodable(message, encoding)`: `{ char, index }` for the first character an alphabet cannot
  carry, `undefined` where it carries them all. The check `sendSms()` makes before encoding.
- `dataCodingByEncoding[encoding]`: the `data_coding` this library writes each alphabet under, which
  is what to put beside octets from `encodeMessage()`.
- `smppTime.encode(value)` returns `{ err, text }` for a `validity_period` or
  `schedule_delivery_time`; `smppTime.decode(text)` returns `{ err, date }`.

**Everything exported.**

| | |
| --- | --- |
| Sessions | `client`, `server`, `Session`, `SmppServer` |
| Codec | `pduToObj`, `objToPdu`, `pduReturn`, `isCommand`, `isResp`, `PduFramer`, `PduRefusedError`, `maxPduLength`, `maxSeqNr` |
| Messages | `encodeMessage`, `decodeMessage`, `splitMessage`, `bitCount`, `messageOctets`, `concatOf`, `concatInfo`, `detect`, `unencodable`, `messageClassOf`, `dataCodingByEncoding`, `encodingByDataCoding` |
| Receipts | `dlrFromPdu`, `parseReceipt`, `receiptCodes` |
| Time and ids | `smppDate`, `smppTime`, `uuidv7` |
| Spec tables | `cmds`, `consts`, `encodings`, `errors`, `tlvs`, `types`, the `cmdsById`, `constsById`, `errorsById` and `tlvsById` maps, and all of them grouped as `defs`. `isCommandName`, `isErrorName`, `isEncodingName`, `commandNameById` and `errorNameById` narrow a value into them. |
| Types | Every option, result, event payload and table entry has a named type: `ClientOptions`, `ServerOptions`, `SendSmsOptions`, `SendSmsResult`, `Sms`, `Dlr`, `MessageDlr`, `Receipt`, `PduObject`, `PduHeader`, `SmppLog`, `Result` and the rest in `dist/index.d.ts`. |

## Migrating from larvitsmpp 0.4.0

See [MIGRATION.md](https://gitea.larvit.se/larvit/smpp-js/src/branch/main/MIGRATION.md).

## Development

Everything runs in the container; nothing is installed on the host.

```bash
docker compose run --rm node npm install
docker compose run --rm node npm test                # lint, typecheck and tests
docker compose run --rm node npm run build
docker compose run --rm node npm run test:compiled   # what CI runs on older Node versions
```

Tests are TypeScript and run directly under Node's type stripping, so there is no build step in the
development loop. CI compiles them and runs them on Node 18, every LTS above it, and current.

## License

MIT
