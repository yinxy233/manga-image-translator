/** Translator identifiers accepted by the local service configuration. */
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
  | "ollama"
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
/** Browser-to-service streaming policy, including capability negotiation. */
export type StreamEndpoint = "auto" | "standard" | "web-fast";
export type DetectorKey = "default" | "dbconvnext" | "ctd" | "craft" | "paddle" | "none";
export type InpainterKey = "default" | "lama_large" | "lama_mpe" | "sd" | "none" | "original";
export type RenderDirection = "auto" | "horizontal" | "vertical";
export type AdapterOverrides = Record<string, boolean>;

export interface LauncherPosition {
  x: number;
  y: number;
}

/** Persisted userscript settings after validation and default merging. */
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
  /** Enables lightweight timings and Long Task records; disabled by default. */
  performanceDiagnostics: boolean;
  maxConcurrency: number;
  launcherPosition: LauncherPosition | null;
  adapterOverrides: AdapterOverrides;
}

/** Backwards-compatible local service health and capability response. */
export interface HealthPayload {
  status: string;
  version: string;
  queue_size: number;
  total_instances?: number;
  free_instances?: number;
  /** Service-side safe queue concurrency for this hardware configuration. */
  recommended_client_concurrency?: number;
  /** Optional feature flags used for backwards-compatible endpoint negotiation. */
  capabilities?: {
    web_result_fastpath?: boolean;
    source_url_translation?: boolean;
    ollama_native?: boolean;
    performance_diagnostics?: boolean;
  };
  /** Native Ollama warmup/probe state, without prompt or response content. */
  ollama?: {
    status: string;
    model?: string;
    error?: string;
  };
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

/** One decoded progress or binary-result frame from the local service stream. */
export interface StreamFrame {
  code: number;
  data: Uint8Array<ArrayBuffer>;
}

export interface ConnectionState {
  label: string;
  tone: "neutral" | "success" | "error";
}
