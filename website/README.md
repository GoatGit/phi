# phi 官网

phi 的产品官网，单页静态站点，零构建、零运行时依赖（仅引用 Google Fonts CDN）。

- 线上地址：<https://phi.semibot.ai>
- 页面结构：`index.html`（全部内容与交互脚本） + `css/style.css`（全部样式）

## 本地预览

```sh
cd website
python3 -m http.server 4173
# 打开 http://localhost:4173
```

## 部署到 phi.semibot.ai（任选其一）

### 方式一：GitHub Pages

1. 仓库 Settings → Pages → Source 选择 `main` 分支 `/website` 目录（或建 `gh-pages` 分支）。
2. 在 `website/` 下放置 `CNAME` 文件，内容为一行：`phi.semibot.ai`。
3. 到 semibot.ai 域名的 DNS 管理（或 `phi.semibot.ai` 所在托管区）添加解析：
   - `phi` CNAME → `<org>.github.io`（等待生效并确认 GitHub Pages 的 HTTPS 证书签发）。

### 方式二：任意静态托管 / 对象存储

上传 `website/` 目录内全部文件（保持相对路径），将 `phi.semibot.ai` 的 DNS 指向托管商分配的地址，并为该子域签发 HTTPS 证书。

## 维护要点

- 下载入口统一指向 GitHub Releases：<https://github.com/GoatGit/phi/releases/latest>。
- 版本徽章（`v1.0.0`）在 `index.html` 的 `.dl-badge` 元素中，发版后手动更新。
- 新增受管 Agent 应用时，同步更新「受管应用」区块（`.apps-grid`）与 Hero 路由示意图（`assets` 无需改动，示意图为纯 SVG 抽象图）。
- 页面文案、JSON-LD 结构化数据均以仓库根 `README.md` 的产品描述为准，修改产品定位时两处同步。
