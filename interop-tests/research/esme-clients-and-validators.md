# SMPP ESME clients, load generators, and independent PDU validators — interop-testing `@larvit/smpp`

Research note: this session's shared WebSearch budget (200 calls, spent across parallel research threads on this task) was exhausted partway through. Sections B and C below are fully search-backed. Section A was completed with WebFetch only (direct GitHub API / raw-file / PyPI / crates.io / RubyGems / Hex.pm requests) after the search budget ran out and a parallel research agent covering Go/Erlang/other-language clients was lost to a session rate limit. Where a claim could not be independently re-verified this session, it is marked **unverified** rather than guessed — this hits Kannel hardest (see A18): `kannel.org`'s TLS certificate failed validation on every fetch attempt this session, so its exact config keys could not be re-confirmed against a live primary source.

---

## A. ESME client libraries / tools

### Summary

| # | Library | Language | Licence | Repo | Last activity | Maintained? |
|---|---|---|---|---|---|---|
| A1 | Cloudhopper SMPP | Java | Apache-2.0 per README; GitHub shows `NOASSERTION` | [fizzed/cloudhopper-smpp](https://github.com/fizzed/cloudhopper-smpp) (fork of [twitter-archive/cloudhopper-smpp](https://github.com/twitter-archive/cloudhopper-smpp), archived) | fork: no commits since 2018-10-03, issues triaged to 2026-08-24; original archived 2021-08-18 | Fork only, lightly |
| A2 | jsmpp | Java | Apache-2.0 | [opentelecoms-org/jsmpp](https://github.com/opentelecoms-org/jsmpp) | pushed 2026-06-17, 68 open issues | Yes |
| A3 | OpenSMPP (Logica) | Java | BSD (per README) | [OpenSmpp/opensmpp](https://github.com/OpenSmpp/opensmpp) | pushed 2023-11-01 | Weakly |
| A4 | python-smpplib | Python | LGPL-3.0 | [python-smpplib/python-smpplib](https://github.com/python-smpplib/python-smpplib) | PyPI 2.2.4, 2025-01-17 | Yes |
| A5 | smpp.twisted | Python | LICENSE file present, text unverified | [jookies/smpp.twisted](https://github.com/jookies/smpp.twisted) | 7 commits total | Stable/frozen |
| A6 | smpp.pdu | Python | LICENSE file present, text unverified | [jookies/smpp.pdu](https://github.com/jookies/smpp.pdu) | 7 commits, 2 open issues | Stable/frozen |
| A7 | Jasmin (`smppccm`) | Python/Twisted | `NOASSERTION` on GitHub | [jookies/jasmin](https://github.com/jookies/jasmin) | pushed 2026-04-26 | Yes |
| A8 | fiorix/go-smpp | Go | MIT | [fiorix/go-smpp](https://github.com/fiorix/go-smpp) | pushed 2026-04-25 | Yes |
| A9 | linxGnu/gosmpp | Go | Apache-2.0 | [linxGnu/gosmpp](https://github.com/linxGnu/gosmpp) | pushed 2026-07-13, 21 open issues | Yes |
| A10 | oserl | Erlang | unverified | [archaelus/oserl](https://github.com/archaelus/oserl) | last updated 2009-04-03 | No — frozen, embedded in smppload |
| A11 | libsmpp34 | C | LGPL-2.1 | [osmocom/libsmpp34](https://github.com/osmocom/libsmpp34) | pushed 2026-08-20 | Yes |
| A12 | smpp34 (crate) | Rust | unverified | [crates.io/crates/smpp34](https://crates.io/crates/smpp34) | v1.4.1 on crates.io | unverified |
| A13 | JamaaSMPP | C# | unverified | [AdhamAwadhi/JamaaSMPP](https://github.com/AdhamAwadhi/JamaaSMPP) | pushed 2026-08-18 | Yes |
| A14 | php-smpp | PHP | none declared | [alexandr-mironov/php-smpp](https://github.com/alexandr-mironov/php-smpp) (fork of [OnlineCity/php-smpp](https://github.com/OnlineCity/php-smpp), unmaintained) | fork pushed 2022-12-02 | Weakly |
| A15 | Net::SMPP | Perl | unknown | [metacpan.org/pod/Net::SMPP](https://metacpan.org/pod/Net::SMPP) | v1.19, 2011-06-01 | No |
| A16 | ruby-smpp | Ruby | unverified | [rubygems.org/gems/ruby-smpp](https://rubygems.org/gems/ruby-smpp) | v0.6.0, 108,794 downloads | unverified |
| A17 | smppex | Elixir | unverified | [hex.pm/packages/smppex](https://hex.pm/packages/smppex) | v3.3.0, updated ~2 months ago | Yes |
| A18 | Kannel `bearerbox` (SMPP client) | C | Kannel Software License 1.0 (Apache-1.1-like) | kannel.org — canonical source unreachable this session | unverified this session | unverified this session |

---

### A1. Cloudhopper SMPP
[fizzed/cloudhopper-smpp](https://github.com/fizzed/cloudhopper-smpp) is the maintained fork of Twitter's archived [twitter-archive/cloudhopper-smpp](https://github.com/twitter-archive/cloudhopper-smpp) (archived 2021-08-18). The fork itself has had no new commits since 2018-10-03 but still receives issue triage (last activity 2026-08-24, 24 open issues) — treat as lightly maintained, not actively developed. Netty-based session library.

- **Docker**: no official image. Build from source with Maven inside a JDK image you pin yourself (never guess a tag) — the repo's own instructions run demos via `make client`/`make server` wrapping the Maven build.
- **Bind/send** (from the demo client, [`ClientMain.java`](https://raw.githubusercontent.com/fizzed/cloudhopper-smpp/master/src/test/java/com/cloudhopper/smpp/demo/ClientMain.java)):
  ```java
  config0.setSystemId("1234567890");
  config0.setPassword("password");
  config0.setType(SmppBindType.TRANSCEIVER);
  config0.setWindowSize(1);
  config0.setRequestExpiryTimeout(30000);
  config0.setWindowMonitorInterval(15000);
  SubmitSm submit0 = new SubmitSm();
  submit0.setShortMessage(textBytes);
  session0.submit(submit0, 10000);
  ```
  `systemType`/`interfaceVersion` are not set in the demo (library defaults apply — not confirmed further this session).
- **Encoding**: demo encodes with `CharsetUtil.encode(text160, CharsetUtil.CHARSET_GSM)` for data_coding 0. Packed vs. unpacked septets not confirmed from the demo alone — **unverified**.
- **Long messages**: demo sends a single ≤160-char GSM segment only; no UDH/SAR/message_payload shown — **unverified** whether the library auto-splits.
- **enquire_link**: demo only sends it synchronously on a keypress (`session0.enquireLink(new EnquireLink(), 10000)`); no periodic automatic keepalive demonstrated.
- **Windowing**: first-class — `setWindowSize()`, `setRequestExpiryTimeout()`, `setWindowMonitorInterval()` are real, documented session-config knobs. This is the strongest windowing/backpressure story of any Java client here.
- **Strictness / quirk**: [twitter/cloudhopper-smpp#39](https://github.com/twitter/cloudhopper-smpp/issues/39) — a user reports throughput capped at ~200 msg/s even after raising window size ("window wait time is always zero"), i.e. windowing alone won't reveal a throughput bug if your server's per-PDU response latency dominates. Unresolved, on an archived repo.

### A2. jsmpp
[opentelecoms-org/jsmpp](https://github.com/opentelecoms-org/jsmpp), Apache-2.0, actively maintained (pushed 2026-06-17). README: "supports SMPP v3.3, v3.4 and v5.0" and explicitly "is not a high-level library" — it does not auto-split long messages; the caller owns UDH/SAR/message_payload chunking, which makes it good for controlled wire-level testing.

- **interface_version negotiation** (confirmed directly from [`SMPPSession.java`](https://raw.githubusercontent.com/opentelecoms-org/jsmpp/master/jsmpp/src/main/java/org/jsmpp/session/SMPPSession.java)):
  ```java
  InterfaceVersion commonInterfaceVersion = scVersion != null
      ? InterfaceVersion.IF_50.min(InterfaceVersion.valueOf(scVersion.getValue()))
      : InterfaceVersion.IF_34;
  ```
  If the server's `bind_resp` omits the `sc_interface_version` optional TLV, jsmpp silently assumes 3.4 — it never rejects a bind over a missing/absent TLV. If the TLV **is** present with a value `InterfaceVersion.valueOf()` doesn't recognize, that call is an enum-style lookup that can throw — a server sending a bogus `sc_interface_version` byte is a good way to probe jsmpp-based tooling for a crash vs. graceful handling.
- **Docker**: no official image found — **unverified**; build with Maven/Gradle inside a self-pinned Java image.
- **Long message / encoding**: the bundled `StressClient.java` example hardcodes `DataCodings.ZERO` and calls `submitShortMessage()` directly — no UDH/SAR/message_payload, confirming the library leaves long-message strategy entirely to the caller.
- **enquire_link**: known quirk — [opentelecoms-org/jsmpp#142](https://github.com/opentelecoms-org/jsmpp/issues/142) "Enquire time not respected?" reports the library's enquire-link-interval not firing as configured.
- **Windowing**: no true max-outstanding window found in the stress example (`maxOutstanding` there is a fixed thread-pool size for response processing, not a protocol window) — **unverified** whether the core session API exposes a real window elsewhere.

### A3. OpenSMPP (Logica)
[OpenSmpp/opensmpp](https://github.com/OpenSmpp/opensmpp), Java, pushed 2023-11-01. Per its README: "originally issued under the Logica Open Source License Version 1.0, but was subsequently put in the public domain under the current BSD licence." This is the historical root that much SMPP tooling's PDU model descends from. Related forks found: [cornet/logica-smpp](https://github.com/cornet/logica-smpp) and a companion simulator [cornet/logica-smscsim](https://github.com/cornet/logica-smscsim) (server-side, out of scope here). Bind/send example, Docker packaging, long-message defaults, encoding, and enquire_link behaviour were **not independently re-verified this session** (search budget exhausted before a source read) — mark all operational specifics **unverified**.

### A4. python-smpplib
[python-smpplib/python-smpplib](https://github.com/python-smpplib/python-smpplib), LGPL-3.0 (confirmed via both GitHub API and the [PyPI JSON API](https://pypi.org/pypi/smpplib/json): latest `2.2.4`, released 2025-01-17).

- **Bind**: `client.bind_transmitter(**kwargs)` / `bind_transceiver(**kwargs)` — `system_id`/`password`/`system_type`/`interface_version` all pass through as kwargs into the PDU (confirmed from [`smpplib/client.py`](https://raw.githubusercontent.com/python-smpplib/python-smpplib/master/smpplib/client.py)).
- **Encoding — notable**: [`smpplib/consts.py`](https://raw.githubusercontent.com/python-smpplib/python-smpplib/master/smpplib/consts.py) defines `SMPP_ENCODING_DEFAULT = 0x00`. [`smpplib/gsm.py`](https://raw.githubusercontent.com/python-smpplib/python-smpplib/master/smpplib/gsm.py)'s `gsm_encode()` maps each character to **one unpacked byte** (with `\x1B`-escape for the extension table) rather than packing 8 characters into 7 septet bytes:
  ```python
  def gsm_encode(plaintext):
      return b''.join(
          six.int2byte(index) if index < 0x80 else b'\x1B' + six.int2byte(index - 0x80)
          for index in map(GSM_CHARACTER_TABLE.index, plaintext))
  ```
  **This is a real cross-check opportunity**: if `@larvit/smpp` decodes data_coding 0 as standard packed 7-bit, a raw submit_sm from this client will decode as garbage unless the harness explicitly unpacks/repacks — worth testing deliberately either way.
- **Long messages**: `make_parts_encoded()` in the same file builds UDH concatenation (`\x05\x00\x03` + random ref id + total-parts + this-part), i.e. UDH is the default splitting method, not `sar_*`/`message_payload`.
- **enquire_link**: opt-in and reactive, not a fixed timer — on a socket read timeout, if `auto_send_enquire_link` is set the client sends `enquire_link` instead of raising; otherwise it re-raises the timeout.
- **Docker**: no official image; `python:3.12.14-slim-bookworm` (verified current full-patch tag via [Docker Hub's tag API](https://hub.docker.com/v2/repositories/library/python/tags?name=3.12) as of this research) + `pip install smpplib` is a safe base.

### A5–A6. Jasmin's `smpp.twisted` / `smpp.pdu`
[jookies/smpp.twisted](https://github.com/jookies/smpp.twisted) (Twisted-based SMPP 3.4 client/session engine) and [jookies/smpp.pdu](https://github.com/jookies/smpp.pdu) (the PDU encode/decode layer underneath it) are Jasmin's internal SMPP engine, each with only 7 commits on `master` — essentially frozen/stable rather than actively developed, which is consistent with being a settled dependency rather than a product. Both repos confirm a `LICENSE` file exists but its exact text wasn't fetched this session — **unverified** licence specifics. TLV/long-message/encoding details for these two packages specifically were not independently confirmed this session — for practical testing, use them via Jasmin itself (A7) rather than standalone.

### A7. Jasmin SMPP client connector (`smppccm`)
[jookies/jasmin](https://github.com/jookies/jasmin), GitHub shows licence `NOASSERTION` (a `LICENSE` file exists in-repo; exact terms not re-confirmed this session), actively maintained (pushed 2026-04-26).

- **Docker**: official image `jookies/jasmin` on Docker Hub. [Tag listing](https://hub.docker.com/v2/repositories/jookies/jasmin/tags) shows the latest tagged release is **`0.11.0`** (pushed 2023-11-10) — use `jookies/jasmin:0.11.0`. Note the image lags the git repo (repo pushed as recently as 2026-04-26, image not retagged since 2023).
- **Configuring + driving `smppccm`** (exact key names confirmed from source, [`jasmin/protocols/cli/smppccm.py`](https://raw.githubusercontent.com/jookies/jasmin/master/jasmin/protocols/cli/smppccm.py) — full key list: `cid, host, port, username, password, systype, bind, bind_ton, bind_npi, logfile, loglevel, logrotate, logprivacy, bind_to, elink_interval, res_to, pdu_red_to, trx_to, con_loss_retry, con_loss_delay, con_fail_retry, con_fail_delay, src_addr, src_ton, src_npi, dst_ton, dst_npi, addr_range, proto_id, priority, validity, ripf, def_msg_id, coding, requeue_delay, submit_throughput, dlr_expiry, dlr_msgid, ssl, custom_tlvs`):
  ```
  jcli
  smppccm -a
  cid myconnector
  host <target-host>
  port <target-port>
  username <system_id>
  password <password>
  bind transceiver
  ok
  smppccm -1 myconnector
  ```
  To actually push a `submit_sm`, Jasmin doesn't send it from a jCli command directly — you add an MT route (`mtrouter -a`) pointing traffic at the connector, then trigger it via Jasmin's own HTTP send API (`GET/POST /send`), which the MT router forwards to the connector as an outbound `submit_sm`.
- **enquire_link**: `elink_interval` config key controls the periodic timer per-connector — confirmed directly from source.
- **Windowing**: only `submit_throughput` (a rate cap) was found in the confirmed key list — no distinct max-outstanding-window key surfaced. **Unverified** whether one exists elsewhere in the connector implementation.
- **Long messages / encoding**: `coding` sets the connector's default data_coding; long-message splitting strategy inherited from `smpp.pdu`/`smpp.twisted` beneath it — not independently confirmed this session.
- Being Python/Twisted and used in real MNO/aggregator deployments, Jasmin exercises a genuinely different stack/style from every Java option here — see recommendation notes below.

### A8. fiorix/go-smpp
[fiorix/go-smpp](https://github.com/fiorix/go-smpp), MIT, active (pushed 2026-04-25). Ships a one-shot CLI, `cmd/sms` (`sms send <from> <to> <text>`, env `SMPP_USER`/`SMPP_PASSWD`, flags `--addr`/`--tls`) — good for a single bind+submit+deliver smoke test, not a load driver (no count/rate/window flags). Long-message default, data_coding behaviour, enquire_link interval, and windowing were not independently confirmed this session beyond the CLI's absence of relevant flags — **unverified** at the library level.

### A9. linxGnu/gosmpp
[linxGnu/gosmpp](https://github.com/linxGnu/gosmpp), Apache-2.0, active (pushed 2026-07-13, 21 open issues), described in its own README as "porting from Java OpenSMPP Library." Bind example:
```go
trans, err := gosmpp.NewSession(
    gosmpp.TRXConnector(gosmpp.NonTLSDialer, auth),
    gosmpp.Settings{ /* EnquireLink: 5*time.Second, OnPDU, OnClosed, ... */ },
    5*time.Second)
```
`Settings.EnquireLink` sets a real periodic keepalive interval; `OnClosed`/rebind hooks suggest built-in auto-reconnect behaviour on connection loss (worth probing — does it reconnect and rebind automatically if your server closes on `idleTimeout`?). Supported-PDU list includes `submit_sm_multi`/`data_sm`; exact UDH/SAR default-splitting and data_coding behaviour not confirmed from the README excerpt fetched — **unverified**. No bundled load tool.

### A10. oserl
Canonical repo [archaelus/oserl](https://github.com/archaelus/oserl) — "Enrique Marcote Peña's SMPP for Erlang (mirrored from sourceforge with minor patches)," last updated 2009-04-03: effectively abandoned for 15+ years. Its practical relevance today is that PowerMeMobile's `smppload` (Section B) depends on it under the hood (per `smppload`'s `rebar.config`). Minor satellites found: [dergraf/smpp](https://github.com/dergraf/smpp) (2011, thin Erlang wrapper) and [netDalek/smppex_oserl](https://github.com/netDalek/smppex_oserl) (2019, Elixir SMPPEX↔oserl PDU converter). Treat oserl as "the engine inside smppload," not a library to stand up fresh — use `smppload` itself, or `smppex` (A17) for a genuinely maintained Erlang-VM option.

### A11. libsmpp34
[osmocom/libsmpp34](https://github.com/osmocom/libsmpp34) (mirrored from `gitea.osmocom.org`), C, LGPL-2.1, actively maintained (pushed 2026-08-20, i.e. 16 days before this research). It's a PDU encode/decode codec used inside Osmocom's telecom stack (e.g. OsmoSMSC), not a ready bind/submit/receive CLI. Docker packaging, long-message defaults, and encoding behaviour need a source read not completed this session — **unverified**.

### A12. Rust: smpp34 crate
Of the Rust crates found on [crates.io](https://crates.io/api/v1/crates?q=smpp) — `smpp` (client+server, v0.1.2), **`smpp34`** ("Pure-Rust SMPP 3.4 codec with an async (tokio) client and server", v1.4.1), `smpp-pdu` (parsing only, v0.1.4), `smpp-codec` (SMPP v5 codec, v0.2.1), and the `rusmpp`/`rusmppc`/`rusmppz`/`rusmpp-macros` family (all v0.4.0, modular core + a dedicated client crate `rusmppc`) — **`smpp34`** is the most complete single credible pick (highest version number, explicit client+server+async claim). Repo URL, licence, and operational details (bind example, long-message/encoding defaults) were not independently fetched this session beyond the crates.io registry metadata — **unverified**; read its crates.io page/repo before relying on it.

### A13. C#: JamaaSMPP
[AdhamAwadhi/JamaaSMPP](https://github.com/AdhamAwadhi/JamaaSMPP), a fork/continuation of the original Jamaa Technologies SmppClient, actively maintained (pushed 2026-08-18). NuGet: `Install-Package JamaaSMPP`. README confirms: concatenated/long-message handling via **UDH, SAR, and message_payload — all three, developer's choice**; GSM 03.38 alphabet encoding; custom encoding configurable per client instance; separate-or-combined TX/RX connections. v2.0.0 dropped .NET Framework 4.0 and reworked response-handler threading reliability (worth checking current issues for residual races — not reviewed this session). Licence not confirmed this session — **unverified**, check the repo's `LICENSE` before adoption.

### A14. PHP: php-smpp
Original [OnlineCity/php-smpp](https://github.com/OnlineCity/php-smpp) (pushed 2022-09-18, no licence declared) explicitly states in its README: **"THIS REPO IS NO LONGER MAINTAINED!"**, pointing to the fork [alexandr-mironov/php-smpp](https://github.com/alexandr-mironov/php-smpp) (pushed 2022-12-02, 6 open issues, also no licence declared — flag this as a legal gap before adopting either).

- **Bind**: `bindTransmitter()` / `bindReceiver()` with host/port/username/password. **No `bind_transceiver` support** — README: *"You can't connect as a transceiver, otherwise supported by SMPP v.3.4."* This forces you to run separate TX and RX connections against the server under test, directly exercising direction-enforcement (e.g. your server's `ESME_RINVBNDSTS` handling) on genuinely separate binds rather than one combined TRX session.
- **submit_sm**: `sendSMS()`.
- **Long messages**: three built-in modes — `CSMS_16BIT_TAGS`, `CSMS_PAYLOAD` (`message_payload`), `CSMS_8BIT_UDH` — the broadest single-library choice of long-message wire strategy found in this research.
- **Encoding**: assumes GSM 03.38; ships `GsmEncoder::utf8_to_gsm0338()`.
- **enquire_link**: application-driven on an inactivity timeout (README example: "every 30 seconds of inactivity"), not automatic by default.

### A15. Perl: Net::SMPP
[metacpan.org/pod/Net::SMPP](https://metacpan.org/pod/Net::SMPP), last release **1.19, 2011-06-01** — unmaintained 14+ years, licence unknown per MetaCPAN.
- `bind_transceiver()` and `submit_sm()` documented directly.
- **Long messages**: docs recommend `message_payload` for bodies over 254 bytes (leaving `short_message` empty) — its documented path is message_payload, not UDH/SAR.
- **Encoding**: explicitly does **not** auto-encode — *"Net::SMPP also does not automatically perform the encoding"* — ships `pack_7bit()`/`unpack_7bit()` helpers the caller must invoke explicitly. Useful precisely because you control packed-vs-unpacked GSM 7-bit deliberately, letting you test both against the server on purpose.

### A16. Ruby: ruby-smpp
[ruby-smpp](https://rubygems.org/gems/ruby-smpp) (EventMachine-based), v0.6.0, 108,794 downloads — the most-downloaded of seven SMPP-related Ruby gems found, ahead of its own fork `anjlab-ruby-smpp` (33,740 downloads, v0.6.4) and smaller options (`smpp_encoding`, `rocket_sms`, `Crota`, `rock-queue-smpp`, `anthill_smpp_ruby`). Bind/long-message/encoding specifics not independently fetched this session beyond gem metadata — **unverified**.

### A17. Elixir: smppex
[smppex on hex.pm](https://hex.pm/packages/smppex), "SMPP 3.4 protocol and framework implemented in Elixir," v3.3.0, updated roughly 2 months before this research, 200,620 total downloads — clearly the maintained choice over `esmpp` (v0.0.13, ~9 years stale) and the companion `smppex_telemetry` package (~5 years stale, but its existence confirms a real surrounding ecosystem). Bind/config specifics not independently fetched this session — **unverified**.

### A18. Kannel `bearerbox` as an SMPP client
Kannel is confirmed (via [Wikipedia](https://en.wikipedia.org/wiki/Kannel_(telecommunications))) to be licensed under the "Kannel Software License 1.0" (Apache-1.1-like), official site `kannel.org`. **This session could not independently verify any operational SMPP-client detail**: every fetch attempt against `kannel.org`'s user guide failed with a TLS certificate validation error, and no working canonical GitHub/GitLab mirror of the primary (historically SVN-hosted) repo was confirmed — third-party forks found (e.g. `pruiz/kannel`) are stale (last touched 2014) and not authoritative. The well-known architecture (a `group = smsc` / `smsc = smpp` config stanza binding `bearerbox` as an SMPP client, driven by `smsbox`'s HTTP `sendsms` interface) is widely documented under normal circumstances, but restating its exact config keys from memory here would violate this report's "verify or mark unverified" rule — **treat all Kannel specifics as unverified pending a follow-up session with working TLS to kannel.org (or a fixed CA bundle)**.

---

## B. Load / soak generators

*(Fully researched with WebSearch+WebFetch by a parallel research thread this session.)*

### Summary

| Tool | Repo | Licence | Language | Maintained? |
|---|---|---|---|---|
| smppload | [PowerMeMobile/smppload](https://github.com/PowerMeMobile/smppload) | none found | Erlang | Sporadic (tags 2014→2.5.3; 1 open issue since 2023) |
| SMPPSim | e.g. [haifzhan/SMPPSim](https://github.com/haifzhan/SMPPSim) (unofficial mirror) | custom freeware, non-OSI | Java | Server-only — **not a client load tool** |
| fiorix/go-smpp (`cmd/sms`) | [fiorix/go-smpp](https://github.com/fiorix/go-smpp) | MIT | Go | Active, but one-shot only, no load mode |
| linxGnu/gosmpp | [linxGnu/gosmpp](https://github.com/linxGnu/gosmpp) | Apache-2.0 | Go | Active; no bundled load tool |
| veoo/smpperf | [veoo/smpperf](https://github.com/veoo/smpperf) | MIT | Go | Dead since 2020-06-10; sends one message and exits despite the name |
| vponomarev/libsmpp (`smpp-dumb-client`) | [vponomarev/libsmpp](https://github.com/vponomarev/libsmpp) | LGPL-3.0 | Go | Low activity (2025-07-01) — **the one Go tool with a real bounded window** |
| AShabana/smpp-load-test | [AShabana/smpp-load-test](https://github.com/AShabana/smpp-load-test) | none found | Go | Dead since 2022-08-10 |
| cloudhopper-smpp (library) | [fizzed/cloudhopper-smpp](https://github.com/fizzed/cloudhopper-smpp) | Apache-2.0 per README | Java | Basis for bespoke load tools, not one itself |
| Java-SMPP-Load-GUI | [shaf2k/Java-SMPP-Load-GUI](https://github.com/shaf2k/Java-SMPP-Load-GUI) | none found | Java | Dead, 1 commit (2015) |
| jsmpp StressClient/StressServer | [opentelecoms-org/jsmpp](https://github.com/opentelecoms-org/jsmpp) | Apache-2.0 | Java | Active; bundled example, not a packaged tool |
| wizardjedi/smpp-test-tools | [wizardjedi/smpp-test-tools](https://github.com/wizardjedi/smpp-test-tools) | none found | Java | Low activity (2023-02-23) |
| emgload/emgsink | [smpp.com/smpp-benchmarking.html](https://smpp.com/smpp-benchmarking.html) | proprietary | native, unverified | Actively sold |
| Melrose Labs Load Test Tool | [melroselabs.com/tools/smpploadtest](https://melroselabs.com/tools/smpploadtest/) | proprietary, hosted | n/a | Active service |

### smppload (PowerMeMobile) — the practical free/open pick
- CLI: `-H/--host -P/--port -B/--bind_type(TX|TRX|RX) -i/--system_id -p/--password -r/--rps(1000) -T/--thread_count(10) -c/--count(1) -s/--source -d/--destination -l/--length(140) -D/--delivery -C/--data_coding(3=Latin1)` (from [`src/smppload.erl`](https://raw.githubusercontent.com/PowerMeMobile/smppload/master/src/smppload.erl)):
  ```
  smppload -H smsc.example.com -P 2775 -B trx -i myuser -p mypass \
    -s 1234:1,1 -d 15555550100 -c 100000 -r 500 -T 20 -l 140 -D 1
  ```
- **Windowing**: no true bounded in-flight window — "window" is really `thread_count × rps` (confirmed from [`smppload_esme.erl`](https://raw.githubusercontent.com/PowerMeMobile/smppload/master/src/smppload_esme.erl)).
- **Throttling**: all non-zero `command_status` responses fold into one `send_fail` counter ([`smppload_stats.erl`](https://raw.githubusercontent.com/PowerMeMobile/smppload/master/src/smppload_stats.erl)) — no ESME_RTHROTTLED-specific backoff.
- **Long messages**: yes, UDH-based multipart; UCS2-BE for Unicode.
- **enquire_link**: not implemented at all.
- **Docker**: no official image; needs a hand-built Erlang/OTP 19+ image, tag chosen and pinned by you.
- **Known issues**: [#8](https://github.com/PowerMeMobile/smppload/issues/8) rebar3/BEAM load errors (open); a closed issue documents Erlang 22.3.2 compile failures.

### The one tool with a real bounded window: `vponomarev/libsmpp`'s `smpp-dumb-client`
YAML-driven ([`config.yml`](https://raw.githubusercontent.com/vponomarev/libsmpp/master/app/smpp-dumb-client/config.yml)):
```yaml
smpp:
  remote: 127.0.0.1:2500
  bind: { systemID: test, systemType: test, password: test, mode: TRX }
generator:
  enabled: yes
  count: 0       # total messages
  rate: 100      # messages/sec
  window: 2000   # max outstanding unacked submit_sm — real, enforced
  stayConnected: yes
```
Confirmed enforced in [`generator.go`](https://raw.githubusercontent.com/vponomarev/libsmpp/master/app/smpp-dumb-client/generator.go): sending is skipped once in-flight count reaches `window`. No ESME_RTHROTTLED-aware backoff; no long-message (UDH/SAR) support; plain `ShortMessage` body only. Same repo also ships a matching test SMSC (`smpp-dumb-server`) and an `smpp-lb` load balancer.

### SMPPSim — out of scope as a *client* tool
Confirmed server-only from its [official README](https://github.com/haifzhan/SMPPSim/blob/master/SMPPSim_OFFICIAL_README): "a testing utility which mimics the behaviour of an SMPP based SMSC." No client-side load mode exists. Docker mirrors found (`balsagoth/smppsim` last pushed 2017-08-03; `jookies/smppsim` last pushed 2022-08-07) are unofficial and stale.

### Other notes
- **Cloudhopper's demo** (`ClientMain.java`) has real windowing (`setWindowSize`) but is a one-message demo, not a load driver; a bespoke load tool would need to be built on top.
- **jsmpp's `StressClient`/`StressServer`** examples ([source](https://raw.githubusercontent.com/opentelecoms-org/jsmpp/master/jsmpp-examples/src/main/java/org/jsmpp/examples/StressClient.java)) fire `bulkSize` (default 100,000) submits bounded only by a `pduProcessorDegree`-sized thread pool — no rate control, no long messages, no differentiated throttle handling.
- **emgload/emgsink** ([smpp.com](https://smpp.com/smpp-benchmarking.html)) is the one tool here with explicit UDH-via-TLV long-message load support (`--smpp_udh_via_optional`) and very high claimed throughput (~25,000 msg/s), but it's commercial (~599 EUR/yr/host, unlicensed use capped at 10 msg/s) and closed-source.
- **Melrose Labs' hosted Load Test Tool** exposes TPS, concurrent binds, a distinct "submit window," message quantity, and long-message splitting all as separate dials — useful as terminology/prior-art confirmation that "window" and "rate" are properly orthogonal knobs, even though it's not automatable in CI (paid, web-UI only).

**Bottom line for Section B**: `smppload` is the only free, scriptable, protocol-real load generator with long-message support; pair it with `vponomarev/libsmpp`'s `smpp-dumb-client` specifically when you need to test a genuine bounded-window/backpressure scenario against `maxOutstanding`, since `smppload` cannot do that.

---

## C. Independent PDU validators

*(Fully researched with WebSearch+WebFetch by a parallel research thread this session.)*

### C1. Wireshark / tshark — the one to always run
- Built-in dissector: `epan/dissectors/packet-smpp.c` ([source](https://raw.githubusercontent.com/wireshark/wireshark/master/epan/dissectors/packet-smpp.c)); official reference: [wiki.wireshark.org/SMPP](https://wiki.wireshark.org/SMPP). Decodes "most of the version 3.4 specific fields," ~48 distinct TLV tags (`0x0005`–`0x1383`), and independently reassembles UDH/concatenation by handing `short_message`/`message_payload` off to Wireshark's own GSM-SMS dissector once it sees the `sar_msg_ref_num`/`sar_total_segments`/`sar_segment_seqnum` TLVs.
- **Port handling**: SMPP has an IANA-registered port (2775/tcp, per [IANA's service-names registry](https://www.iana.org/assignments/service-names-port-numbers/service-names-port-numbers.xhtml)), but per the wiki, Wireshark's dissector does **not** rely on it — "No well known port is defined for this protocol. The dissector will use heuristics." Force it explicitly on a non-standard port with `-d`.
- **Capture + decode** (flag syntax confirmed against the official [dumpcap](https://www.wireshark.org/docs/man-pages/dumpcap.html)/[tshark](https://www.wireshark.org/docs/man-pages/tshark.html) man pages):
  ```bash
  dumpcap -i lo -f "tcp port 2775" -w smpp.pcapng
  tshark -r smpp.pcapng -d tcp.port==2775,smpp -Y smpp -V        # verbose text
  tshark -r smpp.pcapng -d tcp.port==2775,smpp -Y smpp -T json   # JSON, CI-diffable
  ```
- **Malformed-PDU flagging**: two SMPP-specific expert-info fields were confirmed in source (`ei_smpp_message_payload_duplicate`, `ei_smpp_date_time_decoding_failed`); a full sweep for a generic SMPP "Malformed Packet" entry wasn't completed (file too large to fetch whole) — but Wireshark's core engine independently raises a generic "Malformed Packet" item on any dissector exception (truncated/out-of-bounds read) regardless of protocol, so malformed SMPP still typically surfaces this way.
- **Docker**: no official `wireshark`/`tshark` image under Docker Hub's `library/` namespace (confirmed 404). Verified working: [`nicolaka/netshoot`](https://hub.docker.com/r/nicolaka/netshoot) (tag `v0.16`, pushed 2026-07-01) — its [Dockerfile](https://raw.githubusercontent.com/nicolaka/netshoot/master/Dockerfile) does `apk add tshark`. Fallback (verified package + current tags):
  ```dockerfile
  FROM debian:13.6-slim
  RUN apt-get update && apt-get install -y --no-install-recommends tshark \
      && rm -rf /var/lib/apt/lists/*
  ENTRYPOINT ["tshark"]
  ```
  (Debian `trixie`'s `tshark` package is confirmed at Wireshark 4.4.18 per [packages.debian.org](https://packages.debian.org/trixie/tshark); `debian:13.6-slim` and `alpine:3.24.1` confirmed as current full-patch tags via the Docker Hub tag API.)

### C2. sngrep-like alternatives
[sngrep](https://github.com/irontec/sngrep/blob/master/README) is confirmed SIP/RTP-only ("displaying SIP calls message flows... SIP packets... PCAP viewer") — no SMPP support, no SMPP mention anywhere. No sngrep-style interactive TUI analyzer specifically for SMPP was found — **none found / unverified**, not ruled out, but nothing credible surfaced.

### C3. Standalone SMPP PDU decoders

| Name | What it is | Maintenance/Licence |
|---|---|---|
| [SMPP PDU Decoder (gurk4n)](https://smpp.gurk4n.com/) | Browser tool, decodes raw hex PDUs; GSM 7-bit/8-bit, UCS2, Latin-1, ASCII; 100% client-side | Unverified |
| [isimplelab SMPP PDU decoder](https://smpp.isimplelab.com/pdu?lang=en) | Part of a broader SMPP server-emulator site | Unverified |
| sysop.fr / Ozeki decoder pages | Found in search, pages unreachable this session (TLS/connection errors) | Unverified |
| jsmpp | Java library; per a (not re-fetched) Google Groups thread, newer versions log all sent/received PDUs at DEBUG — usable as a cross-check dumper | Apache-2.0, active |
| cloudhopper-smpp demo (`ClientMain.java`) | `make client`/`make parser`, logs raw PDU bytes (`setLogBytes(true)`) | Apache-2.0 per README |
| SMPPSim | `smppsim.props` independently exposes `DECODE_PDUS_IN_LOG`, `CAPTURE_SME_BINARY[_TO_FILE]`, `CAPTURE_SMPPSIM_BINARY[_TO_FILE]`, `CAPTURE_SME_DECODED[_TO_FILE]`, `CAPTURE_SMPPSIM_DECODED[_TO_FILE]` — a genuine independent PDU log for cross-checking both directions ([`conf/smppsim.props`](https://raw.githubusercontent.com/haifzhan/SMPPSim/master/conf/smppsim.props)) | Custom freeware, non-OSI |
| [Black Duck Defensics SMPP Server test suite](https://www.blackduck.com/fuzz-testing/defensics/protocols/smpp-server.html) | Commercial fuzzer/conformance suite, 14 SMPP v3.4 message categories | Commercial |
| [Melrose Labs SMPP Analyser / conformance testing](https://melroselabs.com/services/smpp-testing/) | Commercial SMPP-packet analysis + PICS-based conformance service | Commercial |

Note: several near-identical-sounding tools (Diafaan, smspdu.be, smsdeliverer.com) decode the unrelated **GSM SMS-PDU** (3GPP TS 23.040 AT-command) format, not SMPP protocol PDUs — excluded above.

---

## Ranked recommendation

**Run these 3–4 clients — each catches a different class of bug, deliberately non-overlapping:**

1. **jsmpp (Java)** — for PDU-level/version-negotiation correctness. It silently defaults to interface_version 3.4 if your `bind_resp` omits `sc_interface_version`, but a bogus TLV value there risks an enum-lookup exception client-side — cheap way to probe how forgiving vs. fragile your bind_resp encoding is. Being "not a high-level library," it also gives you full manual control over UDH/SAR/message_payload bytes on the wire, unlike libraries that pick a strategy for you.
2. **php-smpp (`alexandr-mironov` fork)** — for direction-enforcement and long-message wire variety. It refuses `bind_transceiver` outright, forcing separate TX/RX binds against your server (a different code path than a single TRX session) and is the only library found here offering all three long-message strategies (UDH, 16-bit-tag SAR, `message_payload`) from one client.
3. **Cloudhopper-smpp (fizzed fork, Java/Netty)** — for windowing/backpressure. First-class `setWindowSize`/`setRequestExpiryTimeout`/`setWindowMonitorInterval`, and an async `WindowFuture` submission model architecturally distinct from jsmpp's synchronous style — best tool here to stress-test `maxOutstanding` and slow-response handling.
4. **python-smpplib (Python)** — for encoding correctness. It sends GSM 7-bit **unpacked** for data_coding 0 by default (confirmed from source), a genuine, checkable divergence from packed-septet encoding — deliberately useful for catching a data_coding=0 decode bug either way. Its enquire_link is reactive (opt-in, fired on read-timeout) rather than timer-driven, exercising idle-handling differently than the Java options.

Honorable mention: **Jasmin's `smppccm`** (Python/Twisted, real MNO-style production tooling) is worth adding as a 5th if you want production-representative behaviour, but this session couldn't verify enough of its wire-level specifics (long-message default, exact windowing) to rank it with confidence above.

**Validator to always run: Wireshark/tshark (C1).** It is implementation-independent of every client above, decodes every PDU field including TLVs and UDH/concatenation reassembly, and its `-T json` output is scriptable for CI diffing against your own encoder's expected bytes — the only tool in this report that verifies wire encoding rather than exercising server behaviour.
