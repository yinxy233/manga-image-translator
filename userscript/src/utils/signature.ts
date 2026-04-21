import type { UserscriptSettings } from "../types";

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function normalizeImageUrl(imageUrl: string): string {
  try {
    const url = new URL(imageUrl, window.location.href);
    url.hash = "";
    return url.toString();
  } catch {
    return imageUrl;
  }
}

export function buildConfigSignature(settings: UserscriptSettings): string {
  return JSON.stringify({
    serverBaseUrl: normalizeBaseUrl(settings.serverBaseUrl),
    targetLanguage: settings.targetLanguage,
    translator: settings.translator
  });
}

export function buildImageSignature(imageUrl: string, settings: UserscriptSettings): string {
  return `${normalizeImageUrl(imageUrl)}|${buildConfigSignature(settings)}`;
}
