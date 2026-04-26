<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/CreatorAris/CreatorAris/dist/github-snake-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/CreatorAris/CreatorAris/dist/github-snake.svg" />
  <img alt="github contribution snake animation" src="https://raw.githubusercontent.com/CreatorAris/CreatorAris/dist/github-snake.svg" />
</picture>

# Nephele Wisp

[Nephele Workshop](https://nephele.arisfusion.com) 的浏览器侧伴侣 —— Chrome / Edge 扩展配套 Native Messaging Host，让 Nephele 在用户自己的真实浏览器里执行操作。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Manifest](https://img.shields.io/badge/MV3-supported-blue.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Status](https://img.shields.io/badge/status-pre--store-orange.svg)](docs/ROADMAP.md)
[![GitHub stars](https://img.shields.io/github/stars/CreatorAris/nephele-wisp.svg)](https://github.com/CreatorAris/nephele-wisp/stargazers)
[![GitHub last commit](https://img.shields.io/github/last-commit/CreatorAris/nephele-wisp.svg)](https://github.com/CreatorAris/nephele-wisp/commits)

[English](README.md) · [路线](docs/ROADMAP.md) · [协议](docs/PROTOCOL.md) · [安全承诺](docs/SECURITY.md)

</div>

## 这是什么

Wisp 跑在用户自己的 Chrome / Edge 里，用用户自己的 cookies 与浏览器指纹，并通过 Native Messaging 通道接受 Nephele Workshop 桌面端的指令。典型用途：跨平台草稿发布、创作者后台数据读取、评论聚合、回复草稿。

## 当前状态

早期开发，尚未上架 Chrome Web Store / Edge Add-ons。发布计划见 [docs/ROADMAP.md](docs/ROADMAP.md)。

## 架构

```
Nephele Workshop（PySide6 桌面应用）
    <-- 长度前缀 JSON over stdio (Native Messaging) -->
NMH 适配层（nephele.exe --nmh 子命令）
    <-- chrome.runtime.connectNative -->
扩展 Service Worker（MV3）
    <-- chrome.debugger + CDP -->
目标页面（bilibili.com、xiaohongshu.com、...）
```

协议细节：[docs/PROTOCOL.md](docs/PROTOCOL.md)。
安全承诺：[docs/SECURITY.md](docs/SECURITY.md)。

## 仓库结构

| 路径 | 内容 |
|:---|:---|
| `extension/` | MV3 扩展源码（上架 Chrome Web Store / Edge Add-ons 时命名为 "Nephele Wisp"） |
| `nmh/` | Native Messaging Host 清单模板与注册脚本。真正的 NMH 入口是 Nephele Workshop 主 exe 的 `--nmh` 子命令。 |
| `docs/` | 协议、路线、安全承诺 |
| `scripts/` | 构建、打包、发布辅助脚本 |

## 版本与发布完整性

每个 Web Store 发布版本对应的 commit SHA 都会记录在 GitHub Releases，任何用户都可以自行构建并与商店版本 diff 对比。Wisp 与桌面端的协议兼容性通过握手中的 `protocol_version` 维护，规则见 PROTOCOL.md。

## 反馈

扩展或 NMH 层的 bug —— 在本仓库提 issue。欢迎 PR：本仓库就是 Web Store / Add-ons 发布的代码源头，合并即上线。

Nephele Workshop 桌面端本身的功能需求 —— 桌面端代码是闭源的，请通过 [官网](https://nephele.arisfusion.com) 上的联系方式提交，不要发到本仓库。

## License

MIT，见 [LICENSE](LICENSE)。可自由 fork、审计、重新打包。

## 相关仓库

- [nephele-core-audit](https://github.com/CreatorAris/nephele-core-audit) —— Nephele Workshop 客户端的可审计代码子集（rights / packer / validator）
- [nephele-verify](https://github.com/CreatorAris/nephele-verify) —— `.nep` 存证文件的独立验证页
- [nephele-remote](https://github.com/CreatorAris/nephele-remote) —— 移动伴侣（Expo / React Native 应用）
