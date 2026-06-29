# Nephele Wisp — Permissions Justification

This document explains why each permission requested in
`extension/manifest.json` is needed. It exists primarily for Chrome Web
Store / Edge Add-ons reviewers and for users who want to verify the
extension does not request more than it needs.

Wisp requests broad host access (`<all_urls>`) because its job — acting in the
user's own session on whatever site the user is working with — is inherently
all-sites. The trust model is deliberately NOT "request a narrow scope" (the
user browses everywhere; an enumerated list silently fails on the next site or
CDN) but "request what the job needs, and constrain BEHAVIOUR tightly and
verifiably" (see `docs/SECURITY.md`). Every action is user- or
desktop-app-initiated; Wisp does nothing on its own.

## API permissions

### `nativeMessaging`

**Why it's required.** Wisp's purpose is to carry out requests from the
Nephele Workshop desktop application inside the browser. The standard
channel for desktop ↔ extension IPC in Chromium is Native Messaging.
Without this permission, Wisp cannot receive any work from the desktop app.

**Scope.** Wisp connects only to the registered Native Messaging Host
`com.arisfusion.nephele_wisp`, whose manifest is installed by Nephele
Workshop's installer and points at the `nephele.exe --nmh` binary. Wisp
does not connect to any other native host.

### `storage`

**Why it's required.** Wisp persists a single value: a randomly-generated
per-profile ID (`wp_<uuid>`) sent to the desktop app on handshake so it can
recognize repeat connections from the same browser profile.

**Scope.** Only `chrome.storage.local`, only the key `wisp_profile_id`. No
user content is stored.

### `debugger`

**Why it's required.** Wisp drives upload forms and reads pages by
synthesizing input and observing the page through the Chrome DevTools
Protocol (CDP). This is the only documented Chromium mechanism that
produces input platforms recognize as user-driven while remaining clearly
user-initiated: Chrome displays a persistent yellow "Nephele Wisp started
debugging this browser" notification bar on every tab Wisp attaches to.

Two automation problems require `debugger` and have no alternative:

1. **File upload from the local file system.** Some platforms prefer the
   File System Access API and need `Page.addScriptToEvaluateOnNewDocument`
   (a CDP method) to fall back to a traditional `<input type="file">`, plus
   `DOM.setFileInputFiles` to deliver the file. A content-script approach
   runs after page load — too late for FSA-detection bundles.
2. **Trusted-input gates.** Some Vue/React components only accept a real
   mouse path (move-then-click with intermediate `mouseMoved` events).
   Programmatic clicks fail these gates; CDP `Input.dispatchMouseEvent`
   succeeds because the browser treats it as real input.

**Scope.** Wisp attaches the debugger ONLY to tabs it has opened itself
(via `chrome.tabs.create`), never to a tab you opened. The debugger is
detached on every cleanup path. Wisp never attaches without a request that
originated from the desktop app.

### `tabs`

**Why it's required.** `chrome.tabs.create` opens the automation tab;
`chrome.tabs.remove` closes it on cleanup paths where the draft tab is not
needed; `chrome.tabs.query` finds the automation tab for a request.

**Scope.** Wisp only operates on tabs it created itself. It does not read or
modify your other tabs.

### `alarms`

**Why it's required.** MV3 service workers are suspended after ~30s idle,
which would tear down the Native Messaging connection to the desktop app.
Wisp registers a `chrome.alarms` periodic alarm (30s) as a keepalive: each
tick re-wakes the service worker and resets the idle timer, keeping the
desktop ↔ extension pipe alive. `setTimeout` / `setInterval` cannot do this
because their callbacks are destroyed when the worker is recycled; alarms
persist and re-wake it.

**Scope.** The alarm only fires the keepalive heartbeat. It performs no DOM
work and initiates no uploads or reads — those always require an explicit
request from the desktop app.

## Host permissions: `<all_urls>`

**Why broad access is required.** Wisp acts inside the user's logged-in
session to do work the desktop app requests, on whatever site the user is
working with. The request classes are:

- **`publisher.upload_draft`** — fill an upload / compose form on the platform
  the user is publishing to (stops at "draft ready" for manual review).
- **`creator.fetch_stats`** — read the user's own creator dashboard.
- **`reference.*` / `browser.read_page` / `browser.interact`** — read a page,
  collect reference images, or clip an image the user picked, from any site the
  user is researching or collecting from.

These are not confined to a fixed platform list. A user researches references
and clips images from anywhere on the web, and reference-image *bytes* live on
per-platform CDN domains (`i.pximg.net`, `i.pinimg.com`, `pbs.twimg.com`, …)
that differ from the site's own domain — so even an enumerated site list would
silently fail to fetch the actual images. A fixed allow-list would break on the
next site or CDN the user visits. Comparable reference/clipper tools (e.g.
Eagle) request `<all_urls>` for exactly this reason.

**Why this is safe — behaviour, not scope, is the real constraint.** Broad
access is bounded by hard, repository-verifiable behavioural limits (see
`docs/SECURITY.md`):

- **No background or scheduled activity.** Every read / clip / form-fill
  happens only in response to an action the user just initiated in the desktop
  app, or a context-menu / keyboard clip the user invoked. Wisp never crawls.
- **Visible.** `chrome.debugger` shows Chrome's persistent "Nephele Wisp
  started debugging this browser" bar; Wisp attaches only to tabs it opened.
- **No final writes without the user.** Publish / send always stops for manual
  confirmation; Wisp never clicks the final button.
- **Data stays local.** Read data returns only to the local Nephele desktop
  app — never to a server of ours. No telemetry, no remote code.

The local asset / ingest channel runs on `127.0.0.1` (one-time tokens, 5-min
expiry, loopback-bound), covered by `<all_urls>`.

## Single purpose

Per the Chrome Web Store program policy, this extension has a single
purpose:

> Act as the browser-side half of the Nephele Workshop desktop application:
> carry out the requests the desktop app sends inside the user's own
> logged-in browser session — filling upload forms (and stopping at "draft
> ready" for manual review), reading the user's own creator stats, reading
> pages, and collecting or clipping reference images — and return the results
> to the desktop app. The extension does nothing on its own; every action
> originates from the desktop app or a clip the user explicitly invoked.

## What Wisp will not do

These are non-goals enforced by the protocol and audited by the test suite:

- **Wisp never clicks the final publish/send button** on any platform. All
  publish flows stop at "draft saved"; you review and publish manually.
- **No auto-liking, following, commenting, captcha-bypass, or multi-account
  orchestration.**
- **No covert or background collection.** Every page Wisp reads is for a
  request you just initiated from the desktop app; Wisp never reads pages on
  a schedule or in the background, and the data goes only to your local
  desktop app, never to a server of ours.
- **No auto-dismiss of platform agreement / ToS / paywall modals.** On an
  unexpected blocking dialog, Wisp bails with `ACTION_REQUIRED` and leaves
  the tab open for you.

See `docs/PROTOCOL.md` §"Humanization Pipeline (non-negotiable)" and
§"Rate Limits" for the hard caps the extension enforces regardless of what
the desktop app requests.

## Dev-only code is not in the store build

The repository contains a `system.eval` developer probe (used by the
desktop repo's `scripts/wisp_probe.py` to diagnose handler DOM drift during
development). It is wrapped in `@wisp-dev-only` markers and **stripped from
the packaged store artifact by `scripts/pack.py`**, which fails the build if
any dev-only code survives. The shipped extension contains no arbitrary-eval
route. See `docs/SECURITY.md`.
