# todo.md

Remaining work for the `@larvit/smpp` 1.0.0 rewrite. Read [AGENTS.md](AGENTS.md) first — the hard
rules there constrain every item below.

## Status

The rewrite is **feature complete and green**: 137 tests, lint and typecheck clean, verified on Node
18, 20, 22 and 24. What is left is release work and a few things worth adding before or after 1.0.0.

```bash
docker compose run --rm node npm install
docker compose run --rm node npm test
```

## The agreed API

Settled with the maintainer before implementation. Do not change any of it without asking. The
public surface is documented in [README.md](README.md); this is the short form.

```ts
import { client, server } from '@larvit/smpp';

const { err, session } = await client({ host, password, port, username });
const { err, pduObjs, smsIds } = await session.sendSms({ dlr, from, message, to });
await session.unbind();

const { err, server: smpp } = await server({ authenticate, port });
smpp.on('session', session => {
	session.on('sms', async sms => {
		await sms.sendResp();
		if (sms.dlr) await sms.sendDlr('DELIVERED');
	});
});
await smpp.close();
```

Rules the API follows:

- **Never throws.** Everything fallible resolves to `{ err?, … }`. See AGENTS.md rule 1.
- **Named exports only**, no default export. `defs` is exported as a group alongside the individual
  tables.
- **The PDU codec is synchronous** and returns `{ err?, pduObj? }` / `{ err?, buffer? }`.
- **Low-level surface stays public**, including `session.sock`, `session.send()` and
  `session.sendReturn()`.

## Done

| | Covered by |
| --- | --- |
| Definition tables: constants, errors, encodings, wire types, TLVs, commands | `test/encodings.test.ts`, `test/types.test.ts`, `test/commands.test.ts` |
| Message helpers: splitting, bit counting, SMPP dates and times | `test/message.test.ts` |
| PDU codec: parse, build, respond, per-command typing, bounds checks | `test/pdu.test.ts` |
| Stream framing | `test/pdu-framer.test.ts` |
| Delivery receipt parsing, TLV and text | `test/dlr.test.ts` |
| Session, client, server: bind, auth, send, reassembly, DLRs, timeouts, abort, send window | `test/session.test.ts` |
| Merged multipart DLRs, reconnect, reassembly bounds, per-send abort | `test/session-extras.test.ts` |
| Cross-checked against node-smpp both ways and over a live session | `test/interop.test.ts` |
| CI on Node 18/20/22/24, Renovate, tag-triggered publish | `.github/workflows/` |

Every defect listed in the AGENTS.md table has a regression test naming the behaviour.

## Before publishing 1.0.0

- [ ] Create the `@larvit/smpp` package on npm and add `NPM_TOKEN` to the repository secrets, which
      `.github/workflows/release.yaml` needs.
- [ ] Tag `v1.0.0` to publish.
- [ ] `npm deprecate larvitsmpp` pointing at `@larvit/smpp`. Maintainer's call to run it; not
      something CI should do.
- [ ] Decide what happens to `master`: this branch is an orphan, so merging it is a deliberate act.

## Worth doing, not blocking

- [ ] **In-flight sends across a reconnect.** They currently fail with "Session closed before a
      response arrived" and the caller retries. Re-queueing them automatically would be friendlier
      but risks duplicate delivery, so it needs a decision before it is built.
- [ ] **The server never returns the `sc_interface_version` TLV.** The 3.4 spec has an ESME read its
      absence from a bind response as "this SMSC does not support optional parameters", and ours
      does send DLR TLVs. Returning it has to be conditional: a peer that declared below 0x34 must
      not be sent optional parameters at all.
- [ ] **TLS is untested.** The code path is right (`tls.connect` / `tls.createServer`, options
      passed through) but no test exercises a handshake. Needs a self-signed certificate fixture.
- [ ] **`submit_multi` and the broadcast commands** encode and decode, but nothing exercises them
      end to end. The interop suite is the natural place.
- [ ] **Move to TypeScript 7** once `typescript-eslint` supports it; `renovate.json` pins TypeScript
      below 6.1 for exactly that reason.
- [ ] **Coverage reporting.** `node --test --experimental-test-coverage` works today; nothing
      publishes the numbers.
