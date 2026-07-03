# Nephele Wisp — Edge Add-ons Submission Sheet (v0.5.0)

Paste-ready field answers for the Microsoft Partner Center → Edge Add-ons
dashboard. This update adds the "Save to Nephele" clipper + general page
read/capture and broadens host access to `<all_urls>`.

Source of truth for the longer copy: `docs/STORE_LISTING.md`,
`docs/PERMISSIONS.md`, `docs/PRIVACY.md`. Keep this sheet in sync with them.

---

## 1. Package

- Upload: **`wisp-0.5.0.zip`** (repo root, built by `python scripts/pack.py`).
- Deterministic build — byte-identical from the published commit on `main`.
  Contains no `system.eval` / arbitrary-eval route (dev probe stripped at pack
  time).
- Version: **0.5.0** (must match the `manifest.json` version and the `0.5.0`
  git tag).

## 2. Availability

- Visibility: **Public**.
- Markets: **All markets**.
- Pricing: **Free**.

## 3. Properties

- Category: **Productivity**.
- This update changes permissions (adds `contextMenus`; host access widened to
  `<all_urls>`) and adds features (clipper, page read/capture) — expect review
  to re-check permissions. Justifications are in §6.

## 4. Store listing (English)

**Display name**

```
Nephele Wisp
```

**Short description / summary**

```
Browser-side companion for Nephele Workshop — runs its publish, stats,
reference, and clip tasks in your own logged-in browser session.
```

**Description** (paste the "Detailed description → English" block from
`docs/STORE_LISTING.md`). Key points: it is the browser half of the Nephele
Workshop desktop app; runs in your real session; fills upload drafts and stops
at "draft ready"; reads your own creator stats; reads pages; gathers/clips
references; never clicks final publish; sends nothing to any server of ours;
requires the desktop app; MIT open source.

> Do NOT inline a list of ≥5 platform brand names in the description (spam
> classifier). Brand names live in screenshots / README / host scope only.

**Search terms** (max ~7)

```
nephele, artist tools, creator workflow, publishing helper, reference clipper,
web clipper, native messaging
```

**Screenshots** — ≥1 required, 1280×800 PNG. Recommended set in
`docs/STORE_LISTING.md` (hero, draft filled, reference search, **clipper**,
yellow debugger bar). You produce these from real runs (no AI assets).

**Store logo** — 300×300 PNG. Source: `store/icon.png` (resize if needed).

**Promotional tile** (optional) — `extension/icons/promo_tile_440x280.png`;
larger marquee/poster art in `store/`.

## 5. Privacy

**Privacy policy URL**

```
https://nephele.arisfusion.com/wisp/privacy
```

> MUST be live and render the **0.5.0** Wisp policy (clipper + `<all_urls>`),
> not the website landing page. Update + deploy the website page first, then
> verify the body renders before submitting.

**Does this extension collect or transmit user data?** → **No.**

> Wisp reads pages only on the user's behalf and returns the result to the
> Nephele Workshop desktop app on the same machine over Native Messaging
> (on-device IPC) and a loopback (`127.0.0.1`) asset channel. Nothing is
> transmitted off-device or to the developer; there is no server, no
> analytics, no telemetry. Under the store's "collect" definition (transmit
> off-device / to the developer), nothing is collected.

## 6. Permissions justifications

Per-permission one-liners (full text in `docs/PERMISSIONS.md`):

| Permission | Justification |
|---|---|
| nativeMessaging | Talks to the Nephele Workshop desktop app via its Native Messaging Host `com.arisfusion.nephele_wisp`; this is the only host it connects to. |
| storage | Persists a single random per-profile ID (`wp_<uuid>`) for the desktop↔extension handshake. No user content. |
| debugger | Drives forms / reads pages via the DevTools Protocol on tabs the extension opens itself; browser shows its persistent "debugging this browser" banner. No remote code; the dev-only eval probe is stripped from the store build. |
| tabs | Opens, finds, and closes the background automation tab for a request. |
| alarms | 30-second keepalive so the MV3 service worker doesn't suspend and drop the Native Messaging connection. |
| contextMenus | Adds the "Save to Nephele" right-click item for the clipper. |
| scripting | On a user-invoked image clip from a supported feed page, runs one self-contained read-only function in that tab to read the clipped item's post link + timestamp (provenance). One shot per clip, writes nothing, fails open to a plain clip. |

**Host permissions — `<all_urls>`**

```
Wisp acts in the user's own logged-in session to publish, read pages, collect
references, and clip images on whatever site the user is working with — an
inherently all-sites job. Reference-image bytes also live on per-platform CDN
domains (i.pximg.net, i.pinimg.com, pbs.twimg.com, ...) distinct from each
site's own domain, so an enumerated allow-list would silently fail on the next
site or CDN. Broad scope is bounded by verifiable behaviour, not the host
list: no background or scheduled activity (every action is one the user just
initiated, or a clip they invoked); the chrome.debugger banner makes
automation visible and the extension attaches only to tabs it opened; it never
clicks the final publish/send button; and all data returns only to the local
Nephele Workshop process — no server of ours, no telemetry. 127.0.0.1 (covered
by <all_urls>) is the local-only asset transfer server, needed because Native
Messaging caps host->extension messages at 1 MB and image bytes exceed that.
```

## 7. Notes for certification (reviewer notes — paste verbatim)

Edge's "Notes for certification" field caps at 2,000 characters. The block
below is 1,718 chars. (Optional: add a "Test account: ..." line in the
remaining headroom if you give the reviewer a logged-in account.)

```
Nephele Wisp is the browser-side half of the Nephele Workshop desktop app (a paid tool for digital artists). It does nothing on its own: every action is triggered by the desktop app over a local Native Messaging connection, or by the user's own right-click / Alt+Shift+S clip. With no desktop app installed it connects to no native host and stays idle (the popup shows "disconnected") — so installing only the extension will correctly show no automation.

Verifying it:
- Open source (MIT): https://github.com/CreatorAris/nephele-wisp. The submitted .zip is byte-deterministic from the published commit on main (built by scripts/pack.py — sorted entries, fixed timestamps), so it diffs directly against the source.
- Full functionality needs the desktop app + a logged-in account; we can provide a test build on request: arisyingying13@gmail.com.

Why <all_urls> + debugger: Wisp acts in the user's own session on whatever site they publish to, research, or clip from; reference-image bytes live on CDN domains distinct from each site, so an enumerated host list would silently fail. Scope is bounded by behaviour: no background or scheduled activity; chrome.debugger shows its persistent "started debugging this browser" banner; the debugger attaches ONLY to tabs Wisp opened itself, never your own tabs (the clipper uses no debugger).

No remote code / eval: a dev-only system.eval probe is wrapped in @wisp-dev-only markers and stripped by scripts/pack.py, which FAILS the build if it survives — grep the package for "system.eval" to confirm none is present.

No data leaves the device: results return only to the local desktop app over Native Messaging and a 127.0.0.1 loopback. No server of ours, no analytics, no telemetry.
```

## 8. Publish path

- **(A) CI via tag** — `git tag 0.5.0 && git push origin 0.5.0` triggers
  `.github/workflows/release-edge.yml`. Requires repo secrets
  `EDGE_PRODUCT_ID` / `EDGE_CLIENT_ID` / `EDGE_API_KEY` (values in MS Partner
  Center; last checked these were empty — set them or use path B).
- **(B) Manual** — upload `wisp-0.5.0.zip` in Partner Center, fill the fields
  above, submit for certification.

Either way: **push the local commits to `origin/main`** so the public source
matches the submitted artifact.
