# Nephele Wisp — Store Listing Copy

Drafts for the Chrome Web Store and Edge Add-ons listings. Pick / edit
before submission. Avoid marketing fluff: reviewers and artists both prefer
plain factual copy.

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
> carries out the publishing-workflow requests the desktop app sends —
> filling upload forms (and stopping at "draft ready" for you to review and
> publish), reading your own creator stats, and gathering reference images
> — all in your own logged-in browser session, returning the results to the
> desktop app. The extension does nothing on its own.

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
2. **Bilibili draft filled**: 动态 with image + caption + topic chip,
   publish button visible (not clicked).
3. **Xiaohongshu draft filled**: 图文笔记 with title + image preview + caption.
4. **Reference search**: desktop app showing reference thumbnails Wisp
   gathered from a search.
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

## Host permission justification (for the listing form)

> Each domain has a handler that acts on it, in the user's logged-in
> session, only when the user initiates a matching request from the Nephele
> Workshop desktop app. Requests are of three kinds: filling an upload draft
> (publisher), reading the user's own creator stats (creator), and reference
> image search (reference).
>
> Shipped platforms: Bilibili, 小红书, 微博, 抖音, Pixiv, Twitter/X,
> ArtStation (upload + reference), Pinterest (reference), Huaban (reference).
> There are no declared hosts without a handler.
>
> 127.0.0.1 is for the local-only asset transfer server the desktop app
> exposes — required because Native Messaging caps individual host→extension
> messages at 1 MB and image bytes routinely exceed that.

See `docs/PERMISSIONS.md` for full per-permission justification.

## Distribution / pricing

Free. The extension itself does nothing without the (paid) Nephele Workshop
desktop app. Listing must NOT pretend the extension is a standalone product.

## Submission checklist

Before clicking submit:

- [x] Icons 16/32/48/128 in `extension/icons/` (final art).
- [x] Promo tile 440×280 (`extension/icons/promo_tile_440x280.png`).
- [ ] Privacy policy URL <https://nephele.arisfusion.com/wisp/privacy> is
      LIVE and renders the Wisp policy (not the landing page). Deploy the
      page from the website repo first, then verify the body.
- [ ] Permissions justification URL <https://nephele.arisfusion.com/wisp/permissions>
      is LIVE and renders the Wisp permissions doc.
- [ ] Screenshots produced (≥1 required; 5 recommended, 1280×800 PNG).
- [ ] `manifest.json` `version` confirmed for this update (currently 0.4.15)
      and a matching `v<version>` git tag pushed.
- [ ] Store artifact built with `python scripts/pack.py` (NOT a raw zip) so
      the dev-only `system.eval` probe is stripped; confirm the zip contains
      no `system.eval`.
- [ ] Chrome Web Store data-use form filled: declares Website content
      (reference search) and the user's own account data (creator stats),
      collected locally and not sold/transferred.
- [ ] Smoke test passes against a logged-in profile for the shipped
      publisher platforms.
- [ ] Nephele Workshop NMH register flow tested in a Nuitka build (not just
      dev `python main_qt.py`).
- [ ] Edge CI secrets present (`EDGE_PRODUCT_ID`, `EDGE_CLIENT_ID`,
      `EDGE_API_KEY`) if shipping via tag push, OR plan a manual upload.
