# Nephele Wisp — Permissions Justification

This document explains why each permission requested in
`extension/manifest.json` is needed. It exists primarily for Chrome Web
Store / Edge Add-ons reviewers and for users who want to verify
the extension does not request more than it needs.

## API permissions

### `nativeMessaging`

**Why it's required.** Wisp's entire purpose is to relay upload
requests between the Nephele Workshop desktop application and the
browser. The standard channel for desktop ↔ extension IPC in Chromium
is Native Messaging. Without this permission, Wisp cannot receive any
work from the desktop app.

**Scope.** Wisp connects only to the registered Native Messaging Host
named `com.arisfusion.nephele_wisp`. The host's manifest is installed
by Nephele Workshop's installer and points at the `nephele.exe --nmh`
binary. Wisp does not connect to any other native host.

### `storage`

**Why it's required.** Wisp persists a single value: a randomly-
generated per-profile ID (`wp_<uuid>`) that is sent to the desktop app
on handshake so it can recognize repeat connections from the same
browser profile.

**Scope.** Only `chrome.storage.local` is used, and only for that one
key (`wisp_profile_id`). No user content is stored.

### `debugger`

**Why it's required.** Wisp drives upload forms by synthesizing input
events through the Chrome DevTools Protocol (CDP). This is the only
documented Chromium mechanism that produces input events platforms
recognize as user-driven, while remaining clearly user-initiated:
Chrome displays a persistent yellow "Nephele Wisp started debugging
this browser" notification bar on every tab Wisp attaches to.

Two specific automation problems require `debugger` and have no
alternative:

1. **File upload from the local file system.** Some platforms (e.g.
   bilibili) prefer the File System Access API and need `Page.
   addScriptToEvaluateOnNewDocument` to fall back to a traditional
   `<input type="file">`, plus `DOM.setFileInputFiles` to deliver the
   file path. The standard `chrome.scripting` API runs after page
   load — too late for FSA-detection bundles.

2. **Trusted-input gates.** Some Vue/React components only accept
   actions from a real mouse path (move-then-click with intermediate
   `mouseMoved` events). `chrome.scripting` programmatic clicks fail
   these gates; CDP `Input.dispatchMouseEvent` succeeds because the
   browser treats it as a real input event.

**Scope.** Wisp attaches the debugger ONLY to tabs it has opened
itself (via `chrome.tabs.create({url: 'about:blank'})`), never to a
user-active tab. The debugger is detached on every cleanup path. The
`debugger` permission is gated on a deliberate user action in the
desktop app — Wisp never attaches without an explicit
`publisher.upload_draft` request originating from the user-facing UI
process.

### `tabs`

**Why it's required.** `chrome.tabs.create` opens the automation tab;
`chrome.tabs.remove` closes it on cleanup paths where the user does
not need the draft tab to remain.

**Scope.** Wisp only creates and removes tabs that it created itself.
It does not enumerate, query, or modify other tabs.

### `scripting`

**Why it's required.** Used by `chrome.debugger`'s
`Page.addScriptToEvaluateOnNewDocument` flow on platforms that require
patching `window` globals (e.g. removing `window.showOpenFilePicker`
on bilibili so the bundle takes its `<input type="file">` fallback
path) before any page script runs.

**Scope.** Scripts inject into the automation tab only, and only the
short stubs documented in each handler under `extension/background/
handlers/`. No persistent content scripts.

## Host permissions

Each host pattern below corresponds to a single platform handler that
implements an image-post upload flow on that domain. Wisp connects to
none of them outside an active `publisher.upload_draft` request.

| Host | Handler | Purpose |
|---|---|---|
| `*://*.bilibili.com/*` | `publisher_bilibili.js` | Bilibili dynamic-post draft upload |
| `*://*.xiaohongshu.com/*` | `publisher_xiaohongshu.js` | Xiaohongshu image-note draft (creator subdomain) |
| `*://*.weibo.com/*`, `*://*.weibo.cn/*` | `publisher_weibo.js` | Weibo image-post compose |
| `*://*.douyin.com/*` | `publisher_douyin.js` | Douyin image-text draft |
| `*://*.pixiv.net/*` | `publisher_pixiv.js` | Pixiv illust upload |
| `*://*.x.com/*`, `*://*.twitter.com/*` | `publisher_twitter.js` | Twitter/X tweet compose |
| `*://*.artstation.com/*` | `publisher_artstation.js` | ArtStation artwork submit |
| `http://127.0.0.1/*` | `asset.js` | Local-only asset transfer over HTTP from Nephele Workshop's per-session asset server. Tokens are one-time, expire in 5 minutes, and the server binds 127.0.0.1 only. |

## Single purpose

Per the Chrome Web Store program policy, this extension has a single
purpose:

> Bridge the Nephele Workshop desktop application to the user's browser
> so the desktop app can populate upload forms on social-media platforms
> using the user's own logged-in browser session, then stop at "draft
> ready" so the user can review and publish manually.

## What Wisp will not do

These are non-goals enforced by the protocol and audited by the test
suite:

- **Wisp never clicks the final publish/send button** on any platform.
  All flows stop at "draft saved"; the user reviews the filled form
  in the browser and publishes manually.
- **No auto-liking, following, commenting, captcha-bypass, or
  multi-account orchestration.**
- **No background scraping or data collection** outside the active
  upload request the user just initiated from the desktop app.
- **No auto-dismiss of platform agreement / ToS / paywall modals.** If
  Wisp encounters an unexpected blocking dialog, it bails with
  `ACTION_REQUIRED` and leaves the tab open for the user to handle.

See `docs/PROTOCOL.md` §"Humanization Pipeline (non-negotiable)" and
§"Rate Limits" for the hard caps the extension enforces regardless of
what the desktop app requests.
