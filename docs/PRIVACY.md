# Nephele Wisp — Privacy Policy

_Last updated: 2026-06-30_

## Summary

Nephele Wisp is a browser extension that bridges the Nephele Workshop
desktop application to your browser. It acts only on requests the desktop
app sends, using your existing logged-in browser session, and returns the
result to the desktop app.

**Wisp does not collect, transmit, or store any of your data on any remote
server.** Every request originates from the Nephele Workshop desktop
process running on the same computer, and every result is returned to that
same local process over a loopback connection (`127.0.0.1`) and the
browser's Native Messaging channel. Wisp has no server of its own and no
analytics or telemetry.

## What Wisp does, and the data each request handles

Wisp performs the kinds of request below. Each one is explicitly initiated
by you — from the Nephele Workshop desktop app, or, for the clipper, by your
own context-menu click or keyboard shortcut. None of them runs in the
background or on a schedule you did not start.

### 1. Publishing a draft (`publisher.upload_draft`)

Fills an upload form on a platform you choose and stops at "draft ready"
for you to review and publish manually.

| Data | Source | Where it goes |
|---|---|---|
| Image bytes you asked the desktop app to upload | Local-only HTTP server on `127.0.0.1`, one-time token URL issued by the desktop app | Read into a Blob, verified against a SHA-256 hash, handed to the platform's `<input type="file">` via CDP. Never sent anywhere else. |
| The title / caption / topic text you provided | Native Messaging from the desktop app | Typed into the platform's compose form. Never sent anywhere else. |
| The current page URL on the platform | The tab Wisp opens itself | Used to detect login walls / captcha / wrong page; reported back to the desktop app. Never sent to a third party. |

### 2. Collecting reference images (`reference.fetch_*`)

When you run a reference search in the desktop app, Wisp opens the search
page for the source you chose (e.g. Pinterest, Huaban, ArtStation, or another
site you search) and reads the results, so the desktop app can show you
reference thumbnails. This is the same thing you would do by searching the
site yourself; Wisp does it in your session so the result matches what you
would see.

| Data | Source | Where it goes |
|---|---|---|
| Public image metadata from search results — thumbnail URL, large-image URL, source page URL, title / alt text, dimensions | Read from the search page Wisp opens (Pinterest, Huaban) or from the platform's public search API (ArtStation, sent without your cookies) | Returned to the desktop app so it can display and, if you choose, download the references. |
| For Huaban only: the thumbnail image bytes | Fetched by the extension from Huaban's image CDN (which only serves the image to a real logged-in browser, so the desktop app cannot fetch it directly) and inlined as base64 | Returned to the desktop app, which writes the thumbnail to its local reference cache. Never sent anywhere else. |

### 3. Reading your own creator stats (`creator.fetch_stats`)

When you ask the desktop app to refresh your dashboard, Wisp opens **your
own** creator-center page on a platform you are logged into (e.g. Bilibili,
Pixiv) and reads the analytics that page loads about your account.

| Data | Source | Where it goes |
|---|---|---|
| Your own public creator metrics (views, likes, followers, etc.) and your account ID on that platform | The JSON responses your creator-center page already requests, observed on the tab Wisp opens | Returned to the desktop app and stored locally on your machine. Never sent to a third party. |

### 4. Reading a page on your behalf (`browser.read_page` / `browser.capture`)

When you ask the desktop app to read or capture a page (for example, to
collect references or pull content from a site you are researching), Wisp
opens that URL in an **ephemeral background tab inside your own session** and
extracts a read-only snapshot, then closes the tab. `browser.capture` is
restricted to a fixed whitelist of read-only DevTools Protocol methods
(screenshot, PDF, DOM/HTML snapshot) — it cannot run code or modify the page.

| Data | Source | Where it goes |
|---|---|---|
| Readable text, links, image URLs, optional CSS-selected rows, page metadata, or a screenshot / PDF / DOM snapshot of the requested URL | The page Wisp opens in a background tab for this request | Returned to the desktop app on your machine. Never sent to a third party. Held only for the lifetime of the request, then the tab is closed. |

