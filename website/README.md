# KillCam 官网

KillCam 的官方网站，Next.js 15 + TypeScript，中英双语（`/zh`、`/en`），部署在 Vercel。

## 本地运行

```bash
cd website
npm install
npm run dev
```

打开 http://localhost:3000 会按浏览器语言跳到 `/zh` 或 `/en`。

## 部署到 Vercel

1. Vercel → Add New → Project → 导入 `Jkeroromk/killcam`。
2. **Root Directory 选 `website`**（仓库根目录是桌面应用，不是网站）。
3. Framework 会自动识别为 Next.js，其他保持默认，点 Deploy。
4. 可选的环境变量：
   - `NEXT_PUBLIC_SITE_URL`：正式域名，比如 `https://killcam.jkeroro.com`，用于分享卡片和 canonical 链接。
   - `GITHUB_TOKEN`：只在 GitHub API 匿名额度（每小时 60 次）不够用时才需要。建一个不带任何权限的 fine-grained token 就行。

只改了 `src/` 或 `src-tauri/` 的提交不需要重新部署网站，可以在 Vercel 项目设置 → Git → Ignored Build Step 里填：

```bash
git diff --quiet HEAD^ HEAD -- .
```

（在 `website` 目录里执行，网站没变就跳过构建。）

## 内容从哪来

| 内容 | 位置 |
|---|---|
| 所有文字（中英） | `lib/i18n.ts` |
| 首页时间轴里的示例对局 | `lib/match.ts` |
| 下载按钮、版本号、更新日志 | GitHub Releases，自动读取，每小时刷新一次 |
| 截图 | `public/screens/`（和仓库 `docs/screenshots/` 是同一组图） |

更新日志直接用每个 Release 的说明文字。发布脚本自动加的那两行安装提示会被去掉；想让更新日志有内容，在 GitHub 上编辑对应 Release 的说明即可，支持标题、列表、链接、**粗体** 和 `代码`。
