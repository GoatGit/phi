# PHI 官网

PHI 的产品官网，暖白与深绿色的章节式页面，支持简体中文、英文和日文。发布物为纯静态 HTML / CSS，无外部字体、外部脚本或运行时依赖。

- 线上地址：<https://phi.semibot.ai>
- 中文：`index.html`（`/`）；英文：`en/index.html`（`/en/`）；日文：`ja/index.html`（`/ja/`）。
- 共用样式：`css/style.css`；语言切换收在原生下拉选择框中，使用内联 `onchange` 跳转，并提供 `noscript` 链接兜底；不强制按浏览器语言跳转。
- `assets/phi-app.svg` 内嵌应用原始 PNG，保留现有资源路径。
- `assets/apps/*` 为「支持的应用」板块使用的应用标志，取自桌面端 `src/icons/extracted`（Hermes 导出为 128px PNG）。图标是装饰性的，名称由相邻文本提供，`alt` 留空。

## 本地预览

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory website
# 打开 http://127.0.0.1:4173
```

## 多语言维护与验证

中文 `website/index.html` 为结构和文案源文件，英日译文集中在 `scripts/website-translations.json`，每项依次为「规范化的中文原文、英文、日文」。命令、产品名称、资源与仓库路径不翻译。

修改中文内容或共用页面结构后，更新对应译文并生成英日页面：

```sh
python3 scripts/build_website.py
python3 scripts/build_website.py --check
python3 scripts/test_website.py
```

生成器会在缺少译文或存在过期原文时失败。生成的英日 HTML 需一同纳入版本管理；不要直接编辑生成页。也可以用 `--stdout en` / `--stdout ja` 仅查看生成结果。

三种语言都有独立的标题、描述、`lang`、canonical、Open Graph、JSON-LD，以及互相指向的 `hreflang` 链接。默认入口为中文。测试覆盖翻译完整性、生成结果一致性、三语下拉切换与 `noscript` 兜底、资源与锚点、元数据及英文页面的中文漏译。浏览器验收还需检查长标题、日文换行、移动端语言入口和键盘焦点。

## 部署

Cloudflare Pages 项目为 `phi-website`，发布目录为 `website/`。使用已授权的 Cloudflare 登录态执行生产部署：

```sh
npx wrangler pages deploy website --project-name phi-website --branch main
```

生产域名为 <https://phi.semibot.ai>。发布前执行上述生成与验证命令。发布后核验 `/`、`/en/`、`/ja/` 的语言切换、CSS、图标、页面标题、重点文案与 `_headers` 中的安全响应头。仅修改本地文件不会更新线上页面。

## 内容与样式维护

- 页面结构：首屏工作台示意 → 四个统一（网关、路由、会话与记忆、CLI 终端）→ 产品缘起 → 统一网关 → 支持的应用 → 统一路由 → 统一会话与记忆（规划中）→ 统一 CLI 终端 → 配置 → 用量 → 本地数据 → 上手步骤 → 常见问题 → 下载。
- 所有用户可见品牌文案统一为 PHI；域名、仓库地址、文件名与资源路径保持原值。
- 内容以当前源码和实际配置为依据，README 作为补充。平台说明需同时检查 `src-tauri/tauri.conf.json`、`src-tauri/tauri.macos.conf.json` 和发布工作流；不凭文档承诺未核验的最低系统版本。
- 网关协议以 `src-tauri/src/proxy/protocol/mod.rs` 为准：四种聊天协议（OpenAI Chat、OpenAI Responses、Anthropic Messages、Gemini 原生）已经可用；System One 只能写成「即将支持」，并说明它是按问题和答案组织的决策协议，不走聊天中转。实现接入后再改为已支持。
- 路由策略以 `src-tauri/src/gateway/routing.rs` 的 `Strategy` 与 `classifier` 为准；会话与记忆章节必须保留“规划中”标记，现有会话浏览只描述本地记录读取。
- 内嵌终端目前仅 macOS 13+ 可用，需要用户自行安装 CLI。支持列表见 `src-tauri/src/terminal/launch.rs`；分屏是同一工具的多个会话。
- 不写“密钥绝不离开本机”等绝对承诺：模型请求及所需凭据会发送至用户选择的供应商。
- 下载入口指向 <https://github.com/GoatGit/phi/releases/latest>；三个系统入口均前往同一发布页，不伪装成直接下载。版本、包格式与架构以实际 Release 为准。
- `.workspace-preview`、`.terminal-shot`、`.flow`、`.heat` 均是静态示意，须保留文字说明，不使用未经核实的产品截图或虚构用量。
- 文案围绕用户的具体工作，少用术语堆叠；维持章节、列表、留白的阅读节奏。
- 常见问题使用原生 `details` / `summary`，无 JavaScript 依赖，需检查鼠标和键盘展开。
- 修改 CSS 后递增页面样式 URL 版本参数（当前 `apps-1`）；新增资源如采用长期缓存，也需更新文件名或版本参数。
- 检查窄屏、桌面端、键盘焦点、锚点定位及减少动态效果偏好。不要引入外部字体、脚本或统计服务。
