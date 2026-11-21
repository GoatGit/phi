# Assistant avatar artwork

`avatar-01.webp` — `avatar-16.webp`：16 张 256×256 的人像插画，用作智能体头像。

## 来源与授权

由项目所有者提供，取自 semibot-v3 仓库的
`apps/desktop/src/renderer/src/assets/bot-avatars/`（那边的同一批 webp 也没有被
主流程引用）。**这批图像没有随文件留存授权证明与生成方式，这里无法给出可信的
许可结论**；对外发布、第三方声明或任何许可审查之前，应先补齐出处。

在此之前这里放的是 DiceBear「Bottts」生成的 16 个机器人头像（`avatar-NN.svg`），
已随本次替换删除；那份授权说明（Bottts 免费商用 / DiceBear MIT）不再适用于
当前文件。

## 约定

- 键名固定为 `avatar-01`…`avatar-16`，与文件名一致；智能体上保存的是键名，不是路径。
- 智能体没有显式选过头像时，按 id 的 FNV-1a 哈希落到其中一张，所以同一个智能体
  在重启、改名之后仍是同一张脸。改动这批文件的数量会让哈希结果整体漂移。
