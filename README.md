# PHI

让用户自由使用所有模型。本地优先的 AI Agent 网关与配置管理桌面应用，基于 Tauri 2、Rust、React 和 TypeScript。

- 官网：https://phi.semibot.ai
- GitHub：https://github.com/GoatGit/phi
- 产品与技术设计：[docs/V1/README.md](docs/V1/README.md)

## 主要功能

- 管理多个 AI 编程工具的模型供应商与配置。
- 本地路由、协议转换、模型聚合与故障转移。
- 统一管理 MCP、Skills、提示词及项目配置。
- 查看会话、Token 用量与费用统计。
- 在 CLI 应用页点击 ＋，通过原生 Ghostty 终端启动应用（macOS 13+）。

## 本机编译（macOS）

需要 Node.js、pnpm、Rust、Python 3.12+ 和 Xcode Command Line Tools。在仓库根目录运行：

```sh
export PATH="/opt/homebrew/bin:$PATH"
pnpm install --frozen-lockfile
python3 scripts/build_ghostty.py
pnpm typecheck
pnpm tauri build --debug --bundles app
```

产物：`src-tauri/target/debug/bundle/macos/PHI.app`。Ghostty SDK 首次编译需下载固定版本源码与 Zig；无需安装 Ghostty.app。SDK、离线资源和原生检查详见 [scripts/ghostty/README.md](scripts/ghostty/README.md)。

## 启动

在仓库根目录运行，使用工作区内的独立测试数据目录：

```sh
open -n --env "PHI_TEST_HOME=$PWD/tmp/phi-local-home" "src-tauri/target/debug/bundle/macos/PHI.app"
```

主要配置和数据库位于 `tmp/phi-local-home/.phi/`。直接双击应用时默认使用 `~/.phi/`。旧版本的 `.cc-switch/` 数据不会自动迁移。

> 注意：`tmp/` 是本地开发/测试用的隔离 home（含真实请求数据），已被 `.gitignore` 忽略；发布仓库前请勿强制加入版本控制。

当前为本机调试构建，未完成正式签名与公证；独立签名更新通道尚未配置，“检查更新”跳转至 PHI 的 GitHub Releases。

## 来源与许可

PHI 从 CC Switch 的一次性源码快照开始独立开发，保留 MIT 许可证和原作者版权声明。来源、版本核验状态与构建说明见 [FORK-BASELINE.md](FORK-BASELINE.md)，许可证见 [LICENSE](LICENSE)。历史设计与上游发布资料保留原项目名称，以准确记录来源。
