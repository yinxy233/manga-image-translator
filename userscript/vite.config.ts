import { defineConfig, loadEnv } from "vite"
import monkey from "vite-plugin-monkey"

import { resolveUserscriptMatches, USERSCRIPT_MATCH_ENV_KEY } from "./src/userscriptMatches"

// Keep fork identity and release URLs together so metadata cannot drift upstream.
const repositoryUrl = "https://github.com/yinxy233/manga-image-translator"
const releaseAssetBaseUrl = `${repositoryUrl}/releases/latest/download`
const userscriptFileName = "manga-image-translator-userscript.user.js"

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "")
  // `pnpm build` 常通过命令行临时注入环境变量；这里优先读取 process.env，避免被仅用于 .env 文件的解析链覆盖。
  const userscriptMatchEnvValue = process.env[USERSCRIPT_MATCH_ENV_KEY] ?? env[USERSCRIPT_MATCH_ENV_KEY]

  return {
    plugins: [
      monkey({
        entry: "src/main.ts",
        build: { fileName: userscriptFileName, metaFileName: true },
        userscript: {
          name: "Manga Image Translator Overlay",
          namespace: repositoryUrl,
          description:
            "Batch translate visible manga images with a remote manga-image-translator server.",
          author: "yinxy233",
          homepageURL: repositoryUrl,
          supportURL: `${repositoryUrl}/issues`,
          updateURL: `${releaseAssetBaseUrl}/${userscriptFileName.replace(/\.user\.js$/, ".meta.js")}`,
          downloadURL: `${releaseAssetBaseUrl}/${userscriptFileName}`,
          match: resolveUserscriptMatches(userscriptMatchEnvValue),
          connect: ["*"],
          grant: ["GM_getValue", "GM_setValue", "GM_xmlhttpRequest", "GM_info"],
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
