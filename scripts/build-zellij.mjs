// 把 zellij 放进安装包：后台 worker 跑在它里面，不指望用户机器上已经有 zellij。
//
// 为什么是 `no-web` 包：我们需要的是它的 session/pane 能力，那一份少一个 web server
// 与 HTTP 栈，体积小几 MB，攻击面也小。
//
// 产物落在 src-tauri/binaries/zellij-<triple>，与 phi-node、phi-subscriptions 同一套
// 命名规则：tauri.macos.conf.json 的 externalBin 就是按 triple 找文件的。
// 打完包它会在 PHI.app/Contents/MacOS/zellij，运行时的解析顺序是
// 「PHI_ZELLIJ_BIN → 主程序同目录 → PATH」。
//
// 只跑在构建时，并且缓存：文件在就不重复下载。强制刷新设 PHI_ZELLIJ_REFRESH=1。
//
// 升级 zellij 版本前请先复核这几个选项还在（它们是 worker 的命脉）：
//   attach --create-background <session>
//   --session <name> action new-pane --name <n> --cwd <dir> -- <argv...>
//   --session <name> action list-panes -a -j
//   --session <name> action close-pane --pane-id <id>

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import os from "node:os";

/** 固定版本，不跟着 latest 漂。升级时改这里，并复核文件头列出的那几个子命令。 */
const ZELLIJ_VERSION = "v0.46.0";

const arches = {
  aarch64: "aarch64",
  x86_64: "x86_64",
};

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "src-tauri", "binaries");

function rustHostTriple() {
  try {
    const info = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
    return info.match(/^host: (.+)$/m)?.[1];
  } catch {
    return undefined;
  }
}

function targetTriples() {
  const explicit = process.argv.find((arg) => arg.startsWith("--target="));
  const target = explicit
    ? explicit.slice("--target=".length)
    : process.env.TAURI_ENV_TARGET_TRIPLE ||
      process.env.TARGET ||
      rustHostTriple();
  if (!target) throw new Error("拿不到构建目标（rustc -vV 也没有 host）");
  if (target === "universal-apple-darwin") {
    return ["aarch64-apple-darwin", "x86_64-apple-darwin"];
  }
  return [target];
}

function archOf(triple) {
  const arch = triple.split("-")[0];
  if (!arches[arch])
    throw new Error(
      `zellij 只有 macOS 的 arm64 / x86_64 发行包，收到 ${triple}`,
    );
  if (!triple.endsWith("-apple-darwin")) {
    throw new Error(`zellij 只随 macOS 安装包分发，收到 ${triple}`);
  }
  return arch;
}

function binaryName(triple) {
  return "zellij-" + triple;
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载失败 ${response.status}：${url}`);
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(destination),
  );
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** 解出 tar.gz 里唯一要的那个可执行文件。 */
function extractBinary(archive, destination, name) {
  const staging = path.join(os.tmpdir(), `phi-zellij-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", staging, name], {
    stdio: "inherit",
  });
  copyFileSync(path.join(staging, name), destination);
  rmSync(staging, { recursive: true, force: true });
}

async function fetchArch(triple) {
  const arch = archOf(triple);
  const name = binaryName(triple);
  const destination = path.join(output, name);
  if (existsSync(destination) && process.env.PHI_ZELLIJ_REFRESH !== "1") {
    console.log(`zellij 已存在：${path.relative(root, destination)}`);
    return destination;
  }
  mkdirSync(output, { recursive: true });

  const asset = `zellij-no-web-${arch}-apple-darwin`;
  const base = `https://github.com/zellij-org/zellij/releases/download/${ZELLIJ_VERSION}`;
  const archive = path.join(os.tmpdir(), `phi-${asset}.tar.gz`);
  const checksumFile = path.join(os.tmpdir(), `phi-${asset}.sha256sum`);

  console.log(`下载 zellij：${base}/${asset}.tar.gz`);
  await download(`${base}/${asset}.tar.gz`, archive);
  await download(`${base}/${asset}.sha256sum`, checksumFile);

  // 官方的 sha256sum 描述的是**解包后的二进制**（行里写的是 target/.../zellij），
  // 不是 tarball 本身——所以先解包再比，比错了这个文件才不落地。
  extractBinary(archive, destination, "zellij");
  const expected = readFileSync(checksumFile, "utf8").trim().split(/\s+/)[0];
  const actual = sha256(destination);
  if (!expected || expected !== actual) {
    rmSync(destination, { force: true });
    rmSync(archive, { force: true });
    throw new Error(`zellij 校验失败：期望 ${expected}，实际 ${actual}`);
  }

  chmodSync(destination, 0o755);
  rmSync(archive, { force: true });
  rmSync(checksumFile, { force: true });
  const size = readFileSync(destination).byteLength;
  console.log(
    `zellij 就绪：${path.relative(root, destination)}（${(size / 1024 / 1024).toFixed(0)} MB，${ZELLIJ_VERSION}）`,
  );
  return destination;
}

const triples = targetTriples();
const built = [];
for (const triple of triples) {
  built.push(await fetchArch(triple));
}

// universal 包：tauri 在 universal 目标下找的是 zellij-universal-apple-darwin。
if (triples.length === 2) {
  const universal = path.join(output, binaryName("universal-apple-darwin"));
  execFileSync("lipo", ["-create", "-output", universal, ...built], {
    stdio: "inherit",
  });
  chmodSync(universal, 0o755);
  console.log(`zellij universal 就绪：${path.relative(root, universal)}`);
}
