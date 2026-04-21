# Manga Image Translator Userscript

这个目录提供一个独立的 Tampermonkey 油猴脚本工程，用于把远程部署的 `manga-image-translator` 服务接入任意漫画/图片站点。

This directory contains a standalone Tampermonkey userscript project for connecting arbitrary image-heavy sites to a remote `manga-image-translator` server.

## Features

- 手动启动当前页面翻译，之后自动追踪懒加载图片
- 结果以覆盖层方式贴在原图上，不改站点原始 DOM 结构
- 支持远程 `serverBaseUrl + apiKey`
- 优先使用浏览器 `fetch`，失败时自动回退到 `GM_xmlhttpRequest`
- 支持单图取消、重试、忽略，全局原图/译图切换

## Build

```bash
cd userscript
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

构建完成后，产物会出现在 `userscript/dist/`，将其中的 `.user.js` 文件导入 Tampermonkey 即可。

## Server Setup

### Option 1: CLI API Key

```bash
cd server
python main.py --host 0.0.0.0 --port 8000 --use-gpu --api-key "replace-with-a-strong-secret" --instances 2
```

### Option 2: Environment Variable

```bash
export MT_PUBLIC_API_KEY="replace-with-a-strong-secret"
cd server
python main.py --host 0.0.0.0 --port 8000 --use-gpu --instances 2
```

### Docker Example

```bash
docker run \
  --name manga_image_translator_gpu \
  -p 8000:8000 \
  --ipc=host \
  --gpus all \
  --entrypoint python \
  --rm \
  -e MT_PUBLIC_API_KEY='replace-with-a-strong-secret' \
  zyddnys/manga-image-translator:main \
  server/main.py --verbose --host=0.0.0.0 --port=8000 --use-gpu
```

### Health Probe

```bash
curl http://127.0.0.1:8000/health
curl -H 'X-API-Key: replace-with-a-strong-secret' http://127.0.0.1:8000/queue-size
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
- `autoTranslateEnabled`
- `maxConcurrency`

推荐起始配置：

- `serverBaseUrl`: 你的远程服务地址，例如 `https://translator.example.com`
- `apiKey`: 与 `--api-key` 或 `MT_PUBLIC_API_KEY` 一致
- `targetLanguage`: `CHS`
- `translator`: `youdao`
- `maxConcurrency`: `2`

如果你希望多张图片同时翻译，需要同时满足两点：

- userscript 的 `maxConcurrency` 大于 `1`
- 服务端通过 `--instances N` 启动了至少 `N` 个内部翻译 worker

## Usage

1. 在 Tampermonkey 中安装构建产物。
2. 打开漫画站或图片页。
3. 点击右下角 `启动本页`。
4. 首屏图片会进入队列，后续懒加载图片会自动继续翻译。
5. 通过悬浮控制坞或单图状态卡进行暂停、重试、忽略、原图切换。

## HTTPS / HTTP Compatibility

- 如果页面是 `https://`，而你的翻译服务是 `http://`，普通浏览器 `fetch` 可能被 mixed content 策略阻止。
- 脚本会优先尝试 `fetch`，失败后自动回退到 Tampermonkey 的 `GM_xmlhttpRequest`。
- 即便如此，公网部署仍然强烈建议使用 HTTPS 反向代理，例如 Nginx、Caddy 或 Cloudflare Tunnel。

## Troubleshooting

- `API Key 无效或缺失`
  - 检查脚本设置里的 `apiKey` 是否与服务端一致。
- `连接成功但图片不翻译`
  - 先确认服务端是否真的能处理该语言/翻译器组合，再检查服务器日志。
- `GM stream transport is unavailable in this browser`
  - 升级 Tampermonkey，或改用最新桌面版 Chrome / Edge / Firefox。
- `Failed to fetch the source image`
  - 目标站点可能有更严格的防盗链策略，优先尝试登录后再刷新页面。
- `服务器返回 401`
  - 公开接口已开启鉴权，但脚本未带上正确的 `X-API-Key`。

## Development Notes

- 油猴脚本是独立工程，不复用 `front/` 运行时。
- 当前版本只面向桌面 Tampermonkey，不覆盖移动端浏览器。
- 首版不做持久化结果缓存，也不做站点特化适配。
