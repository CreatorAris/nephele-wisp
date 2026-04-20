# Icons

Placeholder. Icons are not referenced from `manifest.json` yet —
Chrome will display the default puzzle-piece icon during unpacked
development, which is fine for the PoC phase.

Before Chrome Web Store submission (v0.4 beta), add:

- `icon-16.png` — 16x16 — toolbar icon
- `icon-32.png` — 32x32 — Windows taskbar
- `icon-48.png` — 48x48 — extension management page
- `icon-128.png` — 128x128 — Chrome Web Store listing

Source art should match Nephele Workshop's fairy/purple aesthetic
(the same art style used for the in-app Nephele character). Icons are
authored by the Nephele art pipeline, not AI-generated — see the
project-wide rule in `CLAUDE.md` of the main repo.

Once PNG files are added, update `manifest.json` with:

```json
"icons": {
  "16": "icons/icon-16.png",
  "32": "icons/icon-32.png",
  "48": "icons/icon-48.png",
  "128": "icons/icon-128.png"
},
"action": {
  "default_icon": {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png"
  },
  ...
}
```
