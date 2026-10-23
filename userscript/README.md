# Manga Image Translator Userscript

这个目录提供一个独立的 Tampermonkey 油猴脚本工程，用于把本地或远程部署的 `manga-image-translator` 服务接入任意漫画/图片站点。新安装默认连接 `http://127.0.0.1:8001` 并使用本地 Ollama；已有持久化设置不会被覆盖。

This directory contains a standalone Tampermonkey userscript project for connecting arbitrary image-heavy sites to a local or remote `manga-image-translator` server.

## Features

- 手动启动后立即反馈扫描结果，并持续追踪新增图片、懒加载属性与 `<picture>` 换源
- 译图直接替换原图，同时保留图片角上的状态卡与原图切换
- 支持通用兜底 + 可扩展站点适配器，可按站点控制候选图片区范围
- 支持远程 `serverBaseUrl + apiKey`
- 原图按来源自动选路：同源优先 `fetch`，跨域优先 `GM_xmlhttpRequest`，失败后再尝试另一条网络路径与受内存保护的页面像素兜底
- 原图读取显示字节进度，支持取消、超时和一次自动重试；长图使用页面像素前会明确提示内存风险
- 支持本地持久化结果缓存，可在设置中关闭
- 支持单图取消、重试、忽略，全局原图/译图切换

## 1.5.2：Stay 响应读取兼容修复

