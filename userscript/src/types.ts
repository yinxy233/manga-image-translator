export type TranslatorKey =
  | "youdao"
  | "baidu"
  | "deepl"
  | "papago"
  | "caiyun"
  | "sakura"
  | "offline"
  | "openai"
  | "deepseek"
  | "groq"
  | "gemini"
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
  | "none";

export type UploadTransport = "multipart" | "base64-json";

export interface UserscriptSettings {
  serverBaseUrl: string;
  apiKey: string;
  targetLanguage: string;
  translator: TranslatorKey;
  uploadTransport: UploadTransport;
  autoTranslateEnabled: boolean;
  maxConcurrency: number;
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
