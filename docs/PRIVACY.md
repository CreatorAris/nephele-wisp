# Nephele Wisp — Privacy Policy

_Last updated: 2026-04-28_

## Summary

Nephele Wisp is a browser extension that bridges the Nephele Workshop
desktop application to your browser so the desktop app can fill upload
forms on social media sites you're already logged into.

**Wisp does not collect, transmit, or store any of your personal data on
any remote server.** All communication is between the extension and the
Nephele Workshop desktop process running on the same computer, over a
loopback connection (`127.0.0.1`) and the browser's Native Messaging
channel.

## Data the extension handles

The extension is exposed to the following data while a request is being
processed:

| Data | Source | Where it goes |
|---|---|---|
| Image bytes you asked the desktop app to upload | Local-only HTTP server on `127.0.0.1`, one-time token URL issued by the desktop app | Read into a Blob, verified against a SHA-256 hash, then handed to the platform's `<input type="file">` via Chrome DevTools Protocol. Never sent anywhere else. |
| The text you asked the desktop app to use as a post title / caption / topic | Native Messaging from the desktop app | Typed into the platform's compose form. Never sent anywhere else. |
| Your current page URL on the platform you're posting to | DevTools Protocol on the tab Wisp opens itself | Used to detect login walls / captcha / wrong page; reported back to the desktop app as part of the response. Never sent to a third party. |
| A randomly-generated stable per-profile ID (`wp_<uuid>`) | Generated and stored in `chrome.storage.local` | Sent to the desktop app on handshake so it can correlate repeat connections from the same browser profile. Not linked to any platform account, real-world identity, or telemetry system. |

## Data the extension does NOT handle

- Browsing history
- Cookies, session tokens, or credentials of any platform
- Form input outside the upload flows it actively drives
- Any data from tabs that Wisp did not open itself

## Where data goes

- **All data flows are local.** The desktop app (Nephele Workshop) runs
  on the same machine. Wisp connects to it via Chrome Native Messaging,
  which Chrome restricts to processes the user has explicitly allowed.
- **No external servers, no analytics, no telemetry.** The extension
  does not contact any host other than the platforms listed in
  `host_permissions` (and only to drive the upload form you initiated)
  and the local asset server on `127.0.0.1`.
- **The desktop app's own privacy is governed by Nephele Workshop's
  privacy policy** at <https://arisfusion.com/privacy>. Wisp itself is
  a passive bridge — anything that leaves your machine does so through
  the desktop app, not the extension.

## debugger permission

Wisp uses Chrome's `debugger` API (`chrome.debugger`) to drive the
upload form. Chrome shows a yellow "Nephele Wisp started debugging this
browser" notification bar on every tab Wisp attaches to — this is the
visible indicator that automation is happening. Wisp only attaches to
tabs it has opened itself; it never attaches to tabs you opened
manually.

## Data retention

The only data Wisp retains across browser restarts is the per-profile
ID (a UUID, stored in `chrome.storage.local`). Image bytes, captions,
URLs, and tab references are held only for the lifetime of a single
upload request and discarded on completion. Asset transfer tokens
expire 5 minutes after issue and are single-use.

## Children

Wisp is part of a paid creator tool intended for adult professional
artists. The extension itself does not collect age data.

## Contact

Source code is open at <https://github.com/CreatorAris/nephele-wisp>
(MIT). Security disclosures and questions:
**arisyingying13@gmail.com**.

## Changes

Material changes to this policy will be reflected in this document and
in the extension's release notes.
