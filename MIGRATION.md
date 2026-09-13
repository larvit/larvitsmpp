# Migrating from larvitsmpp 0.4.0

`@larvit/smpp` 1.0.0 succeeds [larvitsmpp](https://www.npmjs.com/package/larvitsmpp) 0.4.0. The
shape is the same, connect, send, listen for delivery reports, with callbacks replaced by promises.

## API changes

- **The package is `@larvit/smpp`** and ESM only. `require()` no longer works.
- **Callbacks are gone.** `client`, `server`, `sendSms`, `sendResp`, `sendDlr`, `unbind` and
  `session.close` are promises resolving to a result with an optional `err`. Nothing rejects. Await
  `close()`, or the socket outlives the call.
- **`server()` resolves once, when it is listening**, with a handle carrying `close()`, `port` and
  a `session` event. It no longer calls back once per connection.
- **The id a message is answered with goes to `sendResp({ smsId })`.** `sms.smsId` is read-only: the
  id the segments were answered with, the id `sendResp()` was given, or the generated UUID v7.
  Assigning to it throws a `TypeError`, since modules are strict mode.
- **`smsIds` from `sendSms()` is `(string | undefined)[]`**, one entry per segment, positional with
  `pduObjs`, `undefined` where the SMSC took the segment without naming an id.
- **`checkuserpass` is `authenticate`**, takes `{ password, session, systemId, systemType }` and
  returns `false` or `{ userData }`.
- **Renamed options:** `enqLinkTiming` → `enquireLinkInterval`, server `timeout` → `idleTimeout`.
- **`larvitsmpp.utils` is gone.** Its contents are named exports: `bitCount`, `decodeMessage`,
  `encodeMessage`, `objToPdu`, `pduReturn`, `pduToObj`, `smppDate`, `smppTime`, `splitMessage`. The
  codec is synchronous and returns `{ err, pduObj }` / `{ err, buffer }`.
- **`pduObj.isResp()` is the standalone `isResp(pduObj)`.** `pduObj.cmdStatus` is `undefined` for
  a status code the library does not know, with the raw number in `pduObj.cmdStatusId`.
- **`defs.filters` is gone.** It was declared on every command and TLV and never invoked. SMPP time
  formatting, the one part worth keeping, is `smppTime`.
- **`DATAGRAM`, `FORWARD` and `STORE_FORWARD` moved from `consts.ESM_CLASS` to
  `consts.MESSAGING_MODE`**, which also names `SMSC_DEFAULT`. They are bits 1-0 of `esm_class`, not
  whole values of it. Read them from the new group, or pass `messagingMode` to `sendSms()`. A stale
  `consts.ESM_CLASS.STORE_FORWARD` reads `undefined`, which OR-s into an `esm_class` carrying no mode.
- **The `error` event is `sessionError`**, and `serverError` on the server handle.
- **`log`** takes any object with `debug`, `error`, `info`, `verbose` and `warn` methods instead of
  a `larvitutils` one, and is silent by default: [README](README.md#logging).
- **`consts.ENCODING.ASCII` is gone**; the same entry is `consts.ENCODING.IA5`, the other name SMPP
  3.4 5.2.19 gives 0x01. `dataCodingByEncoding` is the alphabet `sendSms()` writes, which is 0x00.

## Behaviour that changed on the wire

0.4.0 had protocol defects. Fixing them changes the bytes on the wire, so remove any workaround you
have for these:

- Every multipart segment was one character short (152 GSM characters instead of 153, 66 UCS2
  instead of 67), so long messages were split into more segments than necessary, each one billed.
- LATIN1 (`data_coding` 0x03) was silently decoded as ASCII, corrupting the message.
- Delivery receipt dates were a month off, and the status field read `UNDELIVERABLE` where the spec
  defines the 7-character `UNDELIV`.
- Every receipt went out as `esm_class` 0x04, the report of a message's final state. A receipt for a
  transient state, `sendDlr('ENROUTE')`, is now marked 0x20, the intermediate delivery notification.
- `flash: true` discarded UCS2, mangling flash messages with non-GSM characters, and put the GSM
  alphabet on a Latin-1 message that has no `data_coding` at all; that pair is refused now. Inbound,
  only a `data_coding` of exactly 0x10 counted as flash, so a flash UCS2 message and the whole 0xF0
  coding group arrived as ordinary messages.
- A GSM 03.38 message declared `data_coding` 0x01, which SMPP 3.4 5.2.19 defines as IA5, so `$` and
  `@` reached a peer honouring the field as STX and NUL. It goes out as 0x00, the SMSC default
  alphabet, and so does a receipt `sendDlr()` writes. Latin-1 and UCS2 stay at 0x03 and 0x08, and an
  inbound 0x01 is still read as GSM 03.38.
- The multipart reference counter was shared by every session in the process.
- `tls: true` never performed a handshake, so the connection was not encrypted.
- Alphanumeric senders were sent with TON 1 (international) instead of TON 5.
- Delivery receipts carrying only the standard receipt text, with no TLVs, what Kannel and several
  other SMSCs send, were rejected outright. They are parsed now.
- A message whose last octet was `0x00` was allocated one octet short while `sm_length` reported the
  full length, so it went out corrupt. In UCS2 that is any message ending in a character like 一
  (U+4E00), routine for CJK text.
- Every response carried a `message_id`, `deliver_sm_resp` included, where SMPP 3.4 4.6.2 makes that
  field unused and NULL. Jasmin closes the connection on one. Answering an inbound message now puts
  nothing in it, and `sms.smsId` is the local handle it always was.
- Binary TLVs (`message_payload`, `network_error_code`, `callback_num` and the rest) were parsed into
  a hex string and written back as the ASCII of that string, so every round trip corrupted them.
  They are `Buffer`s in both directions now; drop any hex encoding of your own.
- A body carried in the `message_payload` TLV was ignored, so the message arrived empty, and a
  `data_sm` was answered `ESME_RINVCMDID`, so a receipt thrown on one was lost silently. Both reach
  the application now: a receipt as `dlr`, answered for you, and a message as `sms` for you to answer.
- A long message segmented by the `sar_msg_ref_num`, `sar_total_segments` and `sar_segment_seqnum`
  TLVs rather than a user data header was never reassembled, so each segment arrived as its own
  message. Both spellings reassemble now.
- Short or malformed PDUs threw out of the codec instead of being reported as a parse failure.
- A PDU whose optional parameters do not end exactly on `command_length` is refused with
  `ESME_RINVTLVSTREAM` and dropped, where 0.4.0 kept the TLVs it had read and ignored the octets
  left over, losing the `receipted_message_id` that makes a receipt a receipt. The refusal reaches
  `sessionError` as a `PduRefusedError` with `reason` `tlvs`.
- Binds declare `interface_version` 0x34. 0.4.0 declared 0x00, which tells the SMSC the ESME speaks
  SMPP 3.3 or earlier, and a spec-following SMSC then withholds every optional parameter, the TLVs
  delivery receipts are carried in included.
- A response reporting a failure carries no body, as the spec defines. 0.4.0 filled the body with
  empty defaults, so a refused `submit_sm_resp` went out with an empty `message_id` a caller could
  mistake for a real one.
- `submit_multi` was missing its `sm_length` field, so its `short_message` never round-tripped.

The corrected framing is cross-checked against [node-smpp](https://github.com/farhadi/node-smpp), an
independent implementation, in both directions and over a live session.
