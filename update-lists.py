#!/usr/bin/env python3
"""Writes the file lists the app reads: images/backgrounds.json and fonts/fonts.json.

Run it after adding, renaming or removing a file in ./images or ./fonts, and before deploying
to a host that can't list folders (GitHub Pages, Netlify, ...). Locally, with
`python -m http.server` or VS Code Live Server, the app finds new files on its own.
"""
import json
from pathlib import Path

root = Path(__file__).resolve().parent
lists = [
    ("images", "backgrounds.json", {".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"}),
    ("fonts", "fonts.json", {".ttf", ".otf", ".woff", ".woff2"}),
]

for folder_name, manifest, extensions in lists:
    folder = root / folder_name
    if not folder.is_dir():
        print(f"skipped: no {folder_name}/ folder next to this script")
        continue
    files = sorted((p.name for p in folder.iterdir() if p.is_file() and p.suffix.lower() in extensions), key=str.lower)
    (folder / manifest).write_text(json.dumps(files, indent=2) + "\n")
    print(f"{folder_name}/{manifest}: {len(files)} file(s)")