### 5. Saving what you point at — the clipper (`reference.clip`)

When you right-click and choose **"保存到 Nephele" / "Save to Nephele"**, or
press the clip shortcut (`Alt+Shift+S`), Wisp sends the desktop app a small
pointer to the thing you selected so the app can save it. The clipper is the
one case where Wisp acts on the **tab you are currently viewing** — but only
the metadata you explicitly pointed at, only on your click or keypress, and
the extension itself reads no page content beyond that pointer (the desktop
app decides what, if anything, to fetch).

| Data | Source | Where it goes |
|---|---|---|
| The image URL, link URL, selected text, page URL, and tab title of the item you clicked (whichever apply) | The browser's own context-menu / command event for your current tab | Sent once to the desktop app as a `reference.clip` event. Never sent to a third party. The extension does not store it. |

### Identifier stored across sessions

| Data | Source | Where it goes |
|---|---|---|
| A randomly-generated per-profile ID (`wp_<uuid>`) | Generated and stored in `chrome.storage.local` | Sent to the desktop app on handshake so it can recognize repeat connections from the same browser profile. Not linked to any platform account, real-world identity, or analytics system. |

## What the extension does NOT handle

- Your passwords, cookies, session tokens, or platform credentials — Wisp
  never reads or stores them.
- Tabs you opened yourself — Wisp's automation (form-fill, stats, page read)
  runs only in background tabs it opens for a request and never attaches to a
  tab you opened. The single exception is the clipper, which acts on your
  current tab — and only on the metadata you explicitly point at, only when
  you invoke it (see request type 5).
- Anything in the background — Wisp does nothing without a request you
  initiated from the desktop app or a clip you invoked yourself.
- Browsing history.

## Where data goes

- **All data flows are local.** Wisp returns everything to the Nephele
  Workshop desktop app on the same machine, over Native Messaging
  (restricted by the browser to a host you explicitly installed) and the
  local asset server on `127.0.0.1`.
- **No servers of our own, no analytics, no telemetry.** Wisp holds broad
  host access (`<all_urls>`) because the work you ask it to do — publish,
  read, collect references, clip — can target any site you use, and image
  bytes live on per-platform CDN domains that differ from the site itself. It
  contacts a site only (a) in your session, to carry out a request you just
  initiated, and (b) the local asset server on `127.0.0.1`. It never contacts
  a server of ours, because we do not run one for the extension. See
  `docs/PERMISSIONS.md` for the full `<all_urls>` justification.
- **The desktop app's own privacy** is governed by Nephele Workshop's
  privacy policy at <https://arisfusion.com/privacy>. Wisp is the bridge;
  anything that later leaves your machine does so through the desktop app,
  under that policy, not through the extension.

## debugger permission

Wisp uses Chrome's `debugger` API (`chrome.debugger`) to drive forms and
read pages in your session. Chrome shows a yellow "Nephele Wisp started
debugging this browser" notification bar on every tab Wisp attaches to —
the visible indicator that automation is happening. Wisp only attaches to
tabs it opened itself for a request; it never attaches to tabs you opened.

## Data retention

The only data Wisp retains across browser restarts is the per-profile ID (a
UUID in `chrome.storage.local`). Image bytes, captions, URLs, scraped
metadata, stats, and tab references are held only for the lifetime of the
single request that produced them and discarded on completion. Asset
transfer tokens expire 5 minutes after issue and are single-use.

## Children

Wisp is part of a paid creator tool intended for adult professional
artists. The extension itself does not collect age data.

## Contact

Source code is open at <https://github.com/CreatorAris/nephele-wisp>
(MIT). Security disclosures and questions: **arisyingying13@gmail.com**.

## Changes

Material changes to this policy are reflected in this document and in the
extension's release notes.
