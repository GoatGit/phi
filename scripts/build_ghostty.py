#!/usr/bin/env python3
"""Build the pinned, native macOS Ghostty SDK using Command Line Tools.

Usage: python3 scripts/build_ghostty.py [--zig /path/to/zig] [--sdk /path/to/MacOSX.sdk]
Downloads are checksum verified. Build/cache files remain under tmp/ghostty-build.
The output is src-tauri/ghostty-sdk, which is linked and bundled by PHI.
"""
import argparse
import codecs
import hashlib
import math
import os
from pathlib import Path
import platform
import selectors
import shutil
import signal
import subprocess
import tarfile
import time

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "tmp/ghostty-build"
VERSION = "1.2.3"
SOURCE_SHA = "e17d39482fc70fba3d72f5f25c12e9d9a72b87dd45a61a854d9928e98b69edd8"
# All dependency-fetch retries share this build budget; leave CI time for Rust.
BUILD_TIMEOUT_SECONDS = 20 * 60
BUILD_ATTEMPTS = 3
RETRY_DELAY_SECONDS = 10
HEARTBEAT_SECONDS = 30
OUTPUT_TAIL_CHARS = 128 * 1024
READ_CHUNK_BYTES = 16 * 1024

ZIG_SHA = {
    "aarch64": "39f3dc5e79c22088ce878edc821dedb4ca5a1cd9f5ef915e9b3cc3053e8faefa",
    "x86_64": "b0f8bdfb9035783db58dd6c19d7dea89892acc3814421853e5752fe4573e5f43",
}


# ziglang.org 的带宽会长时间掉到几十 KB/s，46MB 的 zig 工具链按单次 180 秒
# 整包下载必然超时。改成「断点续传 + 总预算」：每次尝试接着上次的字节往下拉，
# 只要总带宽能把整包拉完就能成功，中途断几次都不影响。
DOWNLOAD_BUDGET_SECONDS = 15 * 60
DOWNLOAD_ATTEMPT_SECONDS = 240
DOWNLOAD_ATTEMPTS = 8
DOWNLOAD_RETRY_DELAY_SECONDS = 3
DOWNLOAD_MIN_ATTEMPT_SECONDS = 30


def download(url, path, checksum):
    """下载并校验固定内容；中断的进度留在 .download 里，下一轮接着传。"""
    if path.exists():
        if hashlib.sha256(path.read_bytes()).hexdigest() == checksum:
            return
        raise RuntimeError(f"Checksum mismatch: {path}; remove this download and retry")

    partial = path.with_suffix(".download")
    deadline = time.monotonic() + DOWNLOAD_BUDGET_SECONDS
    for attempt in range(1, DOWNLOAD_ATTEMPTS + 1):
        remaining = deadline - time.monotonic()
        if remaining < DOWNLOAD_MIN_ATTEMPT_SECONDS:
            break
        timeout = min(DOWNLOAD_ATTEMPT_SECONDS, int(remaining))
        resume_from = partial.stat().st_size if partial.exists() else 0
        command = ["curl", "--fail", "--location", "--max-time", str(timeout), "--output", str(partial)]
        if resume_from:
            command[1:1] = ["--continue-at", "-"]
            print(f"Resuming {path.name} at {resume_from} bytes")
        command.append(url)
        result = subprocess.run(command)
        if partial.exists() and hashlib.sha256(partial.read_bytes()).hexdigest() == checksum:
            partial.replace(path)
            return
        # 不支持 Range 的源（codeload 这类现算的打包接口）遇到 --continue-at 会直接失败、
        # 一个字节都不传，留着临时文件只会让每一轮都撞同一堵墙：丢掉进度，下一轮从头来。
        stalled = partial.exists() and partial.stat().st_size <= resume_from
        if resume_from and result.returncode != 0 and stalled:
            print(f"{path.name}: the server refused to resume, restarting from scratch")
            partial.unlink()
        if attempt == DOWNLOAD_ATTEMPTS:
            break
        print(f"Download attempt {attempt}/{DOWNLOAD_ATTEMPTS} of {path.name} failed with exit {result.returncode}; retrying")
        time.sleep(DOWNLOAD_RETRY_DELAY_SECONDS)

    raise RuntimeError(f"Download failed: {url}; partial download kept at {partial}")


# Zig resolves Ghostty's git dependencies while building. codeberg.org
# occasionally drops the capability probe (EndOfStream), which is transient and
# unrelated to the source: retry only those failures, not compile errors.
TRANSIENT_FETCH_ERRORS = (
    "unable to discover remote git server capabilities",
    "endofstream",
    "failed to fetch",
    "unable to fetch",
    "connection reset",
    "connection timed out",
    "could not resolve host",
    "temporary failure in name resolution",
    # CI runners lose DNS for individual dependency hosts now and then; Zig
    # reports that as UnknownHostName rather than a resolution failure.
    "unable to connect to server",
    "unknownhostname",
    "network is unreachable",
)


