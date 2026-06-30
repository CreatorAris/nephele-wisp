# Nephele Wisp — Store Listing Copy

Listing copy for the Edge Add-ons submission (v0.5.0). Also valid for the
Chrome Web Store if/when that channel is onboarded. Pick / edit before
submission. Avoid marketing fluff: reviewers and artists both prefer plain
factual copy.

> **This update (v0.5.0)** adds a "Save to Nephele" clipper (context menu +
> `Alt+Shift+S`) and general page read/capture, and broadens host access to
> `<all_urls>`. The permission and privacy copy below reflects that — keep it
> in sync with `docs/PERMISSIONS.md` and `docs/PRIVACY.md`.

---

## Short title

**Nephele Wisp**

(no tagline; tagline goes in summary)

## Summary (132 characters max — Chrome Web Store)

> Browser-side companion for Nephele Workshop — runs its publish, stats,
> and reference tasks in your own logged-in browser session.

(~127 chars)

## Single-purpose description

> Wisp is the browser-side half of the Nephele Workshop desktop app. It
> carries out the requests the desktop app sends — filling upload forms (and
> stopping at "draft ready" for you to review and publish), reading your own
> creator stats, reading pages, and gathering or clipping reference images —
> all in your own logged-in browser session, returning the results to the
> desktop app. The extension does nothing on its own; every action originates
> from the desktop app or a clip you explicitly invoked.

## Detailed description

### English

**Wisp is the browser-side half of Nephele Workshop**, a desktop tool for
digital artists who manage their own publishing across multiple platforms.

Instead of headless automation that ages out the moment a platform updates
its anti-bot stack, Wisp runs as an extension in your real browser. The
desktop app sends a request over a local-only Native Messaging connection
and Wisp carries it out in your existing login session:

- **Fill an upload draft** (image, title, caption, topic). **Wisp always
  stops at "draft ready" — you review the result in the browser and click
  publish yourself.**
- **Read your own creator stats** from your creator-center dashboard and
  hand them back to the desktop app.
- **Gather reference images** from a search you ran in the desktop app.
- **Read a page** you asked the desktop app to read, in a background tab in
  your session, and return a read-only snapshot.
- **Save to Nephele**: right-click an image, link, selection, or page — or
  press Alt+Shift+S — and Wisp hands the desktop app a pointer to what you
  picked so it can save it. The clipper only acts when you invoke it.

Everything Wisp reads or fills is for a request you just initiated, in your
session, and the result goes only to the Nephele Workshop app on your own
machine — never to a server of ours. The supported platform list is visible
in the screenshots and in the manifest's host permissions, and grows with
each release.

> Note: do NOT enumerate platform brand names in the Chrome Web Store
> description. The "Yellow Argon" spam classifier flags any inline list of
> ≥5 brand names as keyword stuffing. Brand names live in screenshots /
> README / host_permissions only.

**What Wisp will never do:**

- Click the final publish / send button (you do that).
- Auto-like, auto-follow, auto-comment, captcha-bypass, multi-account.
- Send any of your data to any server other than the local Nephele Workshop
  process on your machine.
- Read pages in the background or on a schedule — every action is a request
  you initiated.

**Requires Nephele Workshop desktop application** to be installed. Without
the desktop app, the extension has no work to do — every request originates
from the user-facing desktop UI.

Open source (MIT) at <https://github.com/CreatorAris/nephele-wisp>. Privacy
policy: <https://nephele.arisfusion.com/wisp/privacy>. Permissions
justification: <https://nephele.arisfusion.com/wisp/permissions>.

### 中文

**Wisp 是 Nephele Workshop（画师工具）的浏览器侧伴侣**。桌面端通过本机连接发来
请求，Wisp 在你浏览器里已登录的会话中代为执行，然后把结果交回桌面端：

- **填写发布草稿**（图片、标题、文案、话题）——**永远停在"草稿已填好"，由你在
  浏览器里检查后手动点发布**。
- **读取你自己的创作者数据**（来自你自己的创作者中心）。
- **收集参考图**（来自你在桌面端发起的搜索）。

Wisp 读取或填写的一切都对应你刚发起的某个请求，在你的会话中进行，结果只回传到
你本机的 Nephele Workshop，不发送到我们的任何服务器。

不再用 Playwright 那种 headless 反爬军备竞赛——Wisp 在你真实浏览器里运行，平台
看到的是你本人。

**Wisp 永不做的事**：自动点发布按钮、自动点赞 / 关注 / 评论、绕过验证码、多账号
操作；不在后台或定时读取页面；不向除本机 Nephele Workshop 进程之外的任何服务器
发送数据。

**需要先装 Nephele Workshop 桌面端**——没有桌面端，扩展没有工作触发源。

源码 MIT 开源：<https://github.com/CreatorAris/nephele-wisp>。

---

## Categories

- Primary: **Productivity**
- Secondary: **Workflow & Planning** (Chrome) / **Productivity tools** (Edge)

## Language

- Primary: English
- Also available: Chinese (Simplified)

(both `en_US` and `zh_CN` strings are not yet localized in `_locales/`; ship
English-only first, add zh_CN in a follow-up.)

## Screenshots

Recommended: 5 screenshots, 1280×800 PNG. (You produce these from real
runs — at least one is required by both stores to publish.)

Suggested set:

1. **Hero shot**: Nephele Workshop UI with Wisp connection indicator on,
   side-by-side with a platform tab Wisp is filling.
