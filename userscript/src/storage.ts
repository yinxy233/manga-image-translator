import { sanitizeAdapterOverrides } from "./adapters";
import {
  DEFAULT_SETTINGS,
  DETECTOR_OPTIONS,
  INPAINTER_OPTIONS,
  LANGUAGE_OPTIONS,
  MAX_BOX_THRESHOLD,
  MAX_DETECTION_SIZE,
  MAX_INPAINTING_SIZE,
  MAX_MASK_DILATION_OFFSET,
  MAX_UNCLIP_RATIO,
  MIN_BOX_THRESHOLD,
  MIN_DETECTION_SIZE,
  MIN_INPAINTING_SIZE,
  MIN_MASK_DILATION_OFFSET,
  MIN_UNCLIP_RATIO,
  RENDER_DIRECTION_OPTIONS,
  TRANSLATOR_OPTIONS
} from "./config";
import type { LauncherPosition, UserscriptSettings } from "./types";

const SETTINGS_KEY = "mit-userscript-settings";

function readRawValue(): string | null {
  if (typeof GM_getValue === "function") {
    return GM_getValue<string | null>(SETTINGS_KEY, null);
  }
  return window.localStorage.getItem(SETTINGS_KEY);
}

function writeRawValue(value: string): void {
  if (typeof GM_setValue === "function") {
    GM_setValue(SETTINGS_KEY, value);
    return;
  }
  window.localStorage.setItem(SETTINGS_KEY, value);
}

export function sanitizeSettings(settings: Partial<UserscriptSettings>): UserscriptSettings {
  const maxConcurrency = Number.isFinite(settings.maxConcurrency)
    ? Math.min(6, Math.max(1, Number(settings.maxConcurrency)))
    : DEFAULT_SETTINGS.maxConcurrency;
  const adapterOverrides = sanitizeAdapterOverrides(settings.adapterOverrides);
  const uploadTransport =
    settings.uploadTransport === "base64-json" || settings.uploadTransport === "multipart"
      ? settings.uploadTransport
      : DEFAULT_SETTINGS.uploadTransport;
  const launcherPosition = sanitizeLauncherPosition(settings.launcherPosition);
  const languageCode = String(settings.targetLanguage ?? DEFAULT_SETTINGS.targetLanguage)
    .trim()
    .toUpperCase();
  const detectionSize = Math.round(
    clampNumber(settings.detectionSize, MIN_DETECTION_SIZE, MAX_DETECTION_SIZE, DEFAULT_SETTINGS.detectionSize)
  );
  const boxThreshold = clampNumber(
    settings.boxThreshold,
    MIN_BOX_THRESHOLD,
    MAX_BOX_THRESHOLD,
    DEFAULT_SETTINGS.boxThreshold
  );
  const unclipRatio = clampNumber(
    settings.unclipRatio,
    MIN_UNCLIP_RATIO,
    MAX_UNCLIP_RATIO,
    DEFAULT_SETTINGS.unclipRatio
  );
  const inpaintingSize = Math.round(
    clampNumber(
      settings.inpaintingSize,
      MIN_INPAINTING_SIZE,
      MAX_INPAINTING_SIZE,
      DEFAULT_SETTINGS.inpaintingSize
    )
  );
  const maskDilationOffset = Math.round(
    clampNumber(
      settings.maskDilationOffset,
      MIN_MASK_DILATION_OFFSET,
      MAX_MASK_DILATION_OFFSET,
      DEFAULT_SETTINGS.maskDilationOffset
    )
  );

  return {
    serverBaseUrl: String(settings.serverBaseUrl ?? DEFAULT_SETTINGS.serverBaseUrl).trim() || DEFAULT_SETTINGS.serverBaseUrl,
    apiKey: String(settings.apiKey ?? DEFAULT_SETTINGS.apiKey),
    targetLanguage: isOptionValue(LANGUAGE_OPTIONS, languageCode)
      ? languageCode
      : DEFAULT_SETTINGS.targetLanguage,
    translator: isOptionValue(TRANSLATOR_OPTIONS, settings.translator)
      ? settings.translator
      : DEFAULT_SETTINGS.translator,
    detector: isOptionValue(DETECTOR_OPTIONS, settings.detector)
      ? settings.detector
      : DEFAULT_SETTINGS.detector,
    detectionSize,
    boxThreshold,
    unclipRatio,
    renderDirection: isOptionValue(RENDER_DIRECTION_OPTIONS, settings.renderDirection)
      ? settings.renderDirection
      : DEFAULT_SETTINGS.renderDirection,
    inpainter: isOptionValue(INPAINTER_OPTIONS, settings.inpainter)
      ? settings.inpainter
      : DEFAULT_SETTINGS.inpainter,
    inpaintingSize,
    maskDilationOffset,
    uploadTransport,
    autoTranslateEnabled: Boolean(settings.autoTranslateEnabled ?? DEFAULT_SETTINGS.autoTranslateEnabled),
    cacheEnabled: Boolean(settings.cacheEnabled ?? DEFAULT_SETTINGS.cacheEnabled),
    maxConcurrency,
    launcherPosition,
    adapterOverrides
  };
}

export function loadSettings(): UserscriptSettings {
  try {
    const raw = readRawValue();
    if (!raw) {
      return DEFAULT_SETTINGS;
    }
    return sanitizeSettings(JSON.parse(raw) as Partial<UserscriptSettings>);
  } catch (error) {
    console.warn("[mit-userscript] Failed to load settings", error);
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: UserscriptSettings): UserscriptSettings {
  const normalized = sanitizeSettings(settings);
  writeRawValue(JSON.stringify(normalized));
  return normalized;
}

function sanitizeLauncherPosition(
  position: UserscriptSettings["launcherPosition"] | undefined
): LauncherPosition | null {
  if (!position) {
    return DEFAULT_SETTINGS.launcherPosition;
  }

  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    return DEFAULT_SETTINGS.launcherPosition;
  }

  return {
    x: Math.round(Number(position.x)),
    y: Math.round(Number(position.y))
  };
}

function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, num));
}

function isOptionValue<T extends string>(
  options: ReadonlyArray<{ value: T }>,
  value: unknown
): value is T {
  return typeof value === "string" && options.some((option) => option.value === value);
}