def run_build_attempt(command, cwd, environment, deadline, timeout_seconds):
    output = ""
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    process = subprocess.Popen(
        command,
        cwd=cwd,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    try:
        with process.stdout, selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            heartbeat = time.monotonic() + HEARTBEAT_SECONDS
            while selector.get_map():
                now = time.monotonic()
                if now >= deadline:
                    raise subprocess.TimeoutExpired(command, timeout_seconds, output=output)
                events = selector.select(min(deadline - now, max(0, heartbeat - now)))
                for key, _ in events:
                    chunk = os.read(key.fd, READ_CHUNK_BYTES)
                    text = decoder.decode(chunk, final=not chunk)
                    print(text, end="", flush=True)
                    output = (output + text)[-OUTPUT_TAIL_CHARS:]
                    if not chunk:
                        selector.unregister(key.fileobj)
                if time.monotonic() >= heartbeat:
                    print("Ghostty build still running; waiting for Zig", flush=True)
                    heartbeat = time.monotonic() + HEARTBEAT_SECONDS
            process.wait(timeout=max(0, deadline - time.monotonic()))
        return process.returncode, output
    except BaseException:
        # Zig launches compilers/fetch helpers. Killing only its leader leaks them,
        # including children that keep stdout open after the leader has exited.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
        raise


def run_zig_build(command, cwd, environment, attempts=BUILD_ATTEMPTS, timeout_seconds=BUILD_TIMEOUT_SECONDS):
    if attempts < 1 or not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
        raise ValueError("Build attempts and timeout must be positive")
    deadline = time.monotonic() + timeout_seconds
    for attempt in range(1, attempts + 1):
        print(f"Ghostty build attempt {attempt}/{attempts} (total budget {timeout_seconds:g}s)", flush=True)
        try:
            returncode, output = run_build_attempt(command, cwd, environment, deadline, timeout_seconds)
        except subprocess.TimeoutExpired:
            print(f"Ghostty build exceeded its {timeout_seconds:g}s budget; process group killed", flush=True)
            raise
        if returncode == 0:
            return
        transient = any(marker in output.lower() for marker in TRANSIENT_FETCH_ERRORS)
        if not transient or attempt == attempts:
            raise subprocess.CalledProcessError(returncode, command, output=output)
        delay = RETRY_DELAY_SECONDS * attempt
        remaining = deadline - time.monotonic()
        if remaining <= delay:
            print("Ghostty build has no retry budget remaining", flush=True)
            raise subprocess.TimeoutExpired(command, timeout_seconds, output=output)
        print(
            f"Ghostty dependency download failed (attempt {attempt}/{attempts}); retrying in {delay}s",
            flush=True,
        )
        time.sleep(delay)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zig", type=Path)
    parser.add_argument("--sdk", type=Path)
    parser.add_argument("--arch", choices=["aarch64", "x86_64"], help="Target architecture (defaults to this Mac)")
    parser.add_argument("--build-timeout", type=float, default=BUILD_TIMEOUT_SECONDS, help="Total Zig build budget in seconds, including fetch retries (default: %(default)s)")
    options = parser.parse_args()
    if not math.isfinite(options.build_timeout) or options.build_timeout <= 0:
        parser.error("--build-timeout must be a positive finite number")
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
    # Ghostty derives its version from git when no version string is given, then
    # panics on a tag that does not equal its own ("tagged releases must be in
    # vX.Y.Z format matching build.zig"). Building from PHI's release tag would
    # hit that on every release, so pin the version explicitly.
    command = [str(zig), "build", f"-Dtarget={target_arch}-macos.13.0", f"-Dversion-string={VERSION}", "-Doptimize=ReleaseFast", "-Dapp-runtime=none", "-Demit-xcframework=false", "-Demit-macos-app=false", "-Demit-docs=false", "-Demit-webdata=false", "-Demit-helpgen=false", "-Demit-themes=false", "-Dsentry=false", "-Dstrip=true", "-j4", "--prefix", str(ROOT / "src-tauri/ghostty-sdk")]
    run_zig_build(command, source, environment, timeout_seconds=options.build_timeout)
    subprocess.run(["python3", str(ROOT / "scripts/ghostty/collect_licenses.py"), str(source), str(zig)], check=True)
    print(f"Ghostty {VERSION} ({target_arch}) SDK ready: src-tauri/ghostty-sdk")


if __name__ == "__main__":
    main()
