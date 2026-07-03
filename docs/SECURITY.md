# Security & Audit

Wisp is a browser extension that, by necessity, requests powerful
permissions: it uses `chrome.debugger` to dispatch synthetic events and read
pages, and it bridges to a local desktop process the user has installed.

Any user installing Wisp is trusting it with their logged-in identity on
every site listed in `host_permissions`. This document describes what we do
to earn that trust and how you can verify it.

## Auditability commitments

1. **All extension source is in this repository.** The store artifact is
   built from a tagged commit by `scripts/pack.py`, which produces a
   **deterministic** zip (sorted entries, fixed timestamps) — the same
   commit always yields a byte-identical zip. Anyone can run
   `python scripts/pack.py` from the tagged commit and diff the result
   against the Store version's unpacked source.

2. **No bundler, no minification.** `pack.py` does not bundle, mangle,
   minify, or rewrite identifiers. It only (a) strips `@wisp-dev-only`
   blocks, (b) injects the build version into `BUILD_SHA`, and (c) drops
   `README.md` files. Shipped JS is identical to the source minus the
   dev-only blocks. The pack **fails** if any dev-only token survives.

3. **No remote code.** MV3 forbids runtime remote script loading and we do
   not work around it. The one developer probe that runs arbitrary JS in a
   tab (`system.eval`, used during development by the desktop repo's
   `scripts/wisp_probe.py`) is wrapped in `@wisp-dev-only` markers and
   **stripped from the store artifact by `pack.py`** — the shipped extension
   contains no arbitrary-eval route. Every update goes through Store review.

4. **No analytics, no telemetry.** The extension makes no network requests
   to any host other than (a) the platform domains in `host_permissions`,
   in the user's session, to carry out a request the user initiated, and
   (b) the local Nephele process at `127.0.0.1:<session port>` for asset
   transfer. No Google Analytics, no Sentry, no PostHog, no ping home.

## Permission justifications

Every permission Wisp requests, why it's needed, and what narrower
alternative was considered. Full detail in `docs/PERMISSIONS.md`.

### `nativeMessaging`
**Why**: connect to the local Nephele Workshop desktop process.
**Narrower alternative**: none — MV3's only sanctioned extension↔local-app
bridge.

### `debugger`
**Why**: dispatch synthetic mouse/keyboard events with the humanization
envelope in PROTOCOL.md and read pages in the user's session. Pure
content-script DOM manipulation cannot reliably handle `<input type="file">`
or cross trusted-input gates.
**Narrower alternative**: none viable for the scope.
**User visibility**: Chrome displays a yellow "Wisp is debugging this
browser" bar on affected tabs. Intentional, not hidden. Wisp attaches only
to tabs it opened itself.

### `storage`
**Why**: local-only storage of the handshake per-profile ID. No cookies, no
access tokens, no credentials.

### `tabs`
**Why**: open the per-task automation tab, find it for a request, and close
it on cleanup. Wisp never disrupts the user's own tabs.

### `alarms`
**Why**: a 30-second keepalive heartbeat. MV3 service workers suspend after
~30s idle, which would drop the Native Messaging connection; the alarm
re-wakes the worker. `setInterval` cannot survive worker recycling.

