# Fork 基线记录

| 项 | 值 |
|---|---|
| 上游项目 | [farion1231/cc-switch](https://github.com/farion1231/cc-switch) |
| 基线版本 | v4.0.8 |
| 上游基线提交 | `2b0ec81`（2026-10-11，main） |
| 落盘时间 | 2026-10-11 |
| 本仓库策略 | 一次性快照 fork，此后**不合并上游**；安全与适配器关键修复按 SOP 手动移植（见 `docs/V1/01-总体设计.md` §2、`docs/V1/04-Agent配置适配层设计.md` §5） |
| 许可 | 上游 MIT © Jason Young，本仓库保留其版权声明（见 LICENSE 与 `docs/V1/01-总体设计.md` §2.3） |

## 原始副本

`tmp/cc-switch`（含上游 .git）保留为调研参考，不参与构建；工作区根目录为本仓库 fork 起点。

## 本机编译与运行

当前使用本地提供的 `2b0ec81bb2f150ccfae7c60a462012a89c99f450` 快照；其 package 版本为 4.0.8，但本地 HEAD 没有 release tag，尚未核实它是上游最新稳定版。正式冻结发布基线前应另行核验。

macOS 本机验证使用独立应用标识，与已安装的 CC Switch 区分。以下命令在仓库根目录执行：

```sh
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
pnpm install --frozen-lockfile
pnpm typecheck
pnpm tauri build --debug --bundles app
open -n --env "PHI_TEST_HOME=$PWD/tmp/phi-local-home" 'src-tauri/target/debug/bundle/macos/PHI.app'
```

- 产物：`src-tauri/target/debug/bundle/macos/PHI.app`。
- 主要配置、SQLite 数据库和日志：`tmp/phi-local-home/.phi/`，数据库为 `phi.db`。这是测试 home 覆盖，不是操作系统沙箱。旧 `.cc-switch/` 数据不会自动迁移。
- 每次启动应使用上述带环境变量的命令；直接双击应用不会保留该测试 home 设置。
- 产品名为 PHI，应用标识为 `ai.semibot.phi`，深链协议为 `phi://`；官网为 https://phi.semibot.ai，仓库为 https://github.com/GoatGit/phi。
- 这是本机调试构建，尚未完成独立签名更新通道、正式签名或公证；已禁用上游自动更新配置，手动检查更新跳转至 PHI GitHub Releases。
- 本次使用 Homebrew Cargo 1.96.0 编译；`rust-toolchain.toml` 声明 1.95，本次没有通过 rustup 验证该固定工具链。

## 后续改造规划

见 `docs/V1/`（总体设计 + 8 个模块详细设计）。
