// 把 node 运行时放进 src-tauri/binaries/phi-node-<triple>，让安装包自带运行时。
//
// 为什么是官方单文件：侧车跑的是 pi SDK，它声明 engines.node >= 20.6，依赖树里还有原生模块，
// 所以不能指望用户机器上有 node。代价是安装包大一圈（实测 macOS arm64 解包 115 MB、
// 下载包 +37 MB 左右），换来的是「装上就能用」。
//
// 这个脚本只在构建时跑，而且会缓存：文件在就不重复下载。想强制刷新设 PHI_NODE_REFRESH=1。

import { execFileSync } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync, rmSync, createReadStream } from "node:fs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";
import os from "node:os";

/** 固定版本，不跟着 latest 漂。升级时改这里，并在 CHANGELOG 里写一句。 */
const NODE_VERSION = "v24.16.0";

const platforms = {
  "aarch64-apple-darwin": { dist: "darwin-arm64", archive: "tar.gz", binary: "bin/node" },
  "x86_64-apple-darwin": { dist: "darwin-x64", archive: "tar.gz", binary: "bin/node" },
  "x86_64-unknown-linux-gnu": { dist: "linux-x64", archive: "tar.gz", binary: "bin/node" },
  "aarch64-unknown-linux-gnu": { dist: "linux-arm64", archive: "tar.gz", binary: "bin/node" },
  "x86_64-pc-windows-msvc": { dist: "win-x64", archive: "zip", binary: "node.exe" },
  "aarch64-pc-windows-msvc": { dist: "win-arm64", archive: "zip", binary: "node.exe" },
};

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "src-tauri", "binaries");

const target = process.env.TAURI_ENV_TARGET_TRIPLE || process.env.TARGET ||
  execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)?.[1];

const platform = platforms[target];
if (!platform) throw new Error("不支持的目标平台：" + target);

const binaryName = "phi-node-" + target + (platform.dist.startsWith("win") ? ".exe" : "");
const binaryPath = path.join(output, binaryName);

if (existsSync(binaryPath) && process.env.PHI_NODE_REFRESH !== "1") {
  console.log(`node 运行时已存在：${path.relative(root, binaryPath)}`);
  process.exit(0);
}

mkdirSync(output, { recursive: true });

const archive = `node-${NODE_VERSION}-${platform.dist}.${platform.archive}`;
const url = `https://nodejs.org/dist/${NODE_VERSION}/${archive}`;
const tmp = path.join(os.tmpdir(), `phi-${archive}`);

console.log(`下载 node 运行时：${url}`);
const response = await fetch(url);
if (!response.ok) throw new Error(`下载失败 ${response.status}：${url}`);
await pipeline(Readable.fromWeb(response.body), createWriteStream(tmp));

const staging = path.join(os.tmpdir(), `phi-node-${NODE_VERSION}-${platform.dist}`);
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

if (platform.archive === "tar.gz") {
  // 只解出那一个可执行文件：整个包里还有 npm 与头文件，用不上。
  execFileSync("tar", ["-xzf", tmp, "-C", staging, `node-${NODE_VERSION}-${platform.dist}/${platform.binary}`], {
    stdio: "inherit",
  });
} else {
  execFileSync("powershell", ["-NoProfile", "-Command",
    `Expand-Archive -Force -Path '${tmp}' -DestinationPath '${staging}'`], { stdio: "inherit" });
}

const extracted = path.join(staging, `node-${NODE_VERSION}-${platform.dist}`, platform.binary);
if (!existsSync(extracted) && !existsSync(path.join(staging, platform.binary))) {
  throw new Error("解包后没找到 node 可执行文件：" + extracted);
}
const source = existsSync(extracted) ? extracted : path.join(staging, platform.binary);

// 复制而不是移动：Windows 上还在用的文件不能直接改名。
await pipeline(createReadStream(source), createWriteStream(binaryPath));
chmodSync(binaryPath, 0o755);

rmSync(tmp, { force: true });
rmSync(staging, { recursive: true, force: true });

const size = readFileSync(binaryPath).byteLength;
console.log(`node 运行时就绪：${path.relative(root, binaryPath)}（${(size / 1024 / 1024).toFixed(0)} MB）`);
