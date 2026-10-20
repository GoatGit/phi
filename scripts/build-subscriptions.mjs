import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = process.env.TAURI_ENV_TARGET_TRIPLE || process.env.TARGET ||
  execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)?.[1];
const platforms = { "aarch64-apple-darwin": ["darwin", "arm64"], "x86_64-apple-darwin": ["darwin", "amd64"], "x86_64-pc-windows-msvc": ["windows", "amd64"], "aarch64-pc-windows-msvc": ["windows", "arm64"], "x86_64-unknown-linux-gnu": ["linux", "amd64"], "aarch64-unknown-linux-gnu": ["linux", "arm64"] };
if (!platforms[target]) throw new Error("Unsupported subscription engine target: " + target);
const [GOOS, GOARCH] = platforms[target];
const output = path.join(root, "src-tauri", "binaries");
mkdirSync(output, { recursive: true });
try {
  execFileSync("go", ["build", "-mod=mod", "-trimpath", "-ldflags=-s -w", "-o", path.join(output, "phi-subscriptions-" + target + (GOOS === "windows" ? ".exe" : "")), "."], {
    cwd: path.join(root, "subscriptions", "bridge"), stdio: "inherit",
    env: { ...process.env, GOOS, GOARCH, CGO_ENABLED: "0" },
  });
} catch (error) {
  if (error.code === "ENOENT") throw new Error("Go is required to build Phi's subscription engine. Install Go (automatic toolchain selection enabled) and retry.");
  throw error;
}
