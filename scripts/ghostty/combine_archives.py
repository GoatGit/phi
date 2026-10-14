#!/usr/bin/env python3
"""Normalize Zig archives before Apple's libtool (which skips unaligned members).

Only object bytes from the supplied build artifacts are combined. This avoids
scanning caches and accidentally linking objects from a previous build.
"""
import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile


def combine(output, archives):
    with tempfile.TemporaryDirectory(prefix="phi-ghostty-archive-") as directory:
        objects, seen = [], set()
        for archive in archives:
            data = Path(archive).read_bytes()
            if data[:8] != b"!<arch>\n":
                raise ValueError(f"Unsupported archive: {archive}")
            offset = 8
            while offset + 60 <= len(data):
                header = data[offset:offset + 60]
                size = int(header[48:58])
                name = header[:16].decode().strip()
                body = data[offset + 60:offset + 60 + size]
                offset += 60 + size + size % 2
                if name.startswith("#1/"):
                    length = int(name[3:])
                    name, body = body[:length].rstrip(b"\0").decode(), body[length:]
                if not name.endswith(".o") or body[:4] != b"\xcf\xfa\xed\xfe":
                    continue
                digest = hashlib.sha256(body).digest()
                if digest in seen:
                    continue
                seen.add(digest)
                path = Path(directory) / f"object-{len(objects)}.o"
                path.write_bytes(body)
                objects.append(str(path))
        if not objects:
            raise ValueError("No Mach-O objects in the supplied archives")
        subprocess.run(["/usr/bin/libtool", "-static", "-o", output, *objects], check=True)


if __name__ == "__main__":
    combine(sys.argv[1], sys.argv[2:])
