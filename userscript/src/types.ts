export type TranslatorKey =
  | "youdao"
  | "baidu"
  | "deepl"
  | "papago"
  | "caiyun"
  | "sakura"
  | "offline"
  | "chatgpt"
  | "chatgpt_2stage"
  | "openai"
  | "deepseek"
  | "groq"
  | "gemini"
  | "gemini_2stage"
  | "custom_openai"
  | "nllb"
  | "nllb_big"
  | "sugoi"
  | "jparacrawl"
  | "jparacrawl_big"
  | "m2m100"
  | "m2m100_big"
  | "mbart50"
  | "qwen2"
  | "qwen2_big"
  | "original"
  | "none";

export type UploadTransport = "multipart" | "base64-json";
export type StreamEndpoint = "standard" | "web-fast";
export type DetectorKey = "default" | "dbconvnext" | "ctd" | "craft" | "paddle" | "none";
export type InpainterKey = "default" | "lama_large" | "lama_mpe" | "sd" | "none" | "original";
export type RenderDirection = "auto" | "horizontal" | "vertical";
export type AdapterOverrides = Record<string, boolean>;

export interface LauncherPosition {
  x: number;
  y: number;
}

export interface UserscriptSettings {
  serverBaseUrl: string;
  apiKey: string;
  targetLanguage: string;
  translator: TranslatorKey;
  detector: DetectorKey;
  detectionSize: number;
  boxThreshold: number;
  unclipRatio: number;
  renderDirection: RenderDirection;
  inpainter: InpainterKey;
  inpaintingSize: number;
  maskDilationOffset: number;
  uploadTransport: UploadTransport;
  streamEndpoint: StreamEndpoint;
  autoTranslateEnabled: boolean;
  fullPageTranslateEnabled: boolean;
  cacheEnabled: boolean;
  maxConcurrency: number;
  launcherPosition: LauncherPosition | null;
  adapterOverrides: AdapterOverrides;
}

export interface HealthPayload {
  status: string;
  version: string;
  queue_size: number;
}

export type SharedTaskStatus =
  | "queued"
  | "processing"
  | "complete"
  | "error"
  | "ignored"
  | "canceled";

export type ViewStatus =
  | SharedTaskStatus
  | "pending"
  | "idle";

export interface QueueStats {
  queued: number;
  running: number;
  completed: number;
  errors: number;
  ignored: number;
}

export interface OverlayViewModel {
  id: string;
  image: HTMLImageElement;
  status: ViewStatus;
  message: string;
  resultUrl: string | null;
  showOriginal: boolean;
  queuePosition: string | null;
  canRetry: boolean;
  canCancel: boolean;
  canIgnore: boolean;
}

export interface TranslationEvent {
  code: number;
  payload: Uint8Array;
  text: string;
}

export interface StreamFrame {
  code: number;
  data: Uint8Array;
}

export interface ConnectionState {
  label: string;
  tone: "neutral" | "success" | "error";
}
