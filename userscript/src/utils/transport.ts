import type { HealthPayload, TranslationEvent, UserscriptSettings } from "../types";
import { decodeFrameText, readReadableStream, StreamFrameParser } from "./stream";

type FetchImpl = typeof fetch;
type GMRequestFn = (details: GMRequestDetails<unknown>) => GMRequestHandle;

interface TransportClientOptions {
  fetchImpl?: FetchImpl;
  gmRequest?: GMRequestFn;
}

interface TranslateImageOptions {
  imageBlob: Blob;
  fileName: string;
  settings: UserscriptSettings;
  onEvent: (event: TranslationEvent) => void;
  signal?: AbortSignal;
}

export class HttpStatusError extends Error {
  readonly status: number;

  readonly body: string;

  constructor(status: number, message: string, body = "") {
    super(message);
    this.name = "HttpStatusError";
    this.status = status;
    this.body = body;
  }
}

function getGMRequest(gmRequest?: GMRequestFn): GMRequestFn {
  if (gmRequest) {
    return gmRequest;
  }
  if (typeof GM_xmlhttpRequest === "function") {
    return GM_xmlhttpRequest;
  }
  throw new Error("GM_xmlhttpRequest is unavailable in this userscript environment.");
}

function joinServerUrl(baseUrl: string, path: string): string {
  return new URL(path, `${baseUrl.replace(/\/+$/, "")}/`).toString();
}

function buildHeaders(settings: UserscriptSettings): Record<string, string> {
  if (!settings.apiKey.trim()) {
    return {};
  }
  return {
    "X-API-Key": settings.apiKey.trim()
  };
}

function buildTranslationConfig(settings: UserscriptSettings): string {
  return JSON.stringify({
    detector: {
      detector: "default",
      detection_size: 1536,
      box_threshold: 0.7,
      unclip_ratio: 2.3
    },
    render: {
      direction: "auto"
    },
    translator: {
      translator: settings.translator,
      target_lang: settings.targetLanguage
    },
    inpainter: {
      inpainter: "default",
      inpainting_size: 2048
    },
    mask_dilation_offset: 30
  });
}

function createTranslationFormData(blob: Blob, fileName: string, settings: UserscriptSettings): FormData {
  const formData = new FormData();
  formData.append("image", blob, fileName);
  formData.append("config", buildTranslationConfig(settings));
  return formData;
}

async function toHttpStatusError(response: Response): Promise<HttpStatusError> {
  const body = await response.text().catch(() => "");
  const message = body || `HTTP ${response.status}`;
  return new HttpStatusError(response.status, message, body);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function shouldFallback(error: unknown): boolean {
  if (isAbortError(error)) {
    return false;
  }
  return !(error instanceof HttpStatusError);
}

function parseHealthPayload(rawPayload: string | HealthPayload): HealthPayload {
  if (typeof rawPayload === "string") {
    return JSON.parse(rawPayload) as HealthPayload;
  }
  return rawPayload;
}

async function parseTranslationStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: TranslationEvent) => void,
  signal?: AbortSignal
): Promise<Blob> {
  const parser = new StreamFrameParser();
  let resultBlob: Blob | null = null;

  await readReadableStream(
    stream,
    (chunk) => {
      const frames = parser.push(chunk);
      for (const frame of frames) {
        if (frame.code === 0) {
          resultBlob = new Blob([Uint8Array.from(frame.data)], { type: "image/png" });
          continue;
        }

        const text = decodeFrameText(frame.data);
        if (frame.code === 2) {
          throw new Error(text || "Translation failed");
        }

        onEvent({
          code: frame.code,
          payload: frame.data,
          text
        });
      }
    },
    signal
  );

  if (!resultBlob) {
    throw new Error("Translation stream finished without returning an image.");
  }

  return resultBlob;
}

export class TransportClient {
  private readonly fetchImpl: FetchImpl;

  private readonly gmRequest: GMRequestFn;

  constructor(options: TransportClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.gmRequest = getGMRequest(options.gmRequest);
  }

  async checkHealth(settings: UserscriptSettings, signal?: AbortSignal): Promise<HealthPayload> {
    try {
      const response = await this.fetchImpl(joinServerUrl(settings.serverBaseUrl, "/health"), {
        method: "GET",
        headers: buildHeaders(settings),
        signal
      });
      if (!response.ok) {
        throw await toHttpStatusError(response);
      }
      return (await response.json()) as HealthPayload;
    } catch (error) {
      if (!shouldFallback(error)) {
        throw error;
      }
      return this.checkHealthWithGM(settings, signal);
    }
  }

  async fetchImageBlob(imageUrl: string, signal?: AbortSignal): Promise<Blob> {
    try {
      const response = await this.fetchImpl(imageUrl, {
        method: "GET",
        credentials: "include",
        signal
      });
      if (!response.ok) {
        throw await toHttpStatusError(response);
      }
      return await response.blob();
    } catch {
      return this.fetchImageBlobWithGM(imageUrl, signal);
    }
  }

  async translateImage(options: TranslateImageOptions): Promise<Blob> {
    try {
      return await this.translateImageWithFetch(options);
    } catch (fetchError) {
      if (!shouldFallback(fetchError)) {
        throw fetchError;
      }

      try {
        return await this.translateImageWithGMStream(options);
      } catch (gmStreamError) {
        if (!shouldFallback(gmStreamError)) {
          throw gmStreamError;
        }

        return this.translateImageWithGMBlob(options);
      }
    }
  }

