# Nephele Wisp · 微光

Browser-side companion for [Nephele Workshop](https://github.com/CreatorAris/nephele-workshop) —
a Chrome / Edge extension plus Native Messaging Host that lets Nephele
act inside the user's real browser.

> 画师工坊「Nephele Workshop」的浏览器侧伴侣。Chrome / Edge 扩展配套
> Native Messaging Host，让 Nephele 在你自己的浏览器里代你完成发布、
> 读取数据、整理评论——用真实的 cookies、真实的指纹、真实的身份，
> 不再和反爬系统永无止境地打架。

[中文](#中文) · [English](#english)

---

<a id="中文"></a>

## 中文

### 为什么要做

**Nephele Workshop** 是画师的桌面创作工具。其中几个最有价值的功能——
跨平台发布草稿、创作者数据看板、评论/私信聚合、回复草稿——都需要操作画师
在 B站 / 小红书 / 抖音 / 微博 / X 的已登录页面。

用 headless 自动化（Playwright）做这件事是一场永无止境的反爬战争：
平台每次更新检测都更严，猫鼠游戏没有尽头，单人团队根本维护不动。

**微光走的是另一条路**：扩展运行在**用户自己的 Chrome 里**，用
**用户自己的 cookies**，向目标站点呈现**用户自己的浏览器指纹**。
没有伪造的部分，就没有什么可被识破的。

### 当前状态

早期开发，尚未上架 Chrome Web Store / Edge Add-ons。发布计划见
[docs/ROADMAP.md](docs/ROADMAP.md)。

### 架构

```
Nephele Workshop (PySide6 桌面应用)
    <-- 长度前缀 JSON over stdio (Native Messaging) -->
NMH 适配层 (nephele.exe --nmh 子命令)
    <-- chrome.runtime.connectNative -->
扩展 Service Worker (MV3)
    <-- chrome.debugger + CDP -->
目标页面 (bilibili.com, xiaohongshu.com, ...)
```

协议细节见 [docs/PROTOCOL.md](docs/PROTOCOL.md)，可审计承诺见
[docs/SECURITY.md](docs/SECURITY.md)。

### 仓库结构

- `extension/` — MV3 扩展源码（上架 Chrome Web Store / Edge Add-ons
  时名为 "Nephele Wisp"）
- `nmh/` — Native Messaging Host 清单模板和注册脚本。真正的 NMH
  入口是 Nephele Workshop 主 exe 的 `--nmh` 子命令。
- `docs/` — 协议、路线、安全承诺
- `scripts/` — 构建、打包、发布辅助脚本

### 与 Nephele Workshop 的关系

微光仓库从主仓库中拆出，原因：

1. 扩展可以 MIT 完全开源，而 Nephele Workshop 本体保持闭源商业化
2. 安全研究者和用户可以直接审计跑在浏览器里的代码，不用翻无关代码库
3. Web Store 的审核节奏（每个功能独立审核）与 Nephele 主版本发布
   节奏解耦

协议兼容性通过握手中的 `protocol_version` 维护，具体规则见 PROTOCOL.md。

### License

MIT，见 [LICENSE](LICENSE)。

扩展明确采用 MIT 开源，让用户能审计跑在自己浏览器里的代码。每个
Web Store 发布版本对应的 commit SHA 会记录在 GitHub Release，任何
用户都可以自行构建并与商店版本 diff 对比。

---

<a id="english"></a>

## English

### Why this exists

**Nephele Workshop** is a desktop app for digital artists. Several of
its high-value features — cross-platform draft publishing, creator
dashboard analytics, comment aggregation, reply drafting — require
touching logged-in pages on 哔哩哔哩 (Bilibili) / 小红书 (Xiaohongshu)
/ 抖音 (Douyin) / 微博 (Weibo) / X (Twitter).

Doing this with headless browser automation (Playwright) is a
perpetual arms race against anti-bot systems: detection tightens every
release, the cat-and-mouse never ends, and a single-person team cannot
sustain it.

**Wisp takes a different route**: the extension runs **inside the
user's own Chrome**, uses the **user's own cookies**, and presents
**the user's own browser fingerprint** to target sites. There is
nothing inauthentic to detect.

### Status

Early development, pre-Web-Store. See [docs/ROADMAP.md](docs/ROADMAP.md)
for the shipping plan.

### Architecture

```
Nephele Workshop (PySide6 desktop app)
    <-- stdio Native Messaging, JSON length-prefixed -->
NMH adapter (nephele.exe --nmh subcommand)
    <-- chrome.runtime.connectNative -->
Extension Service Worker (MV3)
    <-- chrome.debugger + CDP -->
Target page (bilibili.com, xiaohongshu.com, ...)
```

See [docs/PROTOCOL.md](docs/PROTOCOL.md) for the wire protocol and
[docs/SECURITY.md](docs/SECURITY.md) for audit commitments.

### Repository layout

- `extension/` — MV3 extension source (published as "Nephele Wisp" on
  Chrome Web Store and Edge Add-ons)
- `nmh/` — Native Messaging Host manifest templates and registration
  scripts. The actual NMH entry point is a `--nmh` subcommand of the
  main Nephele Workshop binary.
- `docs/` — Protocol, roadmap, security commitments
- `scripts/` — Build, pack, release helpers

### Relationship to the Nephele Workshop repo

Wisp is deliberately split out so that:

1. The extension can be MIT-licensed and fully open while Nephele
   Workshop itself remains closed-source.
2. Security researchers can audit the exact code running in their
   browser without cloning an unrelated codebase.
3. Web Store release cadence (per-feature reviews) is decoupled from
   Nephele Workshop's monolithic release cycle.

Protocol compatibility is maintained by matching `protocol_version` in
the handshake. See PROTOCOL.md for the compatibility rules.

### License

MIT. See [LICENSE](LICENSE).

The extension is MIT-licensed explicitly so that users can audit
exactly what runs inside their browser. Commit SHAs of each Web Store
release are documented in GitHub Releases, so any user can build from
source and diff against the Store version.
