import { DEFAULT_SETTINGS } from "./config";
import type { UserscriptSettings } from "./types";

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

  return {
    serverBaseUrl: String(settings.serverBaseUrl ?? DEFAULT_SETTINGS.serverBaseUrl).trim() || DEFAULT_SETTINGS.serverBaseUrl,
    apiKey: String(settings.apiKey ?? DEFAULT_SETTINGS.apiKey),
    targetLanguage: String(settings.targetLanguage ?? DEFAULT_SETTINGS.targetLanguage).trim() || DEFAULT_SETTINGS.targetLanguage,
    translator: (settings.translator ?? DEFAULT_SETTINGS.translator) as UserscriptSettings["translator"],
    autoTranslateEnabled: Boolean(settings.autoTranslateEnabled ?? DEFAULT_SETTINGS.autoTranslateEnabled),
    maxConcurrency
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
