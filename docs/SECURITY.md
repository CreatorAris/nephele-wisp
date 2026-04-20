# Security & Audit

Wisp is a browser extension that, by necessity, requests powerful
permissions: it uses `chrome.debugger` to dispatch synthetic events,
it reads authenticated pages on major social platforms, and it bridges
to a local desktop process that the user has already installed.

Any user installing Wisp is trusting it with their logged-in identity
on every site listed in `host_permissions`. This document describes
what we do to earn that trust and how you can verify it.

## Auditability commitments

1. **All extension source is in this repository.** The code served by
   Chrome Web Store and Edge Add-ons is built from a specific commit
   SHA recorded in each GitHub Release. Anyone can `npm run build`
   from that commit and diff the resulting zip against the Store
   version. See `scripts/verify-store-build.md` (ships with v0.4) for
   the diff procedure.

2. **No identifier-destroying minification.** Production builds pass
   through esbuild bundling but do NOT mangle names, do NOT inline
   identifiers, and do NOT apply source-map-destroying transforms.
   Shipped JS is as readable as the source, just concatenated.

3. **No remote code.** MV3 forbids runtime remote script loading; we
   do not work around this. All logic ships in the bundle; every
   update goes through Web Store review.

4. **No analytics, no telemetry.** The extension makes no network
   requests to any host other than (a) the target platform domains
   listed in `host_permissions`, and (b) the local Nephele process at
   `127.0.0.1:<session port>` for asset transfer. No Google Analytics,
   no Sentry, no PostHog, no heartbeat ping home.

## Permission justifications

Every permission Wisp requests, why it's needed, and what narrower
alternative was considered.

### `nativeMessaging`
**Why**: connect to the local Nephele Workshop desktop process.
**Narrower alternative**: none — this is MV3's only sanctioned bridge
from an extension to a local app.

### `debugger`
**Why**: dispatch synthetic mouse/keyboard events with the
humanization envelope in PROTOCOL.md. Pure content-script DOM
manipulation cannot cross Shadow DOM boundaries or reliably handle
`<input type="file">`; we would either break on real platforms or
simulate poorly enough to trip anti-automation.
**Narrower alternative**: none viable for the scope.
**User visibility**: Chrome displays a yellow "Wisp is debugging this
browser" bar on affected tabs. This is intentional and not hidden.

### `storage`
**Why**: local-only storage for handshake state, per-platform
cooldown timers, user preferences. No sensitive data — no cookies,
no access tokens, no credentials.

### `tabs`
**Why**: open a new background tab per task so Wisp never disrupts
the user's currently focused tab.

### `scripting`
**Why**: programmatic injection of content scripts on the specific
task tab, rather than blanket auto-injection.

### `alarms` (v0.4.1+)
**Why**: periodic creator-dashboard sync at 30-minute intervals.
Required because MV3 service workers cannot use `setInterval`
reliably (service worker is suspended after 30s idle).

### `host_permissions`
**Approach**: enumerated per platform, never `<all_urls>`. Expanded
additively each version. See ROADMAP.md for the list at each
milestone. Justification submitted to Web Store per domain on each
update.

## What the extension never does

These are hardcoded absences, not toggleable settings:

- Never exfiltrates user data to any server other than the local
  Nephele process.
- Never reads, writes, or hashes arbitrary files on the user's
  filesystem — asset transfer goes exclusively through the Nephele
  asset-server URL.
- Never stores cookies, access tokens, or credentials in extension
  storage.
- Never performs write actions on a platform unless the desktop side
  issued a corresponding request signed with the session token.
- Never auto-confirms a final publish / reply / send action — every
  write's "last click" is user-initiated or user-previewed.
- Never solves captchas — detection pauses the task and asks the user.
- Never switches user accounts on a platform.

## Data handling

All platform data fetched by the extension (creator stats, comments,
DMs, post metrics) is forwarded to the local Nephele process and
stored on the user's machine under
`~/.nephele_workshop/creator_data/`.

Data leaves the user's machine only when:
- the user explicitly invokes a Cloud MAX AI feature that needs
  specific data as context (e.g. "summarize my last 50 comments"),
- in which case only the minimum subset needed for that invocation
  is sent to Nephele's API over HTTPS, with user-visible indication.

Wisp itself never sends platform data anywhere.

## Reporting vulnerabilities

Email `arisyingying13@gmail.com` with `[Wisp Security]` in the
subject. Do not file public GitHub issues for vulnerabilities until
a fix has shipped. First response within 72 hours.

## Known trust gaps

Full transparency — things we currently cannot prove:

- **The Nephele Workshop desktop binary is closed-source.** The
  extension forwards data to Nephele via NMH; what Nephele does with
  it is not auditable from this repository alone. Users trusting the
  extension must also be separately satisfied with Nephele's handling.
- **Chrome's Web Store delivery pipeline is not byte-reproducible.**
  We commit to building from a tagged SHA and documenting the SHA in
  each release, but Chrome re-signs the CRX. The git-to-zip diff is
  what we offer; CRX byte-equality is not possible under Web Store
  policy.
- **Compromise of the Nephele code-signing key would allow a
  malicious Nephele binary to continue speaking the protocol.** Key
  hygiene is a Nephele Workshop concern, not a Wisp concern, but
  the reader should be aware that extension auditability does not
  extend to the desktop peer's integrity.
