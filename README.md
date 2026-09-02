# site-native-favicons

site-native 应用的**独立图标项目**。本仓库只维护「内置站点图标」，与主应用代码解耦，单独部署到 CDN，供主应用在运行时 / 安装站点应用时读取，避免在主应用里重新解析网页踩坑。

## 仓库结构

- `catalog.json` —— 站点列表元数据（从主应用 `internal/Resources/catalog.json` 同步过来）。本脚本只用到其中的 `id` 与 `url`。
  - ⚠️ 与主应用 `internal/Resources/catalog.json` 是**两份独立拷贝**，新增 / 修改站点时需两边同步。本仓库这份是「图标维护」的权威来源。
- `gen-favicons.mjs` —— 生成脚本：读 `catalog.json`，抓取每个站点的真实 favicon，归一化为 128×128 透明 PNG，写入 `icons/{id}.png`。
- `icons/` —— 生成的 PNG，是 CDN 的部署根目录（GitHub Pages / jsDelivr / Cloudflare Pages 都直接服务这个目录）。

## 本地重新生成图标

```bash
npm install                                  # 安装 sharp + undici
HTTPS_PROXY=http://127.0.0.1:1081 npm run gen   # 走代理抓取；无代理可去掉环境变量
```

脚本输出 `Favicons generated: N ok, M failed (of ... sites)`；失败原因分级记录在
`%LOCALAPPDATA%\Temp\favicon-gen-report.json`，并在控制台打印前 3 个失败站点的逐源细节。

已知限制：
- `bitbucket` 官网 favicon 是**内联 SVG**，`sharp` 默认无法栅格化，需后续引入 `@resvg/resvg-js` 处理（TODO）。
- `tiktok` 已在 `gen-favicons.mjs` 的 `ICON_OVERRIDES` 里用官网高清直链覆盖。

## 部署到 CDN（三源冗余，同源不同 host）

本仓库即 `xiaonuankeji/site-native-favicons`，三个服务都直接服务 `icons/` 目录：

| 服务 | 图标 URL 模板 |
|---|---|
| GitHub Pages（主） | `https://xiaonuankeji.github.io/site-native-favicons/icons/{id}.png` |
| jsDelivr | `https://cdn.jsdelivr.net/gh/xiaonuankeji/site-native-favicons@main/icons/{id}.png` |
| Cloudflare Pages | `https://<你的 CF 子域>/icons/{id}.png`（待配置） |

> Cloudflare Pages 子域尚未配置，配好后把地址填入主应用 `internal/IconCdn.cs` 与
> `frontend/src/lib/iconCdn.ts` 的第三个 base URL 即可。

### GitHub Pages 开启方式
> 仓库已包含 `.nojekyll` 文件：GitHub Pages 会**跳过 Jekyll 构建、直接部署静态文件**，无需任何构建步骤。不要删除该文件。

1. 仓库 Settings → Pages → Build and deployment → Source 选 **Deploy from a branch**。
2. Branch 选 `main`，目录选 **/ (root)**，保存。
3. 等待数分钟，访问 `https://xiaonuankeji.github.io/site-native-favicons/icons/github.png` 验证。

### 更新图标
修改 `catalog.json`（增删站点）或 `gen-favicons.mjs`（新增 override 等）→ 重跑 `npm run gen` →
提交 `icons/` 改动并 push。主应用通过 CDN 自动拿到新图标，**无需发版**。

## 主应用侧接线（已实现，供核对）
- 前端 `frontend/src/lib/iconCdn.ts`：预览图标按三 CDN host 依次回退。
- C# `internal/IconCdn.cs` + `IconFetcher.FetchFromCdnAsync`：安装预置站点应用时，从 CDN 拉取图标落盘为窗口 / 任务栏图标。
- 自定义站点（不在 catalog 内）仍由主应用运行时解析网页获取图标。
