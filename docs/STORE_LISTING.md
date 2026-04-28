# Nephele Wisp — Store Listing Copy

Drafts for the Chrome Web Store and Edge Add-ons listings. Pick / edit
before submission. Avoid marketing fluff: reviewers and artists
both prefer plain factual copy.

---

## Short title

**Nephele Wisp**

(no tagline; tagline goes in summary)

## Summary (132 characters max — Chrome Web Store)

> Browser-side companion for Nephele Workshop. Fills upload forms on
> sites you're already logged into, then stops for review.

(125 chars)

## Single-purpose description

> Wisp lets the Nephele Workshop desktop application populate upload
> forms in your browser — using your own logged-in session — and then
> hand the filled draft back to you for review and publish.

## Detailed description

### English

**Wisp is the browser-side half of Nephele Workshop**, a desktop tool
for digital artists who manage their own publishing across multiple
platforms.

Instead of headless automation that ages out the moment a platform
updates its anti-bot stack, Wisp runs as an extension in your real
browser. The desktop app sends the post (image, title, caption,
topic) over a local-only Native Messaging connection; Wisp fills the
platform's upload form using your existing login session. **Wisp
always stops at "draft ready" — you review the result in the browser
and click publish yourself.**

**Supported platforms (image post draft):**

- Bilibili (动态)
- Xiaohongshu (小红书图文笔记)
- Weibo (微博图片微博)
- Douyin (抖音图文)
- Pixiv (illust)
- Twitter / X (tweet)
- ArtStation (artwork)

**What Wisp will never do:**

- Click the final publish / send button (you do that).
- Auto-like, auto-follow, auto-comment, captcha-bypass, multi-account.
- Send any of your data to any server other than the local Nephele
  Workshop process on your machine.
- Run in the background without a request you initiated.

**Requires Nephele Workshop desktop application** to be installed.
Without the desktop app, the extension has no work to do — every
request originates from the user-facing desktop UI.

Open source (MIT) at <https://github.com/CreatorAris/nephele-wisp>.
Privacy policy: see `docs/PRIVACY.md`. Permissions justification:
see `docs/PERMISSIONS.md`.

### 中文

**Wisp 是 Nephele Workshop（画师工具）的浏览器侧伴侣**，让桌面端把要发的内容
（图片、标题、文案、话题）填到你浏览器里已登录的发布表单里，**永远停在
"草稿已填好"，由你在浏览器里检查后手动点发布**。

不再用 Playwright 那种 headless 反爬军备竞赛——Wisp 在你真实浏览器里运行，
平台看到的是你本人。

**支持平台（图片草稿）**：B 站动态 / 小红书图文笔记 / 微博 / 抖音图文 /
Pixiv / Twitter（X）/ ArtStation。

**Wisp 永不做的事**：自动点发布按钮、自动点赞 / 关注 / 评论、绕过验证码、
多账号操作；不向除本机 Nephele Workshop 进程之外的任何服务器发送数据。

**需要先装 Nephele Workshop 桌面端**——没有桌面端，扩展没有工作触发源。

源码 MIT 开源：<https://github.com/CreatorAris/nephele-wisp>。

---

## Categories

- Primary: **Productivity**
- Secondary: **Workflow & Planning** (Chrome) / **Productivity tools**
  (Edge)

## Language

- Primary: English
- Also available: Chinese (Simplified)

(both `en_US` and `zh_CN` strings are not yet localized in
`_locales/`; ship English-only first, add zh_CN in a follow-up.)

## Screenshots

Recommended: 5 screenshots, 1280×800 PNG.

Suggested set (you produce these from real upload smoke runs):

1. **Hero shot**: Nephele Workshop UI with Wisp connection indicator
   on, side-by-side with a platform tab Wisp is filling.
2. **Bilibili draft filled**: t.bilibili.com 动态 with image + caption
   + topic chip, publish button visible (not clicked).
3. **Xiaohongshu draft filled**: creator.xiaohongshu.com 图文笔记 with
   title + image preview + caption.
4. **Twitter compose filled**: x.com compose modal with caption + image
   preview, "Post" button visible.
5. **The yellow debugger bar** annotated: this is what users see while
   Wisp is working — it's the visible signal that automation is
   active.

Promo tile: 440×280 PNG. Suggested: Wisp logo on Nephele's signature
purple gradient background; text "Nephele Wisp · Browser companion".

## Permissions explanation (one-line each, for the listing form)

| Permission | One-liner for the listing form |
|---|---|
| nativeMessaging | Required to talk to the Nephele Workshop desktop app via Chrome's Native Messaging Host. |
| storage | Stores a randomly-generated per-profile ID (UUID) used in the desktop ↔ extension handshake. |
| debugger | Drives upload forms via Chrome DevTools Protocol on tabs the extension opens itself; Chrome displays a persistent yellow notification bar while attached. |
| tabs | Used to open the automation tab and close it on cleanup. |
| scripting | Required for `Page.addScriptToEvaluateOnNewDocument` patches needed before navigating to certain platforms. |

## Host permission justification (for the listing form)

> Each domain corresponds to one platform-specific handler. The
> extension only navigates to these domains when the user has just
> initiated an upload request from the Nephele Workshop desktop app.
> 127.0.0.1 is for the local-only asset transfer server the desktop
> app exposes — required because Native Messaging caps individual
> messages at 1 MB and image bytes routinely exceed that.

See `docs/PERMISSIONS.md` for full per-permission justification.

## Distribution / pricing

Free. The extension itself does nothing without the (paid) Nephele
Workshop desktop app. Listing must NOT pretend the extension is a
standalone product.

## Submission checklist

Before clicking submit:

- [ ] Icons 16/32/48/128 in `extension/icons/` (final art, not the
      placeholder copy of the desktop avatar)
- [x] Privacy policy URL: <https://nephele.arisfusion.com/wisp/privacy>
      (deployed via CF Pages)
- [x] Permissions justification URL: <https://nephele.arisfusion.com/wisp/permissions>
- [ ] Screenshots produced (5 PNG, 1280×800)
- [ ] Promo tile produced (1 PNG, 440×280)
- [ ] manifest.json `version` bumped if shipping update
- [ ] Smoke test passes against logged-in profile for all 7 platforms
      (`scripts/wisp_smoke_all.py --platforms bili,xhs,weibo,douyin,
      pixiv,twitter,artstation`)
- [ ] Nephele Workshop NMH register flow tested in a Nuitka build (not
      just dev `python main_qt.py`)
- [ ] Source-code zip excludes `node_modules`, `__pycache__`, dev
      profiles
