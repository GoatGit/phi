#!/usr/bin/env python3
"""Bundle notices from pinned Ghostty sources and its downloaded dependency graph.

The inventory is deliberately inclusive: cached optional dependencies reachable
from Ghostty may also appear. It is not a claim that every listed package links.
"""
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

root = Path(__file__).resolve().parents[2]
source = Path(sys.argv[1]).resolve()
zig = sys.argv[2]
cache = Path(json.loads(subprocess.check_output([zig, "env"], text=True))["global_cache_dir"]) / "p"
output = root / "src-tauri/ghostty-sdk/share/ghostty/licenses"
output.mkdir(parents=True, exist_ok=True)
pending = [("ghostty", source)]
visited = set()
inventory = []
while pending:
    name, package = pending.pop()
    package = package.resolve()
    if package in visited or not package.is_dir():
        continue
    visited.add(package)
    notices = []
    for path in package.rglob("*"):
        relative = path.relative_to(package)
        if any(part.startswith(".") or part in {"node_modules", "zig-out"} for part in relative.parts):
            continue
        if path.is_file() and re.match(r"^(licen[cs]e|copying|copyright|notice|ofl)([._-]|$)", path.name, re.I):
            dest = output / name / relative
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, dest)
            notices.append(str(relative))
    for manifest in package.rglob("build.zig.zon"):
        if any(part.startswith(".") for part in manifest.relative_to(package).parts):
            continue
        content = manifest.read_text()
        relative = manifest.relative_to(package)
        dest = output / name / relative
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(content)
        for digest in re.findall(r'\.hash\s*=\s*"([^"]+)"', content):
            pending.append((digest, cache / digest))
    inventory.append({"package": name, "notices": sorted(notices)})
(output / "inventory.json").write_text(json.dumps(sorted(inventory, key=lambda item: item["package"]), indent=2) + "\n")
print(f"Bundled Ghostty notices: {len(inventory)} source packages")
