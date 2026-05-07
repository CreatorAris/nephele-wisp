"""
Render store/*.html into pixel-exact PNGs via Playwright.

Why Playwright (and not Edge headless CLI):
  Edge's --window-size on Windows ignores --force-device-scale-factor
  and renders at the system DPR; on a 175% display it leaks white
  margins because the canvas physical size and the requested viewport
  don't match. Playwright lets us pin viewport (CSS px) and DPR
  independently — page.screenshot() then returns the exact pixels.

Uses the ci_env Python (the one E:\\Motion already exercises with
Playwright + Chromium 1208) so we don't have to install anything new.

Usage (run with ci_env, NOT system Python):
    & "C:\\actions-runner\\ci_env\\Scripts\\python.exe" `
        store\\render_poster.py                 # both default targets
    & ... store\\render_poster.py poster
    & ... store\\render_poster.py poster marquee
"""
from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

TARGETS = {
    "poster":  {"html": "poster.html",  "png": "poster.png",  "width": 1280, "height": 800},
    "marquee": {"html": "marquee.html", "png": "marquee.png", "width": 1400, "height": 560},
}

STORE_DIR = Path(__file__).resolve().parent


def render(target_name: str) -> Path:
    spec = TARGETS[target_name]
    html_path = STORE_DIR / spec["html"]
    out_path = STORE_DIR / spec["png"]
    if not html_path.is_file():
        raise SystemExit(f"missing HTML: {html_path}")

    w, h = spec["width"], spec["height"]
    print(f"[{target_name}] {html_path.as_uri()}")
    print(f"  viewport {w}x{h}")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        # device_scale_factor=1 — render at exact CSS px regardless of host DPR.
        # full_page=False means screenshot uses the viewport size, not the
        # rendered document height; combined with html/body locked to the
        # tile dimensions in CSS, the PNG comes out pixel-exact.
        page = browser.new_page(
            viewport={"width": w, "height": h},
            device_scale_factor=1,
        )
        page.goto(html_path.as_uri(), wait_until="networkidle")
        # Web fonts and any deferred layout settle within ~1s of networkidle;
        # explicit wait makes corner-pixel sanity check deterministic.
        page.wait_for_timeout(1000)
        page.screenshot(path=str(out_path), omit_background=False)
        browser.close()

    # Sanity: the four corners must be on the gradient backdrop, not the
    # white "viewport didn't fill" canary that the old Edge-CLI path left.
    from PIL import Image
    img = Image.open(out_path).convert("RGB")
    px = img.size
    corners = {
        "TL": img.getpixel((0, 0)),
        "TR": img.getpixel((px[0] - 1, 0)),
        "BL": img.getpixel((0, px[1] - 1)),
        "BR": img.getpixel((px[0] - 1, px[1] - 1)),
    }
    pure_white = [k for k, c in corners.items() if c == (255, 255, 255)]
    size_kb = out_path.stat().st_size / 1024
    print(f"  -> {out_path}  {px[0]}x{px[1]}  ({size_kb:.1f} KB)")
    print(f"  corners: {corners}")
    if pure_white:
        print(f"  WARN: corners {pure_white} are pure white — layout did not fill the viewport")
    return out_path


def main() -> int:
    targets = sys.argv[1:] or list(TARGETS)
    unknown = [t for t in targets if t not in TARGETS]
    if unknown:
        raise SystemExit(f"unknown target(s): {unknown}. choices: {sorted(TARGETS)}")
    for t in targets:
        render(t)
    return 0


if __name__ == "__main__":
    sys.exit(main())
