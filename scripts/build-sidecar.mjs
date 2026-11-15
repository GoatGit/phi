// 把 episode 侧车打成一个文件：sidecar/dist/router-episode.mjs。
//
// 打包这件事有两个坑，都在这里处理掉：
//
// 1. **CJS 依赖在 ESM 输出里 require 内置模块。** pi 的依赖链里有老式 CJS 包（chalk、
//    cli-highlight 之类）会在运行期 `require("os")`，esbuild 转成 ESM 之后这个调用会抛
//    「Dynamic require of "os" is not supported」。解法是给产物加一行 createRequire 兜底。
// 2. **不是所有依赖都能省掉。** pi-ai 的 mistral SDK 静态 import 了 `@opentelemetry/api`，
//    把它标成 external 会在启动时直接 module not found，所以它老老实实算依赖。
// 3. **原生模块不能内联。** photon（图像处理）与 koffi（FFI）带 `.node` 文件，只能标成外部。
//    实测我们的路径（读卡、判断、提名）不会碰它们：产物单独放到一个没有 node_modules 的
//    目录里也能正常启动，所以不随包分发。真要用了会在那一步报错，而不是整个侧车起不来。

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));

// 侧车有自己的 node_modules（pi SDK 与 esbuild 都装在那里），不污染应用根目录的依赖。
const { build } = createRequire(path.join(root, "sidecar", "package.json"))("esbuild");
const entry = path.join(root, "sidecar", "src", "episode.mjs");
const outfile = path.join(root, "sidecar", "dist", "router-episode.mjs");

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "none",
  logLevel: "warning",
  external: ["@silvia-odwyer/photon-node", "koffi"],
  banner: {
    js: "import { createRequire as __phiCreateRequire } from 'node:module'; const require = __phiCreateRequire(import.meta.url);",
  },
});

console.log(`sidecar bundled: ${path.relative(root, outfile)}`);
