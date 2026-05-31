# Nephele Wisp — Permissions Justification

This document explains why each permission requested in
`extension/manifest.json` is needed. It exists primarily for Chrome Web
Store / Edge Add-ons reviewers and for users who want to verify the
extension does not request more than it needs.

Every host permission below has a handler that uses it. We do not declare
permissions for features that have not shipped; when a new platform handler
lands, its host is added in the same release.

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

## Host permissions

Each host below has a handler that acts on it, in your logged-in session,
only when you initiate a matching request from the desktop app. The request
classes are: `publisher.upload_draft` (fill an upload form),
`creator.fetch_stats` (read your own creator dashboard), and
`reference.fetch_*` (collect reference images from a search).

| Host | Handler(s) | Purpose |
|---|---|---|
| `*://*.bilibili.com/*` | `publisher_bilibili.js`, `creator_bilibili.js` | Bilibili dynamic-post draft upload; read your own creator stats |
| `*://*.xiaohongshu.com/*` | `publisher_xiaohongshu.js` | Xiaohongshu image-note draft (creator subdomain) |
| `*://*.weibo.com/*`, `*://*.weibo.cn/*` | `publisher_weibo.js` | Weibo image-post compose (desktop + mobile domains of the same platform) |
| `*://*.douyin.com/*` | `publisher_douyin.js` | Douyin image-text draft |
| `*://*.pixiv.net/*` | `publisher_pixiv.js`, `creator_pixiv.js` | Pixiv illust upload; read your own creator stats |
| `*://*.x.com/*`, `*://*.twitter.com/*` | `publisher_twitter.js` | Twitter/X compose (both domains of the same platform) |
| `*://*.artstation.com/*` | `publisher_artstation.js`, `reference_artstation.js` | ArtStation artwork submit; reference search via the public search API |
| `*://*.pinterest.com/*` | `reference_pinterest.js` | Reference search — read pin-grid image metadata in your session |
| `*://*.huaban.com/*` | `reference_huaban.js` | Reference search — read pin metadata and fetch thumbnails the CDN serves only to a real logged-in browser |
| `http://127.0.0.1/*` | `asset.js` | Local-only asset transfer from Nephele Workshop's per-session asset server. Tokens are one-time, expire in 5 minutes, and the server binds 127.0.0.1 only. |

`host_permissions` is enumerated per platform — never `<all_urls>` — and
expanded additively as handlers ship.

## Single purpose

Per the Chrome Web Store program policy, this extension has a single
purpose:

> Act as the browser-side half of the Nephele Workshop desktop application:
> carry out the publishing-workflow requests the desktop app sends —
> filling upload forms (and stopping at "draft ready" for manual review),
> reading the user's own creator stats, and collecting reference images —
> all inside the user's own logged-in browser session, and return the
> results to the desktop app. The extension does nothing on its own; every
> action originates from the desktop app.

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
