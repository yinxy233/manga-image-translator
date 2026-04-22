import type { TranslatorKey, UserscriptSettings } from "./types";

export const DEFAULT_SETTINGS: UserscriptSettings = {
  serverBaseUrl: "http://127.0.0.1:8000",
  apiKey: "",
  targetLanguage: "CHS",
  translator: "youdao",
  uploadTransport: "multipart",
  autoTranslateEnabled: false,
  maxConcurrency: 2,
  launcherPosition: null
};

export const TRANSLATOR_OPTIONS: Array<{ value: TranslatorKey; label: string }> = [
  { value: "youdao", label: "Youdao" },
  { value: "baidu", label: "Baidu" },
  { value: "deepl", label: "DeepL" },
  { value: "papago", label: "Papago" },
  { value: "caiyun", label: "Caiyun" },
  { value: "sakura", label: "Sakura" },
  { value: "offline", label: "Offline" },
  { value: "openai", label: "OpenAI" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "groq", label: "Groq" },
  { value: "gemini", label: "Gemini" },
  { value: "custom_openai", label: "Custom OpenAI" },
  { value: "nllb", label: "NLLB" },
  { value: "nllb_big", label: "NLLB Big" },
  { value: "sugoi", label: "Sugoi" },
  { value: "jparacrawl", label: "JParaCrawl" },
  { value: "jparacrawl_big", label: "JParaCrawl Big" },
  { value: "m2m100", label: "M2M100" },
  { value: "m2m100_big", label: "M2M100 Big" },
  { value: "mbart50", label: "mBART50" },
  { value: "qwen2", label: "Qwen2" },
  { value: "qwen2_big", label: "Qwen2 Big" },
  { value: "none", label: "No Text" }
];

export const LANGUAGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "CHS", label: "简体中文" },
  { value: "CHT", label: "繁體中文" },
  { value: "ENG", label: "English" },
  { value: "JPN", label: "日本語" },
  { value: "KOR", label: "한국어" },
  { value: "ESP", label: "español" },
  { value: "FRA", label: "français" },
  { value: "DEU", label: "Deutsch" },
  { value: "PTB", label: "português" },
  { value: "VIN", label: "Tiếng Việt" }
];

export const TRANSPORT_OPTIONS: Array<{
  value: UserscriptSettings["uploadTransport"];
  label: string;
}> = [
  { value: "multipart", label: "Multipart FormData" },
  { value: "base64-json", label: "Base64 JSON" }
];

export const MIN_RENDER_WIDTH = 220;
export const MIN_RENDER_HEIGHT = 220;
export const MIN_NATURAL_WIDTH = 300;
export const MIN_NATURAL_HEIGHT = 300;
export const MAX_BADGE_TEXT = 32;

export const PROGRESS_TEXT_MAP: Record<string, string> = {
  pending: "等待调度",
  detection: "检测文本区域",
  ocr: "识别文字",
  textline_merge: "合并文本行",
  "mask-generation": "生成去字遮罩",
  inpainting: "修复底图",
  upscaling: "超分辨率处理中",
  translating: "翻译文字",
  rendering: "重新排版译文",
  finished: "下载结果图",
  "error-upload": "上传失败",
  "error-lang": "当前翻译器不支持目标语言",
  "error-translating": "翻译服务未返回文本",
  "error-too-large": "图片尺寸过大",
  "error-disconnect": "服务器连接已断开"
};