### `host_permissions`: `<all_urls>`
**Approach**: broad host access. Wisp acts in the user's session on whatever
site they are working with — publishing, reading, and collecting/clipping
references — and reference-image bytes live on per-platform CDN domains
(`i.pximg.net`, `i.pinimg.com`, `pbs.twimg.com`, …) distinct from the site, so
a fixed list silently fails on the next site/CDN. We do not under-scope into a
list we would constantly outgrow; comparable clippers (e.g. Eagle) request the
same. The trust guarantee here is **behavioural, not scope-based** (see "What
the extension never does" below and the auditability commitments above): broad
reach, but Wisp acts only on user- / desktop-initiated requests, never in the
background, never auto-confirms a write, ships no remote code, sends no
telemetry, and returns data only to the local desktop process. The local
asset/ingest channel (`127.0.0.1`, one-time 5-min tokens, loopback-bound) is
covered by this.

## What the extension never does

These are hardcoded absences, not toggleable settings:

- Never exfiltrates user data to any server other than the local Nephele
  process.
- Never reads, writes, or hashes arbitrary files on the user's filesystem —
  asset transfer goes exclusively through the Nephele asset-server URL.
- Never stores cookies, access tokens, or credentials in extension storage.
- Never performs a write action on a platform unless the desktop side issued
  a corresponding request.
- Never auto-confirms a final publish / reply / send action — every write's
  last click is user-initiated or user-previewed.
- Never solves captchas — detection pauses the task and asks the user.
- Never switches user accounts on a platform.
- Never reads pages in the background or on a schedule — every read is for a
  request the user just initiated.

## Data handling

Data the extension reads for a request (the filled draft's metadata, the
user's own creator stats, or reference-image metadata/thumbnails) is
returned to the local Nephele process and stored on the user's machine. The
extension itself never sends platform data anywhere else.

Data leaves the user's machine only when the user explicitly invokes a Cloud
MAX AI feature in the desktop app that needs specific data as context, in
which case only the minimum subset needed is sent to Nephele's API over
HTTPS, with user-visible indication. That egress is the desktop app's, under
Nephele Workshop's privacy policy — not the extension's.

## Clip flow (`reference.clip`)

The context-menu / keyboard clip surfaces fire a fire-and-forget
`reference.clip` event carrying **page-controlled** metadata (`src_url`,
`link_url`, `selection_text`, `page_url`, and — for image clips on known feed
hosts — `post_url` / `post_time`, read from the clicked item's enclosing feed
card via a read-only in-page script). The extension deliberately does
**not** sanitize these — filtering would break legitimate image clipping — so
the trust boundary is the **desktop** `reference.clip` handler, which MUST:

- Reject any `src_url` / `link_url` not starting with `http://` or `https://`
  (blocks `data:`, `blob:`, `file:`, `javascript:`).
- Block SSRF targets before any outbound fetch: loopback and RFC-1918 /
  link-local ranges — `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`,
  `192.168.0.0/16`, `169.254.0.0/16`, `::1`, `fd00::/8`. A page can set
  `<img src="http://127.0.0.1:<port>/...">` to aim a clip at a local service
  (including Nephele's own asset/IPC ports).
- Treat `selection_text` and `tab_title` as untrusted: never use them as a
  filename, path component, or shell argument without sanitization.
- Treat `post_url` / `post_time` as untrusted: accept `post_url` only after
  re-parsing it into a known work-page form for the clip's platform (a hostile
  page could plant an arbitrary URL as the saved item's provenance), and parse
  `post_time` only through a strict date parser — never store it verbatim.

This requirement is locked in here **before** the desktop handler is written.
The desktop guard blocks literal private/loopback/link-local/reserved IP targets
(including IPv4-mapped IPv6 like `::ffff:127.0.0.1`) and `localhost`-family
hostnames. It deliberately does **not** resolve other hostnames: desktop DNS is
unreliable behind fake-IP proxies (Clash/FlClash return `198.18.x.x`
placeholders that look `is_private` and would false-positive every real CDN
host). **Accepted residual**: a hostname that itself resolves to a private
target is allowed — but the impact is local-read-only (the fetched bytes land in
the user's own local library, never an attacker's server; there is no exfil
path), it needs attacker DNS control, and the literal-IP vectors are still
blocked. Net risk is low; chosen over breaking clipping for every proxy user.

## Reporting vulnerabilities

Email `arisyingying13@gmail.com` with `[Wisp Security]` in the subject. Do
not file public GitHub issues for vulnerabilities until a fix has shipped.
First response within 72 hours.

## Known trust gaps

Full transparency — things we currently cannot prove:

- **The Nephele Workshop desktop binary is closed-source.** The extension
  returns data to Nephele via Native Messaging; what Nephele does with it is
  not auditable from this repository alone.
- **Chrome's Web Store delivery pipeline is not byte-reproducible.** We
  build from a tagged SHA with a deterministic `pack.py`, but Chrome
  re-signs the CRX. The git-to-zip diff is what we offer; CRX byte-equality
  is not possible under Web Store policy.
- **Compromise of the Nephele desktop process would let it drive the
  extension within the permissions the user granted.** `system.eval` is not
  in the store build, but the publisher/reference/creator request handlers
  are, and they act in the user's session on the desktop app's behalf. Key
  hygiene of the desktop peer is a Nephele Workshop concern; extension
  auditability does not extend to the desktop peer's integrity.
