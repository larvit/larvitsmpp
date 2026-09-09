# @larvit/smpp

A simplified implementation of the SMPP protocol, in TypeScript. ESM only, types included.

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
| `idleTimeout` | `2 × enquireLinkInterval` | Give up on a link the peer has stopped answering, and re-bind unless `reconnect` is `false`. |
| `responseTimeout` | `30000` | How long to wait for a response before giving up on it, and how long a send with no link waits for the next one; `0` waits forever. |
| `shutdownTimeout` | `5000` | How long `close()` and `unbind()` wait for the requests this end already sent and the messages the application has not answered. `0` waits forever for the requests, which end when the peer answers or `responseTimeout` expires — so setting both to `0` never ends. The messages fall back to `responseTimeout`, or to its default where that is `0` too, since nothing but the application ends that wait. |
| `maxOutstanding` | `10` | Requests allowed on the wire at once; further sends queue. |
| `smsIdFormat` | — | The notation the SMSC writes message ids in, per place it writes them: `{ receipt: 'decimal', submitResp: 'hex' }`. Only needed where the two disagree. |
| `reconnect` | on | Re-binds after a drop, an idle timeout, or a stream the library cannot frame, backing off from `minDelay` 1 s to `maxDelay` 30 s and starting over at `minDelay` once a link has lasted `maxDelay`. `{ minDelay, maxDelay }` retunes it; `false` turns it off, so a drop ends the session; `{ fromStart: true }` retries the first connect and bind too — see below. |
| `log` | silent | Any object with `debug`, `error`, `info`, `verbose` and `warn` methods — see [Logging](#logging). |
| `signal` | — | An `AbortSignal` that cancels connecting and tears the session down. |

`reconnect: { fromStart: true }` puts the very first connect and bind through that same loop, so a
client started while its SMSC is down keeps retrying — a bind the SMSC refuses included — instead of
failing on the first attempt. `client()` then resolves once it is bound, and nothing but an aborted
`signal` ends the wait, however long the SMSC stays down. That signal also closes the session once it
is bound, so write a deadline for the wait as an `AbortController` you stop arming when `client()`
returns, rather than as `AbortSignal.timeout(ms)`, which would close the session it just bound.

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
	messagingMode:        'SMSC_DEFAULT', // or DATAGRAM or STORE_FORWARD
	scheduleDeliveryTime: new Date(Date.now() + 3600_000),
	sourceAddrNpi:        0,           // override the numbering plan of the sender
	sourceAddrTon:        5,
	to:                   '46709771337',
	validityPeriod:       3600,        // seconds, or a Date
}, { signal });                       // optional per-call AbortSignal
```

`sourceAddrTon` and `destinationAddrTon` default to 5 for an alphanumeric address and 1 for a
numeric one; the NPI fields default to 0. Set them for an operator that requires something else.

`messagingMode` names the `esm_class` messaging mode: `SMSC_DEFAULT`, which is what an omitted option
sends, or `DATAGRAM` or `STORE_FORWARD`. Every segment of a long message carries the user data header
indicator beside it, so an operator that requires `esm_class` 0x43 on a concatenated message gets
exactly that from `STORE_FORWARD`. SMPP carries transaction mode on `data_sm`, which this never
sends, so reach for one of the three above rather than `consts.MESSAGING_MODE.FORWARD`. Datagram mode
defines the delivery report away, so pair it with `dlr: true` and the send is refused rather than
leaving you waiting for a report that cannot come — as is any value naming no mode, both before a
segment goes out.

`flash` asks for GSM 03.38 message class 0, the class a handset shows on arrival instead of storing.
It travels in `data_coding` beside the alphabet, so a flash UCS2 message stays UCS2. Pairing it with
`encoding: 'LATIN1'` is the one combination with nowhere to go — no `data_coding` carries a message
class beside that alphabet — and the send is refused before anything goes out.

Messages too long for one SMS are split automatically and sent as a concatenated message. You get
one id per segment:

```javascript
const { err, pduObjs, smsIds, unanswered } = await session.sendSms({ from, message, to });
```

`smsIds` is positional with `pduObjs`, and an entry is empty where the SMSC accepted the segment
without naming an id for it — some name one for the first segment only. No receipt ever matches an
empty entry.

`err` is set when the SMSC refuses a segment, and it names the status it refused with. Because every
segment goes on the wire together, `pduObjs` and `smsIds` then hold what the SMSC did accept — enough
to reconcile against a later receipt, not enough to resend the rest, so treat a partial failure as a
failed message. `unanswered` counts the segments that went out and were never answered: the SMSC may
have taken each of them and lost only the response, so a message with `unanswered` above zero cannot
be sent again without risking a duplicate, however empty `smsIds` is. A message needing more than 255
segments is refused before anything is sent, since the concatenation header numbers segments in a
single octet. `maxSegments` lowers that ceiling:
most handsets and SMSCs stop well short of 255, and refusing beats a message only half delivered.

### Receiving

A `receiver` or `transceiver` client gets mobile-originated messages as `sms` events — the same
handle the server side gets, answered the same way. That includes a multipart message: it was
already answered segment by segment before you see it, which changes what `sendResp()` does there —
see [Server](#server).

```javascript
session.on('sms', async sms => {
	// sms.from, sms.to, sms.message
	await sms.sendResp();
});
```

`sms.flash` is true where the message's `data_coding` carries GSM 03.38 message class 0, in either
coding group that carries a class — so `0x10`, `0x18` and `0xF0` alike. The other three classes name
where the handset stores the message rather than that it displays it, so they are not flash;
`messageClassOf(dataCoding)` gives back whichever class a `data_coding` carries, or `undefined` where
its coding group carries none.

Delivery receipts travel on the same SMPP command but reach you as `dlr`, so nothing you write has
to tell the two apart. `esm_class` is what tells them apart; where it names no message type a
`receipted_message_id` TLV does, and failing both the message body is read for the standard
`id:` and `stat:` receipt fields. That body is read as text whatever `data_coding` the receipt
declares, since SMSCs commonly copy the reported message's onto it. An intermediate delivery
notification is the SMSC reporting as well, not an inbound message. `stat:FAILED`, which several
operators write and SMPP does not define, reads as `UNDELIVERABLE`; `dlr.receipt.stat` carries the
code the SMSC wrote.

Where the body sits, and which command carried it, changes none of that. An SMSC that leaves
`sm_length` 0 and puts the body in the `message_payload` TLV — SMPP's way of carrying up to 64 KB,
and the only place a `data_sm` has for one — reads exactly like one that fills `short_message`,
concatenated messages and receipts included. A peer that fills both is read from `short_message`.
`data_sm` itself is a peer of both `deliver_sm` and `submit_sm`, and its direction says which: a
client reads one as a delivery, so a message on it arrives as `sms` and a receipt as `dlr`, while a
`server()` session reads one as the submission it is and always hands it to you as `sms`. Either
way it is answered `data_sm_resp`.

Nor does the way a peer ties a long message's segments together. A user data header at the start of
the body and the `sar_msg_ref_num`, `sar_total_segments` and `sar_segment_seqnum` TLVs are the two
spellings of the same thing, and either reassembles into one `sms`. A header that numbers the
segment is what a PDU carrying both is read from, and the two reference numbers are counters of
their own — the same number in each is two different messages.

Matching a receipt to a send means comparing `dlr.smsId` against the `smsIds` that `sendSms()`
returned. Some SMSCs write the two in different notations — a hex `message_id` on the
`submit_sm_resp` and a decimal `id:` in the receipt, or one of them zero-padded — and the comparison
then quietly matches nothing at all. Name each notation and both ids are read into plain decimal
before you see them:

```javascript
const { err, session } = await client({ smsIdFormat: { receipt: 'decimal', submitResp: 'hex' } });
```

`receipt` is the notation of the receipt body's `id:` field, `submitResp` that of the `message_id`
a `submit_sm_resp` carries — and of a receipt's `receipted_message_id` TLV, which is that same id.
An id that is not a number in the notation given is left exactly as it arrived, and the PDUs carry
what the peer wrote either way — `pduObjs` from the send, and the second argument of the `dlr` event.

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

A message that arrived in several segments was already answered when you see it: each segment is
answered as it lands, because a relaying SMSC will not send the next one until the last is answered.
That answer is `ESME_ROK` unless the segment numbers itself into no message this session can join,
which refuses it, or the reassembly buffer is full, which asks the SMSC to keep it and try again.
`sms.answeredOnArrival` says whether the message you are holding was answered that way — a segment count cannot, since a peer
may number a concatenated message one part of one. The id was fixed with the first segment, so
`sendResp()` there only says you are done with the message, and returns an `err` for an `smsId` or a
refusing `status`; choosing the id and refusing the message belong to a message `sendResp()` still
answers itself. `sms.smsId` is the base either way, and `sendDlr()` names `<smsId>-1`, `<smsId>-2`
and so on — the ids a `submit_sm`'s responses carried. A `deliver_sm` is answered with no id at all,
since SMPP marks that field unused, so an inbound message's base is a handle of your own only.

A refusal that depends on the request rather than the reassembled message — a full queue, an unknown
recipient, an unauthorised sender — needs to land before a segment is answered, which `sendResp()`
can no longer do once it has. `onRequest` decides there instead, on every request a bound peer
sends, before reassembly and before the `sms` event:

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

Returning `true` means the hook has answered the PDU and the library leaves it alone; `false` lets
the built-in handling — reassembly, the `sms` event — run as usual. Every segment of a concatenated
message is a request of its own, so the hook sees each one while refusing it still means something.
No bind reaches it, and neither does anything a peer sends before one: `server()` answers those and
runs `authenticate` itself, so a hook cannot intercept a bind however it is written.

A hook that throws or rejects reaches `sessionError`, and nothing else is written for that request:
the library cannot tell a hook that failed before answering from one that failed after, and a second
response on the peer's sequence number would be worse than none. The peer's own response timeout
settles it, so a hook that must reach a decision either way makes that decision itself.
`authenticate` fails the same way, leaving the bind itself unanswered.

`enquire_link` and `unbind` reach the hook too, where failing costs more than the one request a
response timeout settles: an unanswered `enquire_link` has the peer drop the link at its own idle
timer, and an unanswered `unbind` skips the close this end would have run on it. Guard on the
command name, as the example above does, and a hook that fails takes nothing but its own request
with it.

A `Session` you construct yourself (see [Bind direction](#bind-direction)) takes the same hook as a
session option, and handles a failing one the same way; it is also where a peer's bind gets accepted,
since a hand-wired session has no bind handling of its own.

`sendDlr` accepts `SCHEDULED`, `ENROUTE`, `DELIVERED`, `EXPIRED`, `DELETED`, `UNDELIVERABLE`,
`ACCEPTED`, `UNKNOWN`, `REJECTED` and `SKIPPED`. `SCHEDULED` and `ENROUTE` go out as intermediate
delivery notifications (`esm_class` 0x20), the rest as delivery receipts (0x04).

A message whose `data_coding` says 8-bit binary arrives as Latin-1, so `Buffer.from(sms.message,
'latin1')` gives you back the original octets.

### Server options

| Option | Default | |
| --- | --- | --- |
| `host` / `port` | all interfaces / `2775` | Where to listen. Pass `0` for any free port. |
| `authenticate` | accept everything | `({ password, session, systemId, systemType }) => false \| { userData }`, sync or async. |
| `onRequest` | none | `(session, pduObj) => true \| false`, sync or async. First refusal on every request a bound peer sends; no bind, and nothing before one, reaches it. |
| `systemId` | `''` | The SMSC identity returned to the ESME in the bind response. |
| `interfaceVersion` | `0x34` | The SMPP version advertised in the bind response. The floor for sending a peer optional parameters stays `0x34`, whatever this is set to. |
| `tls` | `false` | A `tls.TlsOptions` object with your certificate and key. |
| `idleTimeout` | `40000` | Drop a peer that has been silent this long. |
| `maxReassembly` | `1000` | Incomplete multipart messages held per session. |
| `maxOctets` | `67108864` | Bytes of incomplete multipart messages held per session. |
| `reassemblyTimeout` | `300000` | How long a late segment can still join an incomplete message. |
| `responseTimeout`, `shutdownTimeout`, `maxOutstanding`, `log`, `signal` | as for the client | |

### Bind direction

The three bind types are honoured in both directions, not just accepted. A receiver-bound ESME
carries no `submit_sm` and a transmitter-bound one is sent no `deliver_sm`, whichever end of the
link the session is:

- `session.sendSms()` on a receiver-bound session, and `sms.sendDlr()` to a transmitter-bound peer,
  fail with an `err` before anything reaches the wire.
- A `submit_sm` arriving on a receiver-bound session, or a `deliver_sm` on a transmitter-bound one,
  is answered `ESME_RINVBNDSTS`.
- A `data_sm` carries a message either way, so which end the session is decides what its bind
  forbids: a client refuses one on a transmitter bind, a `server()` session on a receiver bind.
  `bindAllows('data_sm')` answers for the direction that reaches this session, since the library
  sends none. A `Session` you construct yourself is the ESME end, which is what `client()` builds;
  a hand-wired SMSC sets `session.linkEnd = 'smsc'`, as `server()` does.

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

`sessionError` carries three kinds of failure, and `PduRefusedError` separates the first from the
rest:

- **A PDU the peer sent that the codec could not read with the stream still in sync.** The link is
  healthy and only that one PDU is lost, so this is the kind to count rather than alert on.
- **A concatenated message given up on before it was whole.** Its arrived segments were answered, so
  the peer will not send them again. Also a counting kind: no `sms` event ever fired for it, so
  there is nothing to act on beyond knowing traffic was lost.
- **Everything else**: the session or the socket failing, and a hook or listener that threw or, if it
  was `async`, rejected.

The last two are both a plain `Error`, told apart from each other by their message text alone, so
the example below alerts on a lost concatenated message as well as on a session that failed.

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

`reason` is `command`, `body` or `tlvs`, naming the part the codec stopped at, and `header` is the 16
octets that did parse: `cmdId`, `cmdLength`, `cmdName`, `cmdStatusId` and `seqNr`. `cmdName` is
undefined where the command id names no command this library knows — `PduHeader` is its type, for a
TypeScript consumer passing it on.

A refused inbound `deliver_sm` is lost traffic: a message or a receipt that never arrives as `sms` or
`dlr`, and this event is where that loss shows up. A refused *response* is reported twice where a
call is still waiting on it, once as the `err` that `sendSms()` or `send()` returns and once here.
That is deliberate: the call answers what became of that one send, and the event is what shows a peer
answering unreadably at all.

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
| `sms` | An SMS arrives, reassembled if it was multipart. Carries `sendResp()`, `sendDlr()` and its `smsId`. A multipart one was answered as its segments arrived — see [Server](#server). |
| `dlr` | A delivery report arrives, one per segment. `intermediate` is true where the report is not final: the SMSC either marked it an intermediate notification, or reported `ENROUTE` or `SCHEDULED`. `smsId` is undefined when the peer marked a receipt whose body carries no readable id. `statusMsg` names `statusId` unless the peer sent a `message_state` this library cannot name — then `statusId` is that raw value and `statusMsg` is whatever the body said, or `UNKNOWN`. |
| `messageDlr` | Every segment of a multipart message sent with `dlr: true` has been reported on, carrying the worst status of the segments. A report carrying `intermediate` never counts towards it. Merging needs the SMSC to number its segment ids `<base>-<n>`, which is this library's own server's convention — an SMSC that hands out unrelated ids per segment never fires it. A base is merged once: a later message the SMSC gives the same ids is reported on through `dlr` alone, and an earlier one still collecting loses its merged report as well. |
| `close` | The session is over, because nothing will bring the link back. Fires once, whether you closed it or the link failed for good. |
| `disconnected` | The link dropped and the reconnect loop will retry it. Do not open a replacement client here — the session you hold comes back on its own, and `reconnected` says when. Fires again for each attempt that reconnects and then fails, so it is not one-to-one with `reconnected`. |
| `reconnected` | The client re-bound after a drop. |
| `sessionError` | Something failed on a live session, including a hook or listener that threw or, if it was `async`, rejected. Fires for each PDU the codec refused as well, carrying a `PduRefusedError` while the link carries on: a refused request is answered with the status SMPP names, and a refused response is answered with nothing and settles the request it named as `unanswered`. [Errors](#errors) names its three kinds, of which `PduRefusedError` separates one. |
| `data` | Raw bytes arrived on the socket. |
| `incomingPdu` | A complete PDU arrived, as a buffer. |
| `incomingPduObj` | The same PDU, parsed into an object. |

### Methods

`sendSms()`, `send()`, `sendReturn()`, `unbind()` and `close()`. Both `close()` and `unbind()`
refuse further sends, wait out the requests this end already sent for up to `shutdownTimeout`, and
then tear down whatever is left, resolving to an `err` that says what was lost. They also wait for
every `sms` still in the application's hands, so a peer whose `submit_sm` is being handled is
answered rather than left to re-send it. That wait ends when `sendResp()` puts the response on the
wire — or, for a message whose segments were answered as they arrived, when it is called at all —
or when every listener that took the message has failed; answering its PDUs through
`sendReturn()` instead leaves the wait running until it gives up. A session holds at most 1000
unanswered messages, five minutes each; what falls out of either bound is dropped with a warning on
the log and waited for no longer. Neither bound is an option. `sendDlr()` is the one send the
refusal lets past, and it catches the wait when issued straight after `sendResp()`; await anything in
between and it races the shutdown like any other send. `close({ signal })` takes an `AbortSignal`
that cuts the wait short; `unbind()` takes none, and waits a further
`responseTimeout` for its own response. `send()` reaches any of the 33 SMPP commands the codec
knows, not just the four the session handles natively:

```javascript
const { err, pduObj } = await session.send({
	cmdName: 'query_sm',
	params: { message_id: smsId },
});
```

A send issued while the link is down waits for the reconnect instead of failing, and goes out once
the new link is bound — up to `responseTimeout`, after which it gives up having sent nothing. A
request already on the wire is the other case: the SMSC may have taken it and lost only the response,
so it fails, and `sendSms()` and `sms.sendDlr()` count it in `unanswered`, whether the link dropped
under it, the peer never answered in time, or you aborted it after it went out. Neither applies with `reconnect: false`,
where a drop ends the session and every send after it is refused.

An answer cannot wait for a link that way, because it carries the sequence number the message arrived
on: `sms.sendResp()` on a message whose link dropped writes nothing and returns an `err`. Where a
reconnect follows, its `sms.sendDlr()` still goes out on the new link, since a receipt is a request
of its own, correlated by the id it names.

`responseTimeout` bounds the wait for a link and the wait for an answer separately, and a send also
queues for a `maxOutstanding` slot, which nothing bounds — so it is not a deadline for the call. Pass
`{ signal: AbortSignal.timeout(ms) }` when you need one: it cuts all three waits short, and a send it
stops before anything reached the socket adds nothing to `unanswered`. A message with more segments
than there are slots goes out a slot at a time and still completes, so a deadline tight enough to
expire mid-message is how you produce the partial failure above.

`acceptsOptionalParams()` answers whether the peer declared SMPP 3.4 or later, which is the version
at and above which the spec allows optional parameters to be sent to it; `peerInterfaceVersion` is
the version it declared, `0x00` if it declared none. The library's own senders consult the first before attaching a TLV — a
`send()` you build yourself is passed through as written, so consult it too when you attach TLVs.

`bindAllows(cmdName)` answers the same question for the bind direction, and `boundAs` is the role
the ESME bound with — see [Bind direction](#bind-direction).

## Beyond the PDU codec

Encoding and decoding PDUs is the easy half of SMPP. The session layer is the half usually written
by hand on top of a library; it is built in here.

| | |
| --- | --- |
| **Keepalive** | `enquire_link` every 20 s on a quiet link, and a peer that stops answering is dropped. |
| **Reconnect with backoff** | A dropped client link reopens the socket and re-binds by default, 1 s doubling to 30 s. |
| **Submit window** | `maxOutstanding` holds requests in flight at 10; further sends queue instead of overrunning the SMSC. |
| **Delivery receipts** | Correlated by `receipted_message_id`/`message_state` where the SMSC sends them, falling back to parsing the receipt text — what Kannel and several others send. |
| **Multipart** | Long messages split on send; concatenated `deliver_sm` reassembled into one `sms`. |
| **Graceful shutdown** | `close()` and `unbind()` wait out the requests this end already sent and the messages the application has not answered yet, so neither end has to guess whether a message got through. |
| **Never throws** | Everything fallible resolves to `{ err?, … }`, the codec included. |

Throughput throttling is deliberately absent: an operator's rate limit is scoped to the account, and
enforcing it needs state shared across every process bound to that account, which a library holding
everything in memory cannot provide.

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

`params.short_message` is decoded with the PDU's own `data_coding`; `shortMessageOctets` is that
same field exactly as it arrived. Neither holds the body of a PDU that carried it in the
`message_payload` TLV instead, which a `data_sm` always does — `messageOctets(pduObj)` is the one
answer to which of the two the peer used, and gives back the octets undecoded:
`decodeMessage(octets, pduObj.params.data_coding, pduObj.params.esm_class)` turns them into text and
hands back the UDH where the PDU carries one. `concatOf(pduObj)` is the same for concatenation: the
`part`, `total` and `reference` a PDU declares, and the `spelling` — `'udh'` or `'sar'` — that
carried them, or `undefined` where the PDU is a whole message.

The spec tables are exported both individually (`cmds`, `consts`, `encodings`, `errors`, `tlvs`,
`types`, and the matching `*ById` maps) and grouped as `defs`.

## Migrating from larvitsmpp 0.4.0

Successor to [larvitsmpp](https://www.npmjs.com/package/larvitsmpp) 0.4.0. The API is the same shape
it has always been — connect, send an SMS, listen for delivery reports — with callbacks replaced by
promises and the rough edges taken off.

- **The package is now `@larvit/smpp`** and is ESM only. `require()` no longer works.
- **Callbacks are gone.** `client`, `server`, `sendSms`, `sendResp`, `sendDlr`, `unbind` and
  `session.close` are all promises resolving to a result object with an optional `err`. Nothing
  rejects. Await `close()` or the socket outlives the call.
- **`server()` resolves once, when it is listening**, and gives you a handle with `close()`, `port`
  and a `session` event. It no longer calls your callback once per incoming connection.
- **The id a message is answered with goes to `sendResp({ smsId })`**, and `sms.smsId` is read-only:
  it reports the id the segments were answered with, the id `sendResp()` was given, or the UUID v7
  generated instead. Delete any `sms.smsId = …` line — assigning to it
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
- **`DATAGRAM`, `FORWARD` and `STORE_FORWARD` moved from `consts.ESM_CLASS` to
  `consts.MESSAGING_MODE`**, which also names the fourth mode, `SMSC_DEFAULT`. They are bits 1-0 of
  `esm_class` rather than whole values of it. Read them from the new group, or let `sendSms()` write
  one for you as `messagingMode`; a stale `consts.ESM_CLASS.STORE_FORWARD` now reads `undefined`,
  which OR-s into an `esm_class` that silently carries no mode at all.
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
- Every receipt went out as `esm_class` 0x04, which SMPP 3.4 defines as the report of a message's
  final state. A receipt for a transient state — `sendDlr('ENROUTE')` — is now marked 0x20, the
  intermediate delivery notification.
- `flash: true` discarded UCS2, mangling flash messages containing non-GSM characters, and put the
  GSM alphabet on a Latin-1 message that has no `data_coding` at all — that pair is refused now.
  Inbound, only a `data_coding` of exactly 0x10 counted as flash, so a flash UCS2 message and the
  whole 0xF0 coding group arrived as ordinary messages.
- The multipart reference counter was shared by every session in the process.
- `tls: true` never performed a handshake, so the connection was not actually encrypted.
- Alphanumeric senders were sent with TON 1 (international) instead of TON 5.
- Delivery receipts carrying only the standard receipt text, with no TLVs — what Kannel and several
  other SMSCs send — were rejected outright. They are now parsed.
- A message whose last octet was `0x00` was allocated one octet short while `sm_length` still
  reported the full length, so it went out corrupt. In UCS2 that is any message ending in a
  character like 一 (U+4E00), which made the bug routine for CJK text.
- Every response carried a `message_id`, `deliver_sm_resp` included, where SMPP 3.4 4.6.2 makes
  that field unused and NULL. Jasmin closes the connection on one. Answering an inbound message now
  puts nothing in it, and `sms.smsId` is the local handle it always was.
- Binary TLVs (`message_payload`, `network_error_code`, `callback_num` and the rest) were parsed
  into a hex string and written back as the ASCII of that string, so every one that made a round
  trip went out corrupt. They are `Buffer`s in both directions now, so drop any hex encoding of
  your own.
- A body carried in the `message_payload` TLV was ignored, so the message arrived empty, and a
  `data_sm` was answered `ESME_RINVCMDID`, so a receipt thrown on one was lost with nothing said.
  Both reach the application now — a receipt as `dlr`, answered for you, and a message as `sms` for
  you to answer like any other.
- A long message whose segments were tied together by the `sar_msg_ref_num`, `sar_total_segments`
  and `sar_segment_seqnum` TLVs rather than by a user data header was never reassembled, so each
  segment arrived as its own message. Both spellings reassemble now.
- Short or malformed PDUs threw out of the codec instead of being reported as a parse failure.
- A PDU whose optional parameters do not end exactly on `command_length` is refused with
  `ESME_RINVTLVSTREAM` and dropped, where 0.4.0 kept the TLVs it had read and ignored the octets
  left over — which loses the `receipted_message_id` that makes a receipt a receipt. The refusal
  reaches `sessionError` as a `PduRefusedError` with `reason` `tlvs`, which is what to match on
  where a peer's traffic goes missing.
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
