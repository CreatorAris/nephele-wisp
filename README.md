# Nephele Wisp

Browser-side companion for [Nephele Workshop](https://github.com/CreatorAris/nephele-workshop).
A Chrome / Edge extension plus Native Messaging Host that lets Nephele
act inside the user's real browser — real cookies, real fingerprint,
real identity — without anti-automation adversarial games.

## Why this exists

Nephele Workshop is a desktop app for digital artists. Several of its
high-value features (cross-platform draft publishing, creator dashboard
analytics, comment aggregation, reply drafting) require touching
logged-in pages on B站 / 小红书 / 抖音 / 微博 / X. Doing this with
headless automation (Playwright) is a perpetual arms race against
anti-bot systems — detection tightens every release, the cat-and-mouse
never ends, and a single-person team cannot sustain it.

Wisp takes a different route: the extension runs **inside the user's
own Chrome**, uses the **user's own cookies**, and presents **the user's
own browser fingerprint** to target sites. There is nothing to detect
because there is nothing inauthentic to detect.

## Status

Early development, pre-Web-Store. See [docs/ROADMAP.md](docs/ROADMAP.md)
for the shipping plan.

## Architecture

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

## Repository layout

- `extension/` — MV3 extension source (published as "Nephele Wisp" on
  Chrome Web Store and Edge Add-ons)
- `nmh/` — Native Messaging Host manifest templates and registration
  scripts. The Python NMH itself lives in the Nephele Workshop repo as
  a subcommand of the main binary.
- `docs/` — Protocol, roadmap, security commitments
- `scripts/` — Build, pack, release helpers

## Relationship to the Nephele Workshop repo

Wisp is deliberately split out so that:

1. The extension can be MIT-licensed and fully open while Nephele
   Workshop itself remains closed-source.
2. Security researchers can audit the exact code running in their
   browser without cloning an unrelated codebase.
3. Web Store release cadence (per-feature reviews) is decoupled from
   Nephele Workshop's monolithic release cycle.

Protocol compatibility is maintained by matching `protocol_version` in
the handshake. See PROTOCOL.md for the compatibility rules.

## License

MIT. See [LICENSE](LICENSE).

The extension is MIT-licensed explicitly so that users can audit
exactly what runs inside their browser. Commit SHAs of each Web Store
release are documented in GitHub Releases, so any user can build from
source and diff against the Store version.