- GM 翻译请求会在提交前选择响应格式：Tampermonkey 保留流式读取，Stay 与未识别的脚本管理器使用 `arraybuffer`，等完整响应到达后解析。
- 修复请求已被受理后出现 `Accepted GM translation did not expose a readable response body.` 的兼容性问题；multipart 与 base64 JSON 上传均适用。
- 保留标准流协议和 Web 快路径的 `final_ready` 结果下载，不会为了切换响应格式重复提交已受理的翻译任务。兼容模式等待期间不显示实时翻译阶段进度。
- 增加固定的在线更新地址和 `.meta.js` 更新检测附件。在 Stay 中通过[在线安装地址](https://github.com/yinxy233/manga-image-translator/releases/latest/download/manga-image-translator-userscript.user.js)覆盖安装，确认版本为 **1.5.2**，再刷新 Safari 漫画页。无需调整运行时机或注入方式。

## 1.5.1：扫描反馈与慢图处理

- 点击“译”后直接显示已发现的图片和实际扫描数量，无需等原图下载、哈希计算或翻译完成。
- 同一轮扫描合并更新图片状态；读取槽位被占用时不再反复遍历待处理图片，减少长章节的同步工作量。
- 普通情况下同时读取一张原图。连续 3 秒没有字节进度时，允许另一张当前可见图片先读取，同时最多读取两张，避免长图占用过多内存。
- 原图读取提供字节进度、取消、失败重试和超时反馈。单条网络路径的首包等待为 10 秒、无进度等待为 15 秒、总时限为 120 秒；切换路径和一次自动重试会使整次读取耗时更长。

安装构建产物时确认脚本管理器中的版本为 **1.5.2**，然后刷新已打开的漫画页面。新提示会显示“已发现 N 张”；旧页面仍可能保留旧版脚本的执行实例。

## Build

```bash
cd userscript
pnpm install
pnpm check
pnpm build
```

构建完成后，产物会出现在 `userscript/dist/`，将其中的 `.user.js` 文件导入 Tampermonkey 即可。

如果希望打包后的脚本只在指定页面生效，请在构建前设置 `USERSCRIPT_MATCH`。这个变量会直接生成 userscript 头部的 `@match`，因此必须在打包时确定：

```bash
cd userscript
USERSCRIPT_MATCH="https://example.com/comic/episode-1" pnpm build
```

多个页面或模式可使用逗号或换行分隔：

```bash
cd userscript
USERSCRIPT_MATCH="https://example.com/comic/episode-1,https://reader.example.org/chapter/*" pnpm build
```

- 未设置 `USERSCRIPT_MATCH` 时，默认保持 `*://*/*`，兼容当前“任意图片站点”模式。
- 如果只希望某个固定章节页生效，填写完整 URL；如果希望某类页面生效，填写 Tampermonkey 支持的通配模式。

## Versioning

推荐使用语义化版本（SemVer）发版，而不是每次 `build` 自动递增版本号。

```bash
cd userscript
pnpm release:patch
pnpm release:minor
pnpm release:major
```

- `patch`: 修复问题，不改兼容性，例如 `0.1.0 -> 0.1.1`
- `minor`: 向后兼容的新功能，例如 `0.1.0 -> 0.2.0`
- `major`: 不兼容变更，例如 `0.1.0 -> 1.0.0`

这些命令会先更新 [package.json](./package.json) 里的 `version`，再执行打包，因此 userscript 头部的 `@version` 会同步更新。它们不会创建线上发行版，不能单独作为交付完成的依据。

### 发布要求

Userscript 更新必须发布到本仓库的 [GitHub Releases](https://github.com/yinxy233/manga-image-translator/releases)，并上传同一构建生成的 `.user.js` 与 `.meta.js`。发布前运行 `pnpm check`，按上一版发行附件的 `@match` 范围构建，核对版本、语法及更新链接；提交源码后以相同版本标签发布，并设为 Latest。发布后下载线上附件，核对版本与 SHA-256。

- [固定安装地址](https://github.com/yinxy233/manga-image-translator/releases/latest/download/manga-image-translator-userscript.user.js)对应 `@downloadURL`。
- [固定更新检测地址](https://github.com/yinxy233/manga-image-translator/releases/latest/download/manga-image-translator-userscript.meta.js)对应 `@updateURL`。
- 旧版若从本地文件或固定版本链接安装，且没有更新地址，需要先用固定安装地址覆盖安装一次；之后可由脚本管理器检测后续发行版。

## Server Setup

### Option 1: CLI API Key

```bash
cd server
uv run python main.py --host 0.0.0.0 --port 8001 --use-gpu --api-key "replace-with-a-strong-secret" --instances 1
```

### Option 2: Environment Variable

```bash
export MT_PUBLIC_API_KEY="replace-with-a-strong-secret"
cd server
uv run python main.py --host 0.0.0.0 --port 8001 --use-gpu --instances 1
```

### Docker Example

```bash
docker run \
  --name manga_image_translator_gpu \
  -p 8001:8001 \
  --ipc=host \
  --gpus all \
  --entrypoint python \
  --rm \
  -e MT_PUBLIC_API_KEY='replace-with-a-strong-secret' \
  zyddnys/manga-image-translator:main \
  server/main.py --host=0.0.0.0 --port=8001 --use-gpu --instances=1
```

### Health Probe

```bash
curl http://127.0.0.1:8001/health
curl -H 'X-API-Key: replace-with-a-strong-secret' http://127.0.0.1:8001/queue-size
```

`/health` 返回：

```json
{
  "status": "ok",
  "version": "0.1.0",
  "queue_size": 0
}
```

## Tampermonkey Settings

脚本内置以下设置项：

- `serverBaseUrl`
- `apiKey`
- `targetLanguage`
- `translator`
- `detector`
- `detectionSize`
- `boxThreshold`
- `unclipRatio`
- `renderDirection`
- `inpainter`
- `inpaintingSize`
- `maskDilationOffset`
- `uploadTransport`
- `streamEndpoint`
- `autoTranslateEnabled`
- `fullPageTranslateEnabled`
- `cacheEnabled`
- `performanceDiagnostics`
- `maxConcurrency`
- `adapterOverrides`

推荐起始配置：

- `serverBaseUrl`: `http://127.0.0.1:8001`
- `apiKey`: 与 `--api-key` 或 `MT_PUBLIC_API_KEY` 一致
- `targetLanguage`: `CHS`
- `translator`: `ollama`
- `detector`: `default`
- `detectionSize`: `1536`
- `boxThreshold`: `0.7`
- `unclipRatio`: `2.3`
- `renderDirection`: `auto`
- `inpainter`: `default`
- `inpaintingSize`: `2048`
- `maskDilationOffset`: `30`
- `uploadTransport`: `multipart`
- `streamEndpoint`: `auto`
- `cacheEnabled`: `true`
- `performanceDiagnostics`: `false`
- `maxConcurrency`: `1`
- `adapterOverrides`: 保持默认，按站点逐个开启或关闭

这些参数会映射到服务端 `config`：

- `detector` -> `config.detector.detector`
- `detectionSize` -> `config.detector.detection_size`
- `boxThreshold` -> `config.detector.box_threshold`
- `unclipRatio` -> `config.detector.unclip_ratio`
- `renderDirection` -> `config.render.direction`
- `inpainter` -> `config.inpainter.inpainter`
- `inpaintingSize` -> `config.inpainter.inpainting_size`
- `maskDilationOffset` -> `config.mask_dilation_offset`

其中 `detectionSize` 和 `inpaintingSize` 在设置面板中使用预设下拉选项，避免手动输入异常值。

`streamEndpoint` 用于控制流式翻译接口：

- `auto`: 默认值，先读取服务能力，支持时自动使用 Web 快路径，否则走标准 `/stream`。
- `standard`: 固定走标准 `/stream` 接口，适合旧服务端。
- `web-fast`: 走 `/stream/web` 快路径；当服务端支持该能力时，通常可以更早拿到 `final_ready` 结果。

同一 GPU 默认保持一个 worker 和一个 Ollama 生成请求。只有基准证明双实例吞吐提升超过 10%、峰值 VRAM 不增加且单页 p95 不恶化时，才建议同时满足以下两点开启并发：

- userscript 的 `maxConcurrency` 大于 `1`
- 服务端通过 `--instances N` 启动了至少 `N` 个内部翻译 worker，并在基准通过后显式设置 `--recommended-client-concurrency N`

## Usage

1. 在 Tampermonkey 中安装构建产物。
2. 打开漫画站或图片页。
3. 点击右下角 `启动本页`。
4. 首屏图片会进入队列，后续懒加载图片会自动继续翻译。
5. 通过悬浮控制坞或单图状态卡进行暂停、重试、忽略、原图切换。
6. 如需站点特化规则，可在设置里的“站点适配器”分组手动启停。

## HTTPS / HTTP Compatibility

- 如果页面是 `https://`，而你的翻译服务是 `http://`，普通浏览器 `fetch` 可能被 mixed content 策略阻止。
- 翻译服务请求仍保留 `fetch` 到 `GM_xmlhttpRequest` 的兼容回退；网页原图则按同源/跨域自动选择最快路径。
- GM 请求仅在已识别为 Tampermonkey 时启用 `stream`；Safari + Stay 与未识别的管理器预先选择 `arraybuffer`，通过同一个请求读取完整的流协议响应，不会显示实时逐步进度。页面原生 `fetch` 成功时仍使用实时流。
- 即便如此，公网部署仍然强烈建议使用 HTTPS 反向代理，例如 Nginx、Caddy 或 Cloudflare Tunnel。

## Troubleshooting

- `API Key 无效或缺失`
  - 检查脚本设置里的 `apiKey` 是否与服务端一致。
- `连接成功但图片不翻译`
  - 先确认服务端是否真的能处理该语言/翻译器组合，再检查服务器日志。
- `Accepted GM translation did not expose a readable response body.`
  - 1.5.1 会对所有管理器请求 `stream`，有些管理器接受请求却无法返回可读的流或二进制对象。升级至 1.5.2 并刷新页面，让兼容格式在提交前生效。已受理的请求不会自动重新提交，避免重复翻译。
- `无法读取原始图片`
  - 脚本已尝试页面权限内的两条网络路径；目标图床仍可能要求页面 Cookie、Referer 或一次性签名。可先检查网络并手动重试，大型长图还可按提示选择“使用页面像素重试”。
- `服务器返回 401`
  - 公开接口已开启鉴权，但脚本未带上正确的 `X-API-Key`。

## Development Notes

- 油猴脚本是独立工程，不复用 `front/` 运行时。
- 浮层兼容桌面和粗指针设备；普通 `<img>/<picture>` 之外的 canvas、CSS 背景图、跨域 iframe 与 Shadow DOM 媒体不在自动发现范围内。
- 会默认缓存已完成的翻译结果；如果站点图片经常变化或你不希望复用旧结果，可以在设置里关闭缓存。
- 当前版本支持 `generic` 通用兜底适配器和站点特化适配器，内置站点包括 `mamekichimameko.blog.jp`、`manga18.club` 与 `manhwa-raw.com`。
- 新增站点适配器时，最少需要：
  - 在 `src/adapters/` 注册 `SiteAdapterDefinition`
  - 声明正文 root selectors
  - 按需覆盖 `resolveImageSource`
  - 补充 registry / imageDiscovery / settings UI 测试
