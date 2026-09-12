# SMPP SMSC-side test targets for `@larvit/smpp`

Research date 2026-09-05. All claims cite the URL they came from; anything not confirmed by a primary source is marked **unverified**.

## Quick comparison

| Candidate | Language | License | Maintained? | Docker tag (pinned) | SMPP port | SMPP versions |
|---|---|---|---|---|---|---|
| SMPPSim (Selenium Software) | Java | GPLv2 [sourceforge](https://sourceforge.net/projects/smppsim/) | Stalled — homepage `seleniumsoftware.com` returns Cloudflare 522 as of this research; last SourceForge file 2015-05-22; community fork last touched 2024-01-09 | none published — build your own | 2775 | 3.3/3.4 implied, not confirmed |
| Jasmin SMS Gateway | Python/Twisted | ISC-style (see repo) [github](https://github.com/jookies/jasmin) | Source active (last push 2026-04-26), last **tagged release** 0.11.0 (2023-11-10) | `jookies/jasmin:0.11.0` [dockerhub](https://hub.docker.com/r/jookies/jasmin/tags) | 2775 | 3.4 |
| Kannel + opensmppbox | C | BSD-style (Kannel) | Kannel core: last stable 1.4.5, 2018-06-19 [kannel.org](https://www.kannel.org/); opensmppbox (pruiz fork): last commit 2014-04-22 [github](https://github.com/pruiz/kannel-opensmppbox) | none — build from source | 2345 (configurable) | 3.3/3.4/5.0 |
| Kannel `fakesmsc` | C | BSD-style | same as Kannel | n/a | configurable (e.g. 10000) | **none — not SMPP at all** |
| Melrose Labs SMSC Simulator (hosted) | closed-source | proprietary | Actively run (commercial service) | n/a — hosted | 2775 (8775 TLS) | 3.3/3.4/5 |
| Melrose Labs SMSC Simulator (OSS, old code) | C++ | MIT [github](https://github.com/melroselabs/smpp-smsc-simulator) | Dormant, last push 2023-07-15, explicitly "old version" | none published | 2775 | subset of 3.4 |
| ukarim/smscsim | Go | MIT [github](https://github.com/ukarim/smscsim) | Source active (last push 2025-12-12); Docker tags stop at 0.2.0 | `ukarim/smscsim:0.2.0` (no newer semver tag) [dockerhub](https://hub.docker.com/r/ukarim/smscsim/tags) | 2775 (env `SMSC_PORT`) | subset of 3.4 |
| mdouchement/smsc3 | Go | MIT [github](https://github.com/mdouchement/smsc3) | Last push 2024-05-09, small project | none published — Dockerfile in repo | 20001 | 3.4 |
| K2InformaticsGmbH/smsc_simulator | Erlang | Apache-2.0 [github](https://github.com/K2InformaticsGmbH/smsc_simulator) | Abandoned, last commit 2018-08-31 | none | configurable | SMPP + UCP |
| MavoCz/smscsim (cloudhopper-based) | Java | unverified | unverified last-commit date | none | configurable (CLI `-p`) | 3.3/3.4/5.0 (via cloudhopper) |
| fizzed/cloudhopper-smpp | Java | Apache-2.0 [github](https://github.com/fizzed/cloudhopper-smpp) | Last push 2020-10-12 | none — library + demo, not a packaged sim | demo-configurable | 3.3/3.4/most of 5.0 |
| jsmpp `SMPPServerSimulator` example | Java | Apache-2.0 [github](https://github.com/opentelecoms-org/jsmpp) | jsmpp itself very active (last push 2026-06-17); the example is a demo class, not a packaged tool | none — sample code | example-configurable | 3.4/3.3 |
| node-smpp | JS | MIT [github](https://github.com/farhadi/node-smpp) | Last push 2023-12-28 | none — library, build your own server | n/a | 5.0 (back-compat with 3.4) |
| MikeSafonov/smpp-server-mock | Java (JUnit ext.) | MIT [github](https://github.com/MikeSafonov/smpp-server-mock) | Last push 2023-03-10 | none — embedded-in-test only, not standalone | n/a | unverified |
| Restcomm/TeleStax SMSC Gateway simulator | Java/JSLEE | unverified | project largely dormant post-TeleStax | none published | 2776 (sample) | unverified, full carrier-grade stack |
| OsmoMSC SMPP interface | C | AGPL (Osmocom) | Actively maintained as part of Osmocom NITB/MSC, but it's a *client* interface for external ESMEs bound to a live MSC core, not a standalone SMSC simulator you spin up in Docker | none | configurable | unverified |
| smscsim.smpp.org (public) | closed | n/a | unverified, listed on smpp.org | hosted | 2775 | unverified, 2 SMS/s cap |

Ozeki NG SMS Gateway and NowSMS both ship free/trial tiers with an SMPP server mode, but are Windows-first, closed-source products; skipped per task scope beyond this line.

---

## 1. SMPPSim (Selenium Software)

1. **Source**: originally `seleniumsoftware.com/downloads.html`; that domain currently returns an HTTP 522 (Cloudflare "origin unreachable") when fetched directly — confirmed via both WebFetch and a raw `curl` from this research session, so the vendor's own site is effectively down right now. SourceForge mirror: [sourceforge.net/projects/smppsim](https://sourceforge.net/projects/smppsim/) — license **GPLv2**, "Currently hosted by Selenium Software", last file dated **2015-05-22**. A community fork with docs/props preserved: [komuw/smpp_server_docker](https://github.com/komuw/smpp_server_docker) (last push 2019-06-04), user-guide mirrored at [user-guide.htm](https://github.com/komuw/smpp_server_docker/blob/master/SMPPSim/docs/user-guide.htm). Not actively maintained by any single fork; version history in the mirrored guide references up to v2.6.6.
2. **Docker**: no maintainer-published image with a pinned version tag exists. Two build-yourself Dockerfiles found:
   - [kwahome/smpp-sim-docker](https://github.com/kwahome/smpp-sim-docker) (repo last pushed 2024-01-09) — its own `Dockerfile` builds `openjdk:7-jre-alpine` + bundled `SMPPSim/`, but its `docker-compose.yml` instead pulls a pre-built `blackorder/smppsim:latest` — **only a `latest` tag exists** on that Docker Hub repo (pushed ~2 years ago, single tag) [dockerhub](https://hub.docker.com/r/blackorder/smppsim/tags). Since no full-patch-version tag is published anywhere, to comply with "never floating tags" you must build the image yourself from the Dockerfile and apply your own version tag.
   - `bitsensedev/smpp-sim` on Docker Hub: single `latest` tag, pushed **9+ years ago** — effectively abandoned, do not use.
   - Ports (from the Dockerfile env defaults): SMPP **2775**, HTTP admin **8884** (some older docs say port 88 — verify against the image you build).
   - Default credentials (env `SYSTEM_IDS` / `PASSWORDS`): `smppclient1,smppclient2,smppclient3` / `password,password,password` [Dockerfile](https://raw.githubusercontent.com/kwahome/smpp-sim-docker/master/Dockerfile).
3. **SMPP versions**: not explicitly stated in any surviving doc; behavior suggests 3.3/3.4-era PDU set. Whether it validates `interface_version` at bind — **unverified**, no mention in the mirrored user guide.
4. **Delivery receipts**: yes, when `registered_delivery_flag` is set on `submit_sm`. Controlled by percentage knobs: `PERCENTAGE_DELIVERED`, `PERCENTAGE_UNDELIVERABLE`, `PERCENTAGE_ACCEPTED`, `PERCENTAGE_REJECTED`, plus `PERCENTAGE_THAT_TRANSITION` (chance of an intermediate state before final), `DELAY_DELIVERY_RECEIPTS_BY` (delayed DLR, ms), `MAX_TIME_ENROUTE`. TLV vs text-body format not documented; message-id format documented only as "randomised … with configurable prefix" — hex/decimal notation unverified.
5. **Long messages**: UDH/`sar_*`/`message_payload` handling not documented in any surviving guide fragment — unverified, treat as untested.
6. **Encodings**: only one hard fact recovered — binary MO messages (hex-prefixed with `0x` in the inject form) get `data_coding` auto-set to 4. GSM7 packed-vs-unpacked, Latin-1, UCS-2 behavior — unverified.
7. **MO injection**: three documented methods — (a) web form `/inject_mo.htm`, (b) "loopback" mode that turns a `submit_sm` back into a `deliver_sm`, (c) MO service reading a `deliver_messages.csv` file. Also supports SMSC-initiated **outbind** (`OUTBIND_ENABLED=true` + `OUTBIND_ESME_*` env vars) to test your library's outbind handling.
8. **Fault injection**: queue-full simulation via `INBOUND_QUEUE_MAX_SIZE`/`OUTBOUND_QUEUE_MAX_SIZE` and `DELAYED_INBOUND_QUEUE_MAX_ATTEMPTS`; on `ESME_RMSGQFUL` the mirrored guide says SMPPSim "will attempt to deliver the MO message again, after a delay" (v2.6.0 note). `MO_DELIVERY_MESSAGES_PER_MINUTE`/`DELIVERY_MESSAGES_PER_MINUTE` throttles delivery rate. Explicit `ESME_RTHROTTLED` triggering — unverified.
9. **TLS**: not mentioned anywhere in the surviving docs — treat as unsupported.
10. **Minimal run** (build-yourself, since no pinned image exists):
    ```
    git clone https://github.com/kwahome/smpp-sim-docker
    cd smpp-sim-docker
    docker build -t local/smppsim:<your-tag> .
    docker run -p 2775:2775 -p 8884:8884 local/smppsim:<your-tag>
    ```
    Bind with `system_id=smppclient1`, `password=password`, port 2775.
11. **Quirks**: primary vendor site down (522) at research time; ecosystem is a scatter of unofficial Docker forks with inconsistent port numbers (88 vs 8884) between older and newer docs — verify against whichever build you actually use.

## 2. Jasmin SMS Gateway

1. [jookies/jasmin](https://github.com/jookies/jasmin), license per repo (ISC-style, see `LICENSE`), Python/Twisted. Repo actively committed (last push 2026-04-26) but last **tagged release is 0.11.0, 2023-11-10** [releases](https://github.com/jookies/jasmin/releases). Docs: [docs.jasminsms.com](https://docs.jasminsms.com/).
2. **Docker**: `jookies/jasmin:0.11.0` (full patch tag exists and matches the GitHub release) [dockerhub tags](https://hub.docker.com/r/jookies/jasmin/tags). Needs RabbitMQ + Redis as separate containers — not standalone.
   ```
   docker run -d -p 1401:1401 -p 2775:2775 -p 8990:8990 jookies/jasmin:0.11.0
   ```
   Ports: **2775** SMPP server, 1401 HTTP API/panel, 8990 `jcli` telnet console [docker/README.md](https://github.com/jookies/jasmin/blob/master/docker/README.md). No default smpp-server credentials are pre-provisioned — you create a `system_id`/`password` via `jcli` (`smppccm`/`user -a` commands) after startup.
3. **SMPP version**: 3.4 [SMPP Server API docs](https://docs.jasminsms.com/en/latest/apis/smpp-server/index.html). `interface_version` enforcement at bind — not documented; **unverified**.
4. **Delivery receipts**: yes. Jasmin's DLR pipeline (`DLRLookup`/`DLRThrower`) tracks the message in Redis and, when the original submission came in over `smpps`, pushes the receipt back as a `deliver_sm`/`data_sm` on the same bind [messaging flows](https://docs.jasminsms.com/en/latest/messaging/index.html). Whether it's TLV (`receipted_message_id`/`message_state`) or text-body — not confirmed from docs; a `dlr_msgid` connector setting (0/1/2) exists specifically to reconcile hex-vs-decimal message-id mismatches between `submit_sm_resp` and `deliver_sm` — but that knob lives on **outbound SMPP client connectors** (Jasmin acting as ESME to an upstream real SMSC), not on the `smpps` server your library binds to [Google Groups thread](https://groups.google.com/g/jasmin-sms-gateway/c/KRqUA6e569w). When Jasmin itself is the SMSC (your library binds to its `smpps`), the message id it generates is its own internal **UUID**-based id [Google Groups](https://groups.google.com/g/jasmin-sms-gateway/c/KRqUA6e569w) and should therefore be self-consistent between `submit_sm_resp` and the DLR — good for testing your library's "normalise across submit_sm_resp vs receipt" logic in the *opposite* direction (assert it does NOT need to normalise when ids already match).
5. **Long messages**: two segmentation strategies documented for MT — **SAR** (`sar_msg_ref_num`/`sar_total_segments`/`sar_segment_seqnum`, "preferred by most SMSCs") and **UDH** (prepended header + `UDHI_INDICATOR_SET` in `esm_class`, "for older system compatibility") [DeepWiki summary of Jasmin SMPP protocol support](https://deepwiki.com/jookies/jasmin/3.3-smpp-protocol-support) (secondary source — treat as indicative, not primary).
6. **Encodings**: capacity figures imply **packed** GSM7 (160 chars / 153 segmented = the standard packed math), 8-bit binary 140/134 bytes, UCS-2 70/67 chars [same DeepWiki page]. Not a primary source — verify empirically before relying on it.
7. **MO injection**: bind your library as receiver/transceiver on `smpps`; anything Jasmin routes to that connector arrives as `deliver_sm`. Separately, Jasmin's HTTP API/interceptor stack can push MO content to an HTTP webhook (`deliverSmHttpThrower`) instead — not needed for SMSC-side ESME testing, only relevant if you want Jasmin to also fan MO out to HTTP [interception docs](https://docs.jasminsms.com/en/latest/interception/index.html).
8. **Fault injection**: `submit_throughput` exists as a per-connector throttling parameter but its exact unit/effect and how to disable it are not resolved even in the project's own issue tracker — [issue #913](https://github.com/jookies/jasmin/issues/913) is open/stale with no documented answer. No documented way to force `ESME_RTHROTTLED`/`ESME_RMSGQFUL`, refuse binds, or drop the TCP connection on demand — unverified/likely absent.
9. **TLS**: the `[smpp-server]` config section in the shipped `jasmin.cfg` has **no TLS/SSL directives at all** [jasmin.cfg](https://github.com/jookies/jasmin/blob/master/misc/config/jasmin.cfg) — the SMPP *server* role does not support TLS. (An outbound SMPP *client* connector does have `useSSL`/`SSLCertificateFile` options, irrelevant here.)
10. **Minimal config** — `[smpp-server]` section, defaults: port 2775, `sessionInitTimerSecs=30`, `enquireLinkTimerSecs=30`, `inactivityTimerSecs=300`, `responseTimerSecs=60`, `pduReadTimerSecs=10`, `dlr_expiry=86400` [jasmin.cfg](https://github.com/jookies/jasmin/blob/master/misc/config/jasmin.cfg). After boot, create a user via `jcli`:
    ```
    jcli -h 127.0.0.1 -p 8990   # telnet console
    > user -a
    > uid myesme
    > gid mygroup
    > username myesme
    > password mypassword
    > ok
    ```
11. **Quirks**: no packaged Docker Compose bundling RabbitMQ+Redis is officially shipped — you must wire those yourself. No release/Docker tag newer than late 2023 despite ongoing source commits — verify current `master` behavior differs from 0.11.0 before trusting docs literally.

## 3. Kannel + opensmppbox (and why `fakesmsc` doesn't help)

1. **Kannel** core: [kannel.org](https://www.kannel.org/), C, BSD-style license. Confirmed via the vendor's own homepage: last **stable release 1.4.5, 2018-06-19**; nothing newer since [kannel.org news list, fetched directly]. Effectively unmaintained upstream.
   **opensmppbox** (the actual SMPP-server add-on): canonical doc is the [OpenSMPPBox User's Guide](https://www.kannel.org/download/1.4.4/gateway-1.4.4/addons/opensmppbox/doc/userguide.xml) ("developed by Chimit Ltd, maintained by the Kannel Group"). The most complete GitHub mirror, [pruiz/kannel-opensmppbox](https://github.com/pruiz/kannel-opensmppbox), has its last commit **2014-04-22** — 11+ years stale.
2. **Docker**: no official image. Build from source against a Kannel `bearerbox` build; no maintained Dockerfile found. Default port **2345** (`opensmppbox-port`); credentials live in a flat file set via `smpp-logins` (username/password/system-type/IP-restriction per line).
3. **SMPP versions**: "compliance to SMPP v3.3, SMPP v3.4 & SMPPv5.0" per the user guide. `interface_version` bind-time validation — not documented, unverified.
4. **Delivery receipts**: opensmppbox stores/forwards DLRs from Kannel's `bearerbox` (multiple backends: internal, MySQL, PostgreSQL, Oracle, SQLite3, MS-SQL) and "rewrites [them] to appear that they originated from OpenSMPPBox" back to the bound ESME. TLV vs text, exact `esm_class`, intermediate/failure/delayed-DLR simulation — not documented in the guide; unverified.
5. **Long messages**: supports `message_payload` TLV as an alternative to UDH concatenation when explicitly enabled; UDH re-splitting behavior on the MO side — unverified.
6. **Encodings**: guide only states it can "define the data coding type of the short message" — packed vs unpacked GSM7 behavior unverified.
7. **MO injection**: MO routing targets a specific bound ESME "based on shortcode, SMSC id, or randomly if unconfigured" — i.e. inbound traffic through Kannel's normal SMSC drivers gets forwarded to whichever ESME opensmppbox picks; no direct CLI/HTTP "inject one MO now" tool documented for opensmppbox itself (Kannel's own `fakesmsc`, see below, cannot fill this gap because it doesn't speak SMPP).
8. **Fault injection / TLS**: not documented for opensmppbox in the guide; unverified — treat as unsupported until proven otherwise.
9. **`fakesmsc` clarification (important)**: Kannel ships a **separate** testing tool `test/fakesmsc` that connects to `bearerbox`'s core `smsc = fake` group. Per Kannel's own 1.4.5 user guide (fetched directly from kannel.org): *"Fake SMSC is a simple protocol to test out Kannel. It is not a real SMS center, and cannot be used to send or receive SMS messages from real phones. So, it is ONLY used for testing purposes."* Its wire format is a trivial line-based text protocol (`sender receiver type message...`), confirmed from the `fakesmsc.c` usage text — **it does not speak SMPP at all**. It exists only to test Kannel's own HTTP `sendsms` interface end-to-end without a real carrier link. It is **not usable** to interoperability-test an external SMPP client library, despite superficially sounding like an SMSC simulator. Use opensmppbox for that instead.
10. **Minimal opensmppbox config** (from the [user guide](https://www.kannel.org/download/1.4.4/gateway-1.4.4/addons/opensmppbox/doc/userguide.xml)):
    ```
    group = smpp-logins
    smpp-logins = /etc/opensmppbox/smpp-logins.txt
    opensmppbox-port = 2345
    ```
    and in `smpp-logins.txt`: `myuser mypass VMA 0.0.0.0/0`
11. **Quirks**: Kannel's core `smpp` SMSC driver (Kannel acting as *client* connecting outbound to a real SMSC) is well documented and supports `interface-version` (hex string, default `"34"`), `msg-id-type` (bit-flags for hex/decimal `submit_sm_resp` vs `deliver_sm`), `max-pending-submits` (window, default 10), `enquire-link-interval` (default 30s), `use-ssl`/`ssl-client-cert` — but that's the *wrong direction* for this task (it's Kannel-as-ESME, not Kannel-as-SMSC). Given both Kannel and opensmppbox have had no significant commits in a decade, this path is the highest-effort, lowest-payoff of the "must include" list.

## 4. Melrose Labs SMSC Simulator

Two distinct things share the name:

- **Hosted public/commercial service** at `smscsim.melroselabs.com:2775` — closed-source, run by Melrose Labs.
- **Old open-source code** at [melroselabs/smpp-smsc-simulator](https://github.com/melroselabs/smpp-smsc-simulator), MIT license, C++11, single-file (`smscsimulator.cpp`) — repo explicitly says it "represents old version of existing SMSC Simulator service available online … newer version of code not published." Last push 2023-07-15.

1. Homepages: [melroselabs.com/services/smsc-simulator](https://melroselabs.com/services/smsc-simulator/), technical details at [smsc-simulator-technical-details](https://melroselabs.com/services/smsc-simulator/smsc-simulator-technical-details/), dedicated-instance doc at [ssg docs](https://ssgdocs.melroselabs.com/docs/smsc-simulator) / [scrollhelp](https://melroselabs.scrollhelp.site/dss/dedicated-smsc-simulator).
2. **Docker**: OSS repo has a `docker-compose.yml`; no image tag confirmed (repo has only source + compose, no published registry tag found). Default port 2775 in both the OSS code and the hosted service.
3. **SMPP versions**: "SMPP v3.3, v3.4 and v5" for the hosted service [technical details page]. `submit_sm_resp` message-id length differs by version: **8 characters for v3.3, 64 characters for v3.4 and v5** [same page] — hex/decimal notation not stated.
4. **Delivery receipts**: hosted shared service — text `short_message` receipt *plus* TLVs `receipted_message_id` and `message_state` (value 2 = DELIVERED) [technical details page]; shared/free tier is "delivered" status only, <1s after `submit_sm_resp`. **Dedicated** instances are configurable via a `dlr.conf`: DELIVERED(2)/EXPIRED(3)/DELETED(4)/UNDELIVERABLE(5)/ACCEPTED(6)/UNKNOWN(7)/REJECTED(8) with percentages, plus `--dlrlatency` (default 3s) for delayed DLRs, and a per-ESME `shouldReturnUndeliveredReceipts` override [dedicated simulator docs](https://melroselabs.scrollhelp.site/dss/dedicated-smsc-simulator).
5. **Long messages**: `message_payload` TLV (0x0424) supported on `submit_sm`/`deliver_sm`/`data_sm` [technical details page]. UDH / `sar_*` handling not documented — unverified.
6. **Encodings**: not documented for either tier — unverified; test empirically.
7. **MO injection**: on the shared simulator, MO is triggered by encoding **the bound system_id's digits into the destination address** (prepend/append ≥2 digits, min 8 chars total) [technical details page] — an unusual, non-obvious convention, worth automating carefully. Dedicated instances configure acceptable MSISDNs per-ESME via `esme_<systemid>.config`.
8. **Fault injection**: dedicated instance's `dlr.conf`/`shouldReturnUndeliveredReceipts` cover DLR-level faults; explicit `ESME_RTHROTTLED`/`ESME_RMSGQFUL`/bind-refusal/connection-drop simulation not documented for either tier — unverified.
9. **TLS**: shared service — "TLS 1.1 and up are supported for SMPP sessions. SSL and TLS 1.0 are not supported," on a separate port **8775** [main service page]. Dedicated instances also offer TLS as a paid option.
10. **Minimal use**: bind to `smscsim.melroselabs.com:2775` with credentials issued after signing up for a free developer account ([python tutorial](https://developers.melroselabs.com/docs/send-sms-with-smpp-using-python) shows the PDU shape but not the signup flow itself).
11. **Quirks / limits**: shared service capped at 100 SMS/sec; a separate, apparently-independent free public simulator is listed at `smscsim.smpp.org:2775` (max 2 SMS/sec) via [smpp.org's testing page](https://smpp.org/smpp-testing-development.html) — relationship to Melrose Labs unverified. Melrose Labs also offers standalone browser tools worth knowing about: an [SMPP client](https://melroselabs.com/) (bind/submit without installing anything), [SMPP Load Test](https://melroselabs.com/), and an [SMPP Analyser](https://melroselabs.com/) that captures a session to a downloadable pcap.

## 5. ukarim/smscsim — best lightweight OSS option

1. [github.com/ukarim/smscsim](https://github.com/ukarim/smscsim), Go, MIT, "Lightweight, zero-dependency and stupid SMSc simulator." GitHub push activity is current (last push 2025-12-12) — the most recently-touched OSS candidate found besides Jasmin/jsmpp.
2. **Docker**: `ukarim/smscsim` on Docker Hub. Highest **semver** tag is `0.2.0` (pushed ~3 years ago per Docker Hub); newer builds exist only as commit-hash tags (e.g. `a2c646d`, ~2 years ago) with no semver — **use `ukarim/smscsim:0.2.0` for a reproducible pinned tag**, or pin the specific commit-hash tag if you need the newer build and accept it's not semver.
   ```
   docker run -p 2775:2775 -p 12775:12775 ukarim/smscsim:0.2.0
   ```
   Ports: SMPP `2775` (env `SMSC_PORT`), web UI `12775` (env `WEB_PORT`). No auth/credentials required by default.
3. **SMPP version**: implements "only a small subset of the SMPP3.4 specification." PDUs: `bind_transmitter`, `bind_receiver`, `bind_transceiver`, `unbind`, `submit_sm`, `enquire_link`, `deliver_sm_resp`. Explicitly: **"simulator does not perform PDU validation"** — so it will not reject a bad `interface_version` or malformed PDU; not useful for negative-path bind testing.
4. **Delivery receipts**: fixed — DLR always returned ~2s after `submit_sm` with `message_state` **always DELIVERED**; no way to simulate other states except via the `FAILED_SUBMITS` fault-injection flag below. TLV vs text not detailed in the README.
5. **Long messages**: not documented — given the minimal PDU set, treat UDH/`sar_*`/`message_payload` support as unverified/likely absent.
6. **Encodings**: not documented — unverified.
7. **MO injection**: web page at `http://localhost:12775` sends a `deliver_sm` to the active session — simplest MO-injection UX of any candidate here.
8. **Fault injection**: `FAILED_SUBMITS=1` env var — even sequence numbers get a `submit_sm` system-error response, odd sequence numbers get an undeliverable DLR. No throttling, no bind refusal, no connection-drop simulation.
9. **TLS**: not mentioned — unsupported.
10. **Minimal run**: shown above; no config file, everything is env vars.
11. **Quirks**: "does not perform PDU validation" is explicit in the README — good for happy-path/throughput testing, useless for asserting your library correctly handles a *rejecting* SMSC.

## 6–13. Other candidates (condensed)

| Candidate | Notes |
|---|---|
| [mdouchement/smsc3](https://github.com/mdouchement/smsc3) | Go, MIT, SMPP3.4-based, port 20001 (SMPP)/6000 (HTTP). MO injection via `POST /deliver` with JSON `{session, sender, recipient, message}`. Has Dockerfile+compose but built around integrating with Kannel specifically. Last push 2024-05-09, low adoption (10 stars). |
| [K2InformaticsGmbH/smsc_simulator](https://github.com/K2InformaticsGmbH/smsc_simulator) | Erlang, Apache-2.0, speaks both SMPP and UCP. Abandoned — **last commit 2018-08-31**. Configured/driven from the Erlang shell (`smsc_simulator:start(smpp,10000)`), no Docker. Skip unless you specifically need UCP too. |
| [MavoCz/smscsim](https://github.com/MavoCz/smscsim) | Java, built on cloudhopper-smpp, so inherits 3.3/3.4/5.0 support and real PDU validation. Multi-port CLI (`-p 34567 34568 34569`), sends DLRs after a configurable fixed/random delay round-robin to connected RX/TRX binds. No Docker; requires Maven build + editing Spring XML for anything beyond port/log-level. Last-commit date unverified. |
| [fizzed/cloudhopper-smpp](https://github.com/fizzed/cloudhopper-smpp) (successor to [twitter-archive/cloudhopper-smpp](https://github.com/twitter-archive/cloudhopper-smpp), which is archived) | Java library, Apache-2.0, not a packaged simulator — but ships runnable demo classes (`make server`, `make server-echo`, `make simulator`, `make ssl-server`) covering SSL and PDU-dump. Good as a base to *write* a custom fixture, not a drop-in server. Last push 2020-10-12. |
| [jsmpp](https://github.com/opentelecoms-org/jsmpp) `jsmpp-examples/.../SMPPServerSimulator.java` | Java, Apache-2.0. jsmpp itself is very actively maintained (**last push 2026-06-17**) — best-maintained *library* in this whole survey. The bundled `SMPPServerSimulator` example demonstrates DLR sending and SSL, but is example code, not a packaged/dockerized tool — expect to fork and extend it. |
| [farhadi/node-smpp](https://github.com/farhadi/node-smpp) | Node.js, MIT, implements SMPP v5 (backward compatible with 3.4), includes both client and server APIs, supports `ssmpp://` TLS, UDH via `message_payload`, and encoding auto-detection (ASCII/Latin1/UCS2). No packaged simulator binary — you write ~30 lines of server code yourself. Last push 2023-12-28. Small existing forks built on it: [tiltroom/fakesmpp](https://github.com/tiltroom/fakesmpp), [theodorosidmar/smpp-server-simulator](https://github.com/theodorosidmar/smpp-server-simulator) (returns error on 1-in-10 `submit_sm`) — neither independently verified for maintenance/quality here. |
| [MikeSafonov/smpp-server-mock](https://github.com/MikeSafonov/smpp-server-mock) | Java, MIT, JUnit5-extension/Spring-Boot-starter mock server for *your own* test suite (assert on captured `SubmitSm`s) — not a standalone server you point an arbitrary client at. Only useful if you also write JVM-side interop tests. Last push 2023-03-10. |
| Restcomm/TeleStax SMSC Gateway "SMPP Simulator" | Bundled GUI test tool inside the RestComm SMSC Gateway product (`$SMSC_HOME/tools/TelScale-smpp-simulator/bin/run.sh`), default `system_id=test/password=test`, port 2776, transceiver bind, address range `6666` [docs](https://github.com/RestComm/smscgateway/blob/master/docs/adminguide/sources/src/main/resources/en-US/Chapter-smpp-simulator.xml). This is really a load-test client for RestComm's own gateway, not an installable-alone SMSC simulator — and the whole product requires a JSLEE stack. High setup cost for low unique coverage; skip unless you're specifically validating against a carrier-grade SS7-adjacent stack. |
| OsmoMSC SMPP interface | C, part of Osmocom's core-network stack (actively maintained as infrastructure, not as a "test double"). Its SMPP interface lets an ESME bind to a *real* (if simulated-radio) mobile-network MSC to send/receive SMS to subscribers — valuable only if you're also running an Osmocom test network; far too heavy just to test an SMPP library. Treat as out of scope for this project. |
| `smscsim.smpp.org` | Free public SMSC simulator, host/port from [smpp.org's testing page](https://smpp.org/smpp-testing-development.html): `smscsim.smpp.org:2775`, capped at 2 SMS/sec, delivered-only DLRs, per-IP connection limits. Ownership/maintenance unverified — treat as a convenience fallback, not a primary target. |
| Ozeki NG SMS Gateway / NowSMS | Both have a free/trial tier with SMPP server capability, both are closed-source and Windows-first (Ozeki explicitly; NowSMS also ships Linux/Docker in some tiers but is paid-oriented) — out of scope per task instructions beyond this line. |

---

## Recommendation — set these up first

1. **ukarim/smscsim** (Docker `ukarim/smscsim:0.2.0`) — near-zero setup cost, fastest possible CI smoke test: bind, submit, get a DLR, inject an MO from the web UI. Its explicit "no PDU validation" and single fixed DLR state are limitations, not blockers, for a first pass.
2. **Jasmin SMS Gateway** (Docker `jookies/jasmin:0.11.0` + RabbitMQ + Redis) — the only candidate here that is a real, still-developed production SMS gateway with a proper SMPP **server** role, HTTP management, and a DLR pipeline distinct from a toy simulator. Exercises your library against genuinely different internals (Python/Twisted, AMQP-backed message routing) than the Go/Java toys.
3. **Melrose Labs hosted SMSC Simulator** (`smscsim.melroselabs.com:2775`, free tier) — a public, independently-run, closed-box target you don't control, which is exactly the point: it validates your library against an implementation you cannot special-case for. Its TLS port (8775) also covers your TLS interop case for free without standing up your own CA. Follow up with a **dedicated** instance (paid) once you need to script specific DLR failure/latency states via `dlr.conf`.
4. **SMPPSim, built yourself from `kwahome/smpp-sim-docker`** — despite the dead upstream site and lack of a pinned tag, it's the only candidate with rich, config-file-driven **fault injection** (percentage-based delivered/undeliverable/rejected/accepted, intermediate-state transition chance, delayed DLRs, outbind support, MO queue-full retry behavior). Worth the one-time cost of building and tagging your own image specifically to cover the failure- and delay-injection matrix nothing else here offers as cleanly.

Skip Kannel/opensmppbox and `fakesmsc` for now: both Kannel and opensmppbox have had no meaningful commits in a decade, opensmppbox's interop behavior (TLS, throttling, interface_version validation) is entirely undocumented, and `fakesmsc` — despite the name — doesn't speak SMPP at all, so it cannot test this library regardless of effort spent.
