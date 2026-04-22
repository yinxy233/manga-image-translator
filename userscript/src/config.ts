import type { TranslatorKey, UserscriptSettings } from "./types";

export const DEFAULT_SETTINGS: UserscriptSettings = {
  serverBaseUrl: "http://127.0.0.1:8000",
  apiKey: "",
  targetLanguage: "CHS",
  translator: "youdao",
  detector: "default",
  detectionSize: 1536,
  boxThreshold: 0.7,
  unclipRatio: 2.3,
  renderDirection: "auto",
  inpainter: "default",
  inpaintingSize: 2048,
  maskDilationOffset: 30,
  uploadTransport: "multipart",
  autoTranslateEnabled: false,
  cacheEnabled: true,
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
  { value: "chatgpt", label: "ChatGPT" },
  { value: "chatgpt_2stage", label: "ChatGPT 2-Stage" },
  { value: "openai", label: "OpenAI" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "groq", label: "Groq" },
  { value: "gemini", label: "Gemini" },
  { value: "gemini_2stage", label: "Gemini 2-Stage" },
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
  { value: "original", label: "Original" },
  { value: "none", label: "No Text" }
];

export const LANGUAGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "CHS", label: "简体中文" },
  { value: "CHT", label: "繁體中文" },
  { value: "CSY", label: "čeština" },
  { value: "NLD", label: "Nederlands" },
  { value: "ENG", label: "English" },
  { value: "ITA", label: "Italiano" },
  { value: "JPN", label: "日本語" },
  { value: "KOR", label: "한국어" },
  { value: "ESP", label: "español" },
  { value: "FRA", label: "français" },
  { value: "DEU", label: "Deutsch" },
  { value: "HUN", label: "magyar" },
  { value: "POL", label: "polski" },
  { value: "ROM", label: "română" },
  { value: "RUS", label: "русский" },
  { value: "PTB", label: "português" },
  { value: "TRK", label: "Türkçe" },
  { value: "UKR", label: "українська" },
  { value: "VIN", label: "Tiếng Việt" },
  { value: "ARA", label: "العربية" },
  { value: "CNR", label: "crnogorski" },
  { value: "SRP", label: "српски" },
  { value: "HRV", label: "hrvatski" },
  { value: "THA", label: "ไทย" },
  { value: "IND", label: "Bahasa Indonesia" },
  { value: "FIL", label: "Filipino" }
];

export const DETECTOR_OPTIONS: Array<{
  value: UserscriptSettings["detector"];
  label: string;
}> = [
  { value: "default", label: "Default" },
  { value: "dbconvnext", label: "DB ConvNext" },
  { value: "ctd", label: "CTD" },
  { value: "craft", label: "CRAFT" },
  { value: "paddle", label: "Paddle" },
  { value: "none", label: "None" }
];

export const RENDER_DIRECTION_OPTIONS: Array<{
  value: UserscriptSettings["renderDirection"];
  label: string;
}> = [
  { value: "auto", label: "自动" },
  { value: "horizontal", label: "横排" },
  { value: "vertical", label: "竖排" }
];

export const INPAINTER_OPTIONS: Array<{
  value: UserscriptSettings["inpainter"];
  label: string;
}> = [
  { value: "default", label: "Default" },
  { value: "lama_large", label: "Lama Large" },
  { value: "lama_mpe", label: "Lama MPE" },
  { value: "sd", label: "Stable Diffusion" },
  { value: "none", label: "None" },
  { value: "original", label: "Original" }
];

export const DETECTION_SIZE_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 1024, label: "1024" },
  { value: 1280, label: "1280" },
  { value: 1536, label: "1536（默认）" },
  { value: 1664, label: "1664" },
  { value: 1792, label: "1792" },
  { value: 2048, label: "2048" },
  { value: 2304, label: "2304" },
  { value: 2560, label: "2560" },
  { value: 3072, label: "3072" },
  { value: 3584, label: "3584" },
  { value: 4096, label: "4096" }
];

export const INPAINTING_SIZE_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 1024, label: "1024" },
  { value: 1280, label: "1280" },
  { value: 1536, label: "1536" },
  { value: 1792, label: "1792" },
  { value: 2048, label: "2048（默认）" },
  { value: 2304, label: "2304" },
  { value: 2560, label: "2560" },
  { value: 3072, label: "3072" },
  { value: 3584, label: "3584" },
  { value: 4096, label: "4096" }
];

export const TRANSPORT_OPTIONS: Array<{
  value: UserscriptSettings["uploadTransport"];
  label: string;
}> = [
  { value: "multipart", label: "表单上传（Multipart）" },
  { value: "base64-json", label: "Base64（JSON）" }
];

export const MIN_RENDER_WIDTH = 220;
export const MIN_RENDER_HEIGHT = 220;
export const MIN_NATURAL_WIDTH = 300;
export const MIN_NATURAL_HEIGHT = 300;
export const MAX_BADGE_TEXT = 32;
export const MIN_DETECTION_SIZE = 320;
export const MAX_DETECTION_SIZE = 4096;
export const MIN_INPAINTING_SIZE = 256;
export const MAX_INPAINTING_SIZE = 4096;
export const MIN_BOX_THRESHOLD = 0;
export const MAX_BOX_THRESHOLD = 1;
export const MIN_UNCLIP_RATIO = 0.5;
export const MAX_UNCLIP_RATIO = 4;
export const MIN_MASK_DILATION_OFFSET = 0;
export const MAX_MASK_DILATION_OFFSET = 80;

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
