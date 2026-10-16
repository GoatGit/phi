# phi 官网

phi 的产品官网，浅色单页静态站点，零构建、无外部字体或运行时依赖。

- 线上地址：<https://phi.semibot.ai>
- 页面结构：`index.html`（全部内容） + `css/style.css`（全部样式）。
- `assets/phi-app.svg` 内嵌 App 的原始 PNG（`src/assets/icons/phi/256x256.png`），未重绘图标。

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
- 不硬编码版本号，平台与版本以 Releases 页面为准。
- 新增受管 Agent 应用时，同步更新 `.apps` 中的应用列表。
- 更新样式后递增 `index.html` 中 CSS URL 的版本参数，避免长期缓存沿用旧样式。
- 页面文案、JSON-LD 结构化数据均以仓库根 `README.md` 的产品描述为准，修改产品定位时两处同步。