2. **Draft filled**: a compose form (e.g. 动态 / 图文笔记) with image + caption
   + topic chip, publish button visible (not clicked).
3. **Reference search**: desktop app showing reference thumbnails Wisp
   gathered from a search.
4. **Save to Nephele (clipper)**: the right-click "保存到 Nephele" menu item
   on an image, and/or the saved reference appearing in the desktop app.
5. **The yellow debugger bar** annotated: the visible signal that automation
   is active.

Promo tile: 440×280 PNG — `extension/icons/promo_tile_440x280.png` exists.

## Permissions explanation (one-line each, for the listing form)

| Permission | One-liner for the listing form |
|---|---|
| nativeMessaging | Required to talk to the Nephele Workshop desktop app via Chrome's Native Messaging Host. |
| storage | Stores a randomly-generated per-profile ID (UUID) used in the desktop ↔ extension handshake. |
| debugger | Drives forms and reads pages via Chrome DevTools Protocol on tabs the extension opens itself; Chrome shows a persistent yellow notification bar while attached. |
| tabs | Opens the automation tab, finds it for a request, and closes it on cleanup. |
| alarms | A 30-second keepalive heartbeat that stops the MV3 service worker from suspending and dropping the Native Messaging connection. |
| contextMenus | Adds the "Save to Nephele" right-click item so you can clip an image, link, selection, or page to the desktop app. |

## Host permission justification (`<all_urls>`, for the listing form)

> Wisp requests broad host access because its job — acting in the user's own
> logged-in session to publish, read pages, collect references, and clip
> images on whatever site the user is working with — is inherently all-sites.
> A user researches and clips from anywhere on the web, and reference-image
> *bytes* live on per-platform CDN domains (i.pximg.net, i.pinimg.com,
> pbs.twimg.com, …) that differ from each site's own domain, so an enumerated
> allow-list would silently fail on the next site or CDN.
>
> Broad scope is bounded by hard, repository-verifiable behaviour, not by the
> host list: no background or scheduled activity (every action is one the user
> just initiated, or a clip they invoked); the `chrome.debugger` yellow bar
> makes automation visible and Wisp attaches only to tabs it opened; it never
> clicks the final publish/send button; and all data returns only to the local
> Nephele Workshop process on the same machine — no server of ours, no
> telemetry. 127.0.0.1 (covered by `<all_urls>`) is the local-only asset
> transfer server, needed because Native Messaging caps host→extension
> messages at 1 MB and image bytes exceed that.

See `docs/PERMISSIONS.md` for the full per-permission justification.

## Distribution / pricing

Free. The extension itself does nothing without the (paid) Nephele Workshop
desktop app. Listing must NOT pretend the extension is a standalone product.

## Submission checklist (Edge Add-ons, v0.5.0)

Target this round: **Edge Add-ons update only** (already onboarded; reuses the
existing extension ID). Chrome Web Store is not onboarded and is out of scope
for this update.

Done:

- [x] Icons 16/32/48/128 in `extension/icons/` (final art).
- [x] Promo tile 440×280 (`extension/icons/promo_tile_440x280.png`).
- [x] `manifest.json` `version` = **0.5.0**.
- [x] `system.eval` dev probe is `@wisp-dev-only`-marked and stripped by
      `scripts/pack.py` (the pack FAILS if `system.eval` / `handleSystemEval`
      survives), so the store artifact has no arbitrary-eval route.
- [x] PRIVACY.md / PERMISSIONS.md / STORE_LISTING.md updated for the clipper,
      page read/capture, `contextMenus`, and `<all_urls>`.

Before clicking submit:

- [ ] Store artifact built with `python scripts/pack.py` → `wisp-0.5.0.zip`
      (NOT a raw zip). Deterministic; confirm it contains no `system.eval`.
- [ ] Privacy policy URL <https://nephele.arisfusion.com/wisp/privacy> is LIVE
      and renders the **0.5.0** Wisp policy (clipper + `<all_urls>`), not the
      landing page. Update + deploy the website page first, then verify body.
- [ ] Permissions justification URL <https://nephele.arisfusion.com/wisp/permissions>
      is LIVE and renders the **0.5.0** permissions doc.
- [ ] Screenshots produced (≥1 required; 5 recommended, 1280×800 PNG) —
      include a clipper shot. (You produce these from real runs; no AI assets.)
- [ ] Data-use form: declares **NO data collection**. Wisp only reads pages on
      your behalf and hands the result to the local desktop app over Native
      Messaging (on-device IPC) — nothing is transmitted off-device or to us,
      so under the store's "collect" definition (transmit off-device / to the
      developer) nothing is collected. Privacy policy clarifies local-only.
- [ ] `<all_urls>` justification pasted into the listing (see section above).
- [ ] Smoke test passes against a logged-in profile for the shipped
      publisher platforms + a clipper invocation.
- [ ] Nephele Workshop NMH register flow tested in a Nuitka build (not just
      dev `python main_qt.py`).
- [ ] Publish path chosen: (A) Edge CI via `git tag 0.5.0 && git push origin
      0.5.0` — requires `EDGE_PRODUCT_ID` / `EDGE_CLIENT_ID` / `EDGE_API_KEY`
      secrets (last checked empty; values in MS Partner Center); OR
      (B) manual upload of `wisp-0.5.0.zip` to Edge Partner Center.
- [ ] Push the 14 local commits to `origin/main` so the public source matches
      the submitted artifact (auditability promise).
