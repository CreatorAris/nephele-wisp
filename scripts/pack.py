#!/usr/bin/env python3
"""Pack the Wisp extension into a store-ready zip.

Unlike a raw ``zip -r extension/``, this packager:

  1. Strips ``@wisp-dev-only:start .. @wisp-dev-only:end`` blocks from every
     ``.js`` file, so dev-only probes (``system.eval``) never reach the
     store artifact while staying fully functional in unpacked dev loads.
  2. Rewrites ``const BUILD_SHA = 'dev'`` to the build id (manifest version
     by default), so the handshake reports the real build AND the
     ``system.eval`` gate fails closed as defense in depth.
  3. Drops ``README.md`` files (repo docs, not runtime).
  4. FAILS the build if any dev-only marker or ``system.eval`` /
     ``handleSystemEval`` token survives into the packed JS.

The output zip is deterministic (sorted entries, fixed timestamps) so the
same commit always produces a byte-identical artifact — that is what makes
the "diff the Store zip against this commit" auditability promise real, and
it lets Chrome (manual upload) and Edge (CI) ship the exact same bytes.

Cross-platform, stdlib only.

Usage::

    python scripts/pack.py                 # -> wisp-<version>.zip at repo root
    python scripts/pack.py --out dist      # -> dist/wisp-<version>.zip
    python scripts/pack.py --build-id ab12  # override BUILD_SHA value
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

REPO_ROOT = Path(__file__).resolve().parent.parent
EXT_DIR = REPO_ROOT / "extension"

# A dev-only block is everything from a start marker to its next end marker,
# inclusive, plus the start line's indentation and the end line's newline.
DEV_BLOCK_RE = re.compile(
    r"[ \t]*//[ \t]*@wisp-dev-only:start.*?//[ \t]*@wisp-dev-only:end[ \t]*\n?",
    re.DOTALL,
)

# After stripping, none of these may appear in any packed .js — that catches
# an unbalanced marker, a typo'd marker, or the eval probe leaking through.
FORBIDDEN_TOKENS = ("@wisp-dev-only", "system.eval", "handleSystemEval")

# Excluded from the store artifact entirely.
EXCLUDE_NAMES = {"README.md", ".DS_Store"}
EXCLUDE_SUFFIXES = {".zip", ".swp"}


def _read_version() -> str:
    manifest = json.loads((EXT_DIR / "manifest.json").read_text("utf-8"))
    return str(manifest["version"])


def _transform_js(text: str, build_id: str) -> tuple[str, int]:
    """Strip dev-only blocks and inject BUILD_SHA. Returns (text, n_blocks)."""
    n_blocks = len(DEV_BLOCK_RE.findall(text))
    text = DEV_BLOCK_RE.sub("", text)
    text = text.replace(
        "const BUILD_SHA = 'dev';",
        f"const BUILD_SHA = '{build_id}';",
    )
    return text, n_blocks


def pack(out_dir: Path, build_id: str) -> Path:
    version = _read_version()
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"wisp-{version}.zip"

    files = sorted(
        p
        for p in EXT_DIR.rglob("*")
        if p.is_file() and p.name not in EXCLUDE_NAMES and p.suffix not in EXCLUDE_SUFFIXES and ".git" not in p.parts
    )

    # Pass 1: transform + validate everything in memory. Fail BEFORE
    # creating the zip so a guard trip never leaves a partial/locked file.
    entries: list[tuple[str, bytes]] = []
    stripped_total = 0
    for path in files:
        arcname = path.relative_to(EXT_DIR).as_posix()
        if path.suffix == ".js":
            text, n = _transform_js(path.read_text("utf-8"), build_id)
            stripped_total += n
            for token in FORBIDDEN_TOKENS:
                if token in text:
                    print(
                        f"::error::dev-only token {token!r} survived into "
                        f"{arcname} — check @wisp-dev-only marker balance",
                        file=sys.stderr,
                    )
                    sys.exit(1)
            data = text.encode("utf-8")
        else:
            data = path.read_bytes()
        entries.append((arcname, data))

    # Pass 2: write the deterministic zip (sorted, fixed timestamps).
    if out_path.exists():
        out_path.unlink()
    with ZipFile(out_path, "w", ZIP_DEFLATED) as zf:
        for arcname, data in entries:
            info = ZipInfo(arcname, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, data)

    print(
        f"packed {out_path.name}: {len(files)} files, {stripped_total} dev-only block(s) stripped, BUILD_SHA={build_id}"
    )
    print(str(out_path))
    return out_path


def main() -> None:
    ap = argparse.ArgumentParser(description="Pack the Wisp store artifact.")
    ap.add_argument(
        "--out",
        default=str(REPO_ROOT),
        help="output directory for the zip (default: repo root)",
    )
    ap.add_argument(
        "--build-id",
        default=None,
        help="value to inject for BUILD_SHA (default: manifest version)",
    )
    args = ap.parse_args()
    build_id = args.build_id or _read_version()
    if build_id == "dev":
        print("::error::refusing to pack with BUILD_SHA='dev'", file=sys.stderr)
        sys.exit(1)
    pack(Path(args.out), build_id)


if __name__ == "__main__":
    main()
