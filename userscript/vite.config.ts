import { defineConfig, loadEnv } from "vite"
import monkey from "vite-plugin-monkey"

import { resolveUserscriptMatches, USERSCRIPT_MATCH_ENV_KEY } from "./src/userscriptMatches"

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "")
  // `pnpm build` 常通过命令行临时注入环境变量；这里优先读取 process.env，避免被仅用于 .env 文件的解析链覆盖。
  const userscriptMatchEnvValue = process.env[USERSCRIPT_MATCH_ENV_KEY] ?? env[USERSCRIPT_MATCH_ENV_KEY]

  return {
    plugins: [
      monkey({
        entry: "src/main.ts",
        userscript: {
          name: "Manga Image Translator Overlay",
          namespace: "https://github.com/zyddnys/manga-image-translator",
          description:
            "Batch translate visible manga images with a remote manga-image-translator server.",
          author: "OpenAI Codex",
          match: resolveUserscriptMatches(userscriptMatchEnvValue),
          connect: ["*"],
          grant: ["GM_getValue", "GM_setValue", "GM_xmlhttpRequest"],
          "run-at": "document-idle"
        }
      })
    ],
    test: {
      environment: "jsdom",
      include: ["tests/**/*.test.ts"]
    }
  }
})
