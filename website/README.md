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

## 部署到 phi.semibot.ai（Cloudflare Pages）

官网是零构建静态站点，发布目录固定为 `website/`。仓库根目录的 `wrangler.toml` 已声明 Cloudflare Pages 输出目录，可直接使用 Wrangler 部署：

```sh
npx wrangler login
npx wrangler pages project create phi-website
npx wrangler pages deploy website --project-name phi-website
```

也可以在 Cloudflare Dashboard → Workers & Pages → Create application → Pages → Connect to Git 中连接 `GoatGit/phi`：

- Framework preset：`None`
- Build command：留空
- Build output directory：`website`
- Root directory：`/`

部署完成后，在 Pages 项目的 Custom domains 中添加 `phi.semibot.ai`。如果 `semibot.ai` 已托管在同一个 Cloudflare 账户，直接添加该子域即可由 Cloudflare 自动创建 DNS 记录并签发 HTTPS。Cloudflare Pages 通过 Custom domains 管理域名，不需要额外的 `CNAME` 文件。

### 本地预览

```sh
cd website
python3 -m http.server 4173
# 打开 http://localhost:4173
```

## 维护要点

- 下载入口统一指向 GitHub Releases：<https://github.com/GoatGit/phi/releases/latest>。
- 版本徽章（`v1.0.0`）在 `index.html` 的 `.dl-badge` 元素中，发版后手动更新。
- 新增受管 Agent 应用时，同步更新「受管应用」区块（`.apps-grid`）与 Hero 路由示意图（`assets` 无需改动，示意图为纯 SVG 抽象图）。
- 页面文案、JSON-LD 结构化数据均以仓库根 `README.md` 的产品描述为准，修改产品定位时两处同步。