  private async checkHealthWithGM(
    settings: UserscriptSettings,
    signal?: AbortSignal
  ): Promise<HealthPayload> {
    return new Promise<HealthPayload>((resolve, reject) => {
      const request = this.gmRequest({
        method: "GET",
        url: joinServerUrl(settings.serverBaseUrl, "/health"),
        headers: buildHeaders(settings),
        responseType: "json",
        fetch: true,
        onload: (response) => {
          if (response.status >= 400) {
            reject(new HttpStatusError(response.status, response.responseText || `HTTP ${response.status}`));
            return;
          }
          try {
            resolve(
              parseHealthPayload(
                (response.response ?? response.responseText ?? "") as string | HealthPayload
              )
            );
          } catch (error) {
            reject(error);
          }
        },
        onerror: () => reject(new Error("Failed to reach the translation server.")),
        ontimeout: () => reject(new Error("Health check timed out."))
      });

      signal?.addEventListener("abort", () => request.abort(), { once: true });
    });
  }

  private async fetchImageBlobWithGM(imageUrl: string, signal?: AbortSignal): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
      const request = this.gmRequest({
        method: "GET",
        url: imageUrl,
        responseType: "blob",
        fetch: true,
        onload: (response) => {
          if (response.status >= 400) {
            reject(new HttpStatusError(response.status, response.responseText || `HTTP ${response.status}`));
            return;
          }

          if (response.response instanceof Blob) {
            resolve(response.response);
            return;
          }

          if (response.response instanceof ArrayBuffer) {
            resolve(new Blob([response.response]));
            return;
          }

          reject(new Error("GM image request did not return a blob response."));
        },
        onerror: () => reject(new Error("Failed to fetch the source image.")),
        ontimeout: () => reject(new Error("Image download timed out."))
      });

      signal?.addEventListener("abort", () => request.abort(), { once: true });
    });
  }

  private async translateImageWithFetch(options: TranslateImageOptions): Promise<Blob> {
    const response = await this.fetchImpl(
      joinServerUrl(options.settings.serverBaseUrl, "/translate/with-form/image/stream"),
      {
        method: "POST",
        headers: buildHeaders(options.settings),
        body: createTranslationFormData(options.imageBlob, options.fileName, options.settings),
        signal: options.signal
      }
    );

    if (!response.ok) {
      throw await toHttpStatusError(response);
    }

    if (!response.body) {
      throw new Error("Translation response does not expose a readable stream.");
    }

    return parseTranslationStream(response.body, options.onEvent, options.signal);
  }

  private async translateImageWithGMStream(options: TranslateImageOptions): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
      let streamStarted = false;

      const request = this.gmRequest({
        method: "POST",
        url: joinServerUrl(options.settings.serverBaseUrl, "/translate/with-form/image/stream"),
        headers: buildHeaders(options.settings),
        data: createTranslationFormData(options.imageBlob, options.fileName, options.settings),
        responseType: "stream",
        fetch: true,
        onloadstart: async (response) => {
          streamStarted = true;

          if (response.status >= 400) {
            reject(
              new HttpStatusError(response.status, response.responseText || `HTTP ${response.status}`)
            );
            return;
          }

          if (!(response.response instanceof ReadableStream)) {
            reject(new Error("GM stream transport is unavailable in this browser."));
            return;
          }

          try {
            const blob = await parseTranslationStream(
              response.response,
              options.onEvent,
              options.signal
            );
            resolve(blob);
          } catch (error) {
            reject(error);
          }
        },
        onload: () => {
          if (!streamStarted) {
            reject(new Error("GM stream transport ended before the stream started."));
          }
        },
        onerror: () => reject(new Error("GM transport failed to reach the translation server.")),
        ontimeout: () => reject(new Error("GM transport timed out."))
      });

      options.signal?.addEventListener("abort", () => request.abort(), { once: true });
    });
  }

  private async translateImageWithGMBlob(options: TranslateImageOptions): Promise<Blob> {
    options.onEvent({
      code: 1,
      payload: new Uint8Array(),
      text: "兼容模式：等待完整结果"
    });

    return new Promise<Blob>((resolve, reject) => {
      const request = this.gmRequest({
        method: "POST",
        url: joinServerUrl(options.settings.serverBaseUrl, "/translate/with-form/image"),
        headers: buildHeaders(options.settings),
        data: createTranslationFormData(options.imageBlob, options.fileName, options.settings),
        responseType: "blob",
        fetch: true,
        onload: (response) => {
          if (response.status >= 400) {
            reject(
              new HttpStatusError(response.status, response.responseText || `HTTP ${response.status}`)
            );
            return;
          }

          if (response.response instanceof Blob) {
            resolve(response.response);
            return;
          }

          if (response.response instanceof ArrayBuffer) {
            resolve(new Blob([response.response], { type: "image/png" }));
            return;
          }

          reject(new Error("GM blob transport did not return an image response."));
        },
        onerror: () => reject(new Error("GM blob transport failed to reach the translation server.")),
        ontimeout: () => reject(new Error("GM blob transport timed out."))
      });

      options.signal?.addEventListener("abort", () => request.abort(), { once: true });
    });
  }
}
