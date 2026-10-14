#!/usr/bin/env python3
"""Build the pinned, native macOS Ghostty SDK using Command Line Tools.

Usage: python3 scripts/build_ghostty.py [--zig /path/to/zig] [--sdk /path/to/MacOSX.sdk]
Downloads are checksum verified. Build/cache files remain under tmp/ghostty-build.
The output is src-tauri/ghostty-sdk, which is linked and bundled by PHI.
"""
import argparse
import hashlib
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "tmp/ghostty-build"
VERSION = "1.2.3"
SOURCE_SHA = "e17d39482fc70fba3d72f5f25c12e9d9a72b87dd45a61a854d9928e98b69edd8"
ZIG_SHA = {
    "aarch64": "39f3dc5e79c22088ce878edc821dedb4ca5a1cd9f5ef915e9b3cc3053e8faefa",
    "x86_64": "b0f8bdfb9035783db58dd6c19d7dea89892acc3814421853e5752fe4573e5f43",
}


def download(url, path, checksum):
    if not path.exists():
        partial = path.with_suffix(".download")
        subprocess.run(["curl", "--fail", "--location", "--retry", "3", "--max-time", "180", "--output", str(partial), url], check=True)
        partial.replace(path)
    if hashlib.sha256(path.read_bytes()).hexdigest() != checksum:
        raise RuntimeError(f"Checksum mismatch: {path}; remove this download and retry")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zig", type=Path)
    parser.add_argument("--sdk", type=Path)
    parser.add_argument("--arch", choices=["aarch64", "x86_64"], help="Target architecture (defaults to this Mac)")
    options = parser.parse_args()
    if platform.system() != "Darwin":
        parser.error("The embedded Ghostty host currently builds on macOS only")
    arch = "aarch64" if platform.machine() == "arm64" else "x86_64"
    target_arch = options.arch or arch
    CACHE.mkdir(parents=True, exist_ok=True)
    zig = options.zig
    if not zig:
        zig_archive = CACHE / f"zig-{arch}-macos-0.14.1.tar.xz"
        download(f"https://ziglang.org/download/0.14.1/{zig_archive.name}", zig_archive, ZIG_SHA[arch])
        zig = CACHE / f"zig-{arch}-macos-0.14.1/zig"
        if not zig.exists():
            with tarfile.open(zig_archive) as archive:
                archive.extractall(CACHE, filter="data")
    zig = zig.resolve()
    if subprocess.check_output([zig, "version"], text=True).strip() != "0.14.1":
        raise RuntimeError("Ghostty 1.2.3 requires the pinned Zig 0.14.1 toolchain")
    archive_path = CACHE / f"ghostty-{VERSION}.tar.gz"
    download(f"https://codeload.github.com/ghostty-org/ghostty/tar.gz/refs/tags/v{VERSION}", archive_path, SOURCE_SHA)
    source = CACHE / f"ghostty-{VERSION}"
    patch = ROOT / "scripts/ghostty/phi-embedding.patch"
    stamp = hashlib.sha256(patch.read_bytes()).hexdigest()
    if not (source / ".phi-patch").exists() or (source / ".phi-patch").read_text() != stamp:
        # Replace only this script's pinned source files; preserve build caches.
        with tarfile.open(archive_path) as archive:
            archive.extractall(CACHE, filter="data")
        subprocess.run(["patch", "-p1", "-i", str(patch)], cwd=source, check=True)
        (source / ".phi-patch").write_text(stamp)
    shutil.copyfile(ROOT / "scripts/ghostty/combine_archives.py", source / "phi_combine_archives.py")
    # Zig 0.14's Mach-O linker cannot read the new SDK 26 text stubs. Prefer
    # an installed 15.x SDK; never change the global xcode-select setting.
    sdk = options.sdk
    if not sdk:
        candidates = sorted(Path("/Library/Developer/CommandLineTools/SDKs").glob("MacOSX15*.sdk"))
        sdk = candidates[0] if candidates else Path(subprocess.check_output(["xcrun", "--sdk", "macosx", "--show-sdk-path"], text=True).strip())
    sdk = sdk.resolve()
    if not (sdk / "usr/lib/libSystem.tbd").exists():
        raise RuntimeError(f"Invalid macOS SDK: {sdk}")
    shim = CACHE / "bin"
    shim.mkdir(exist_ok=True)
    wrapper = shim / "xcrun"
    wrapper.write_text('#!/bin/sh\nif [ "$*" = "--sdk macosx --show-sdk-path" ]; then\n  printf "%s\\n" "$PHI_GHOSTTY_MACOS_SDK"\nelse\n  exec /usr/bin/xcrun "$@"\nfi\n')
    wrapper.chmod(0o755)
    environment = dict(os.environ, PHI_GHOSTTY_MACOS_SDK=str(sdk))
    environment["PATH"] = str(shim) + os.pathsep + environment.get("PATH", "")
    subprocess.run([str(zig), "build", f"-Dtarget={target_arch}-macos.13.0", "-Doptimize=ReleaseFast", "-Dapp-runtime=none", "-Demit-xcframework=false", "-Demit-macos-app=false", "-Demit-docs=false", "-Demit-webdata=false", "-Demit-helpgen=false", "-Demit-themes=false", "-Dsentry=false", "-Dstrip=true", "-j4", "--prefix", str(ROOT / "src-tauri/ghostty-sdk")], cwd=source, env=environment, check=True)
    subprocess.run(["python3", str(ROOT / "scripts/ghostty/collect_licenses.py"), str(source), str(zig)], check=True)
    print(f"Ghostty {VERSION} ({target_arch}) SDK ready: src-tauri/ghostty-sdk")


if __name__ == "__main__":
    main()
