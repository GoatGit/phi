# PHI 图标

应用图标固定使用黑底白色 φ，源文件为 `phi-app-icon.png`（1024 × 1024，圆角外透明）。桌面应用图标不随浅色 / 深色主题切换。

生成平台资源：

```sh
pnpm tauri icon docs/logo/phi-app-icon.png --output src-tauri/icons/phi --ios-color '#000000'
```

`src-tauri/tauri.conf.json` 使用 `src-tauri/icons/phi`。根目录 `src-tauri/icons` 的同名应用资源与它保持一致；额外的 `64x64.png` 和 `src/assets/icons/phi/256x256.png` 也从此源文件缩放生成。

侧栏的透明底标志、菜单栏模板图标分别按主题和 macOS 模板规则处理，使用各自的资源。
