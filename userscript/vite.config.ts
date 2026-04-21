import { defineConfig } from "vite";
import monkey from "vite-plugin-monkey";

export default defineConfig({
  plugins: [
    monkey({
      entry: "src/main.ts",
      userscript: {
        name: "Manga Image Translator Overlay",
        namespace: "https://github.com/zyddnys/manga-image-translator",
        description: "Batch translate visible manga images with a remote manga-image-translator server.",
        author: "OpenAI Codex",
        match: ["*://*/*"],
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
});
