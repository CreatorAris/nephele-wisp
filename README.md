<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/CreatorAris/CreatorAris/dist/github-snake-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/CreatorAris/CreatorAris/dist/github-snake.svg" />
  <img alt="github contribution snake animation" src="https://raw.githubusercontent.com/CreatorAris/CreatorAris/dist/github-snake.svg" />
</picture>

# Nephele Wisp

Browser-side companion for [Nephele Workshop](https://nephele.arisfusion.com) — a Chrome / Edge extension and Native Messaging Host that lets Nephele act inside the user's real browser.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Manifest](https://img.shields.io/badge/MV3-supported-blue.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Status](https://img.shields.io/badge/status-pre--store-orange.svg)](docs/ROADMAP.md)
[![GitHub stars](https://img.shields.io/github/stars/CreatorAris/nephele-wisp.svg)](https://github.com/CreatorAris/nephele-wisp/stargazers)
[![GitHub last commit](https://img.shields.io/github/last-commit/CreatorAris/nephele-wisp.svg)](https://github.com/CreatorAris/nephele-wisp/commits)

[中文文档](README_ZH.md) · [Roadmap](docs/ROADMAP.md) · [Protocol](docs/PROTOCOL.md) · [Security](docs/SECURITY.md)

</div>

## What this is

Wisp runs inside the user's own Chrome / Edge, with the user's own cookies and browser fingerprint, and exposes a Native Messaging channel that the Nephele Workshop desktop app can drive. Use cases: cross-platform draft publishing, creator dashboard reads, comment aggregation, reply drafting.

## Status

Early development, pre-Web-Store. See [docs/ROADMAP.md](docs/ROADMAP.md).

## Architecture

```
Nephele Workshop (PySide6 desktop app)
    <-- stdio Native Messaging, length-prefixed JSON -->
NMH adapter (nephele.exe --nmh subcommand)
    <-- chrome.runtime.connectNative -->
Extension Service Worker (MV3)
    <-- chrome.debugger + CDP -->
Target page (bilibili.com, xiaohongshu.com, ...)
```

Wire protocol: [docs/PROTOCOL.md](docs/PROTOCOL.md).
Audit commitments: [docs/SECURITY.md](docs/SECURITY.md).

## Repository layout

| Path | Contents |
|:---|:---|
| `extension/` | MV3 extension source (published as "Nephele Wisp" on Chrome Web Store / Edge Add-ons) |
| `nmh/` | Native Messaging Host manifest templates and registration scripts. The actual NMH entry point is the `--nmh` subcommand of the Nephele Workshop binary. |
| `docs/` | Protocol, roadmap, security commitments |
| `scripts/` | Build, pack, release helpers |

## Versioning & release integrity

The commit SHA of each Web Store release is recorded in GitHub Releases. Any user can build from source and diff against the Store version. Protocol compatibility between Wisp and the desktop client is enforced via `protocol_version` in the handshake (see PROTOCOL.md).

## Reporting issues

Bugs in the extension or NMH layer — file an issue here. PRs welcome; this repo is the source of truth for the Web Store / Add-ons release.

Feature requests for the broader Nephele Workshop product (the desktop client itself) — the client tree is closed-source, so file them via the contact address on the [website](https://nephele.arisfusion.com), not here.

## License

MIT, see [LICENSE](LICENSE). Free to fork, audit, or repackage.

## Related repositories

- [nephele-core-audit](https://github.com/CreatorAris/nephele-core-audit) — auditable subset of the Nephele Workshop client (rights / packer / validator)
- [nephele-verify](https://github.com/CreatorAris/nephele-verify) — independent verification page for `.nep` evidence files
- [nephele-remote](https://github.com/CreatorAris/nephele-remote) — mobile companion (Expo / React Native app)
