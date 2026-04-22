import type { HealthPayload, TranslationEvent, UserscriptSettings } from "../types";
import { decodeFrameText, readReadableStream, StreamFrameParser } from "./stream";

type FetchImpl = typeof fetch;
type GMRequestFn = (details: GMRequestDetails<unknown>) => GMRequestHandle;

interface TransportClientOptions {
  fetchImpl?: FetchImpl;
  gmRequest?: GMRequestFn;
}

export interface TranslateImageOptions {
  imageBlob?: Blob;
  fileName?: string;
  sourceUrl?: string;
  settings: UserscriptSettings;
  onEvent: (event: TranslationEvent) => void;
  signal?: AbortSignal;
}

interface TranslationConfigPayload {
  detector: {
    detector: UserscriptSettings["detector"];
    detection_size: number;
    box_threshold: number;
    unclip_ratio: number;
  };
  render: {
    direction: UserscriptSettings["renderDirection"];
  };
  translator: {
    translator: UserscriptSettings["translator"];
    target_lang: string;
  };
  inpainter: {
    inpainter: UserscriptSettings["inpainter"];
    inpainting_size: number;
  };
  mask_dilation_offset: number;
}

interface HealthCacheEntry {
  key: string;
  payload: HealthPayload | null;
  promise: Promise<HealthPayload> | null;
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

function buildJsonHeaders(settings: UserscriptSettings): Record<string, string> {
  return {
    ...buildHeaders(settings),
    "Content-Type": "application/json"
  };
}

function buildTranslationConfigPayload(settings: UserscriptSettings): TranslationConfigPayload {
  return {
    detector: {
      detector: settings.detector,
      detection_size: settings.detectionSize,
      box_threshold: settings.boxThreshold,
      unclip_ratio: settings.unclipRatio
    },
    render: {
      direction: settings.renderDirection
    },
    translator: {
      translator: settings.translator,
      target_lang: settings.targetLanguage
    },
    inpainter: {
      inpainter: settings.inpainter,
      inpainting_size: settings.inpaintingSize
    },
    mask_dilation_offset: settings.maskDilationOffset
  };
}

function buildTranslationConfig(settings: UserscriptSettings): string {
  return JSON.stringify(buildTranslationConfigPayload(settings));
}

function createTranslationFormData(blob: Blob, fileName: string, settings: UserscriptSettings): FormData {
  const formData = new FormData();
  formData.append("image", blob, fileName);
  formData.append("config", buildTranslationConfig(settings));
  return formData;
}

function escapeMultipartHeaderValue(value: string): string {
  return value.replace(/[\r\n"]/g, "_");
}

function createMultipartBoundary(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `----mit-boundary-${crypto.randomUUID().replace(/-/g, "")}`;
  }

  return `----mit-boundary-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") {
    return blob.arrayBuffer();
  }

  return new Response(blob).arrayBuffer();
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (typeof btoa === "function") {
    let binary = "";
    const chunkSize = 0x8000;

    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, offset + chunkSize);
      for (const byte of chunk) {
        binary += String.fromCharCode(byte);
      }
    }

    return btoa(binary);
  }

  return Buffer.from(bytes).toString("base64");
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const mimeType = blob.type || "application/octet-stream";
  const base64 = arrayBufferToBase64(await blobToArrayBuffer(blob));
  return `data:${mimeType};base64,${base64}`;
}

async function createJsonTranslationPayload(
  blob: Blob,
  settings: UserscriptSettings
): Promise<string> {
  return JSON.stringify({
    image: await blobToDataUrl(blob),
    config: buildTranslationConfigPayload(settings)
  });
}

function createRemoteUrlTranslationPayload(
  sourceUrl: string,
  settings: UserscriptSettings
): string {
  return JSON.stringify({
    image: sourceUrl,
    config: buildTranslationConfigPayload(settings)
  });
}

async function createGMTranslationPayload(
  blob: Blob,
  fileName: string,
  settings: UserscriptSettings
): Promise<{ data: ArrayBuffer; headers: Record<string, string> }> {
  const boundary = createMultipartBoundary();
  const sanitizedFileName = escapeMultipartHeaderValue(fileName || "image.png");
  const encodedFileName = encodeURIComponent(fileName || "image.png");
  const config = buildTranslationConfig(settings);
  const contentType = blob.type || "application/octet-stream";
  const encoder = new TextEncoder();
  const prefix = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="image"; filename="${sanitizedFileName}"; filename*=UTF-8''${encodedFileName}\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`
  );
  const imageBytes = new Uint8Array(await blobToArrayBuffer(blob));
  const infix = encoder.encode(
    `\r\n--${boundary}\r\n` +
      'Content-Disposition: form-data; name="config"\r\n' +
      "Content-Type: application/json; charset=utf-8\r\n\r\n" +
      config
  );
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  const payload = new Uint8Array(prefix.length + imageBytes.length + infix.length + suffix.length);

  payload.set(prefix, 0);
  payload.set(imageBytes, prefix.length);
  payload.set(infix, prefix.length + imageBytes.length);
  payload.set(suffix, prefix.length + imageBytes.length + infix.length);

  return {
    data: payload.buffer,
    headers: {
      ...buildHeaders(settings),
      "Content-Type": `multipart/form-data; boundary=${boundary}`
    }
  };
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

function deriveFileName(sourceUrl: string | undefined): string {
  if (!sourceUrl) {
    return "manga-page.png";
  }

  try {
    const url = new URL(sourceUrl, window.location.href);
    const lastSegment = url.pathname.split("/").pop();
    if (lastSegment) {
      return lastSegment;
    }
  } catch {
    // noop
  }

  return "manga-page.png";
}

function isRemoteImageUrl(sourceUrl: string | undefined): sourceUrl is string {
  return typeof sourceUrl === "string" && /^https?:\/\//i.test(sourceUrl);
}

function getHealthCacheKey(settings: UserscriptSettings): string {
  return `${settings.serverBaseUrl.replace(/\/+$/, "")}|${settings.apiKey.trim()}`;
}

function shouldUseWebFastPath(health: HealthPayload | null): boolean {
  return Boolean(health?.capabilities?.web_result_fastpath);
}

function supportsRemoteUrlTranslation(health: HealthPayload | null): boolean {
  return Boolean(health?.capabilities?.source_url_translation);
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

  private readonly healthCache: HealthCacheEntry = {
    key: "",
    payload: null,
    promise: null
  };

  constructor(options: TransportClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.gmRequest = getGMRequest(options.gmRequest);
  }

  async checkHealth(settings: UserscriptSettings, signal?: AbortSignal): Promise<HealthPayload> {
    const cacheKey = getHealthCacheKey(settings);
    if (this.healthCache.key === cacheKey) {
      if (this.healthCache.payload) {
        return this.healthCache.payload;
      }
      if (this.healthCache.promise) {
        return this.healthCache.promise;
      }
    } else {
      this.healthCache.key = cacheKey;
      this.healthCache.payload = null;
      this.healthCache.promise = null;
    }

    const promise = this.fetchHealth(settings, signal)
      .then((health) => {
        this.healthCache.payload = health;
        this.healthCache.promise = null;
        return health;
      })
      .catch((error) => {
        this.healthCache.promise = null;
        throw error;
      });

    this.healthCache.promise = promise;
    return promise;
  }

  getCachedHealth(settings: UserscriptSettings): HealthPayload | null {
    return this.healthCache.key === getHealthCacheKey(settings) ? this.healthCache.payload : null;
  }

  async shouldUseRemoteUrl(settings: UserscriptSettings, sourceUrl: string | undefined): Promise<boolean> {
    if (!isRemoteImageUrl(sourceUrl)) {
      return false;
    }

    if (settings.sourceTransferMode === "blob-upload") {
      return false;
    }

    if (settings.sourceTransferMode === "remote-url") {
      return true;
    }

    const health = await this.getAvailableHealth(settings);
    return supportsRemoteUrlTranslation(health);
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

  async fetchFinalImage(
    settings: UserscriptSettings,
    folderName: string,
    signal?: AbortSignal
  ): Promise<Blob> {
    const endpoint = joinServerUrl(settings.serverBaseUrl, `/result/${encodeURIComponent(folderName)}/final.png`);

    try {
      const response = await this.fetchImpl(endpoint, {
        method: "GET",
        headers: buildHeaders(settings),
        signal
      });
      if (!response.ok) {
        throw await toHttpStatusError(response);
      }
      return await response.blob();
    } catch (error) {
      if (!shouldFallback(error)) {
        throw error;
      }
      return this.fetchBlobWithGM(endpoint, buildHeaders(settings), signal, "Failed to fetch the translated image.");
    }
  }

  async translateImage(options: TranslateImageOptions): Promise<Blob> {
    const health = await this.getAvailableHealth(options.settings);

    if (await this.shouldUseRemoteUrl(options.settings, options.sourceUrl)) {
      try {
        return await this.translateImageWithRemoteUrl(options, health);
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
      }
    }

    const imageBlob = options.imageBlob ?? (options.sourceUrl
      ? await this.fetchImageBlob(options.sourceUrl, options.signal)
      : null);
    if (!imageBlob) {
      throw new Error("Translation requires either an image blob or a remote source URL.");
    }

    const blobOptions: TranslateImageOptions = {
      ...options,
      imageBlob,
      fileName: options.fileName ?? deriveFileName(options.sourceUrl)
    };

    if (options.settings.uploadTransport === "base64-json") {
      return this.translateImageWithJsonTransport(blobOptions, health);
    }

    return this.translateImageWithMultipartTransport(blobOptions, health);
  }

  private async fetchHealth(settings: UserscriptSettings, signal?: AbortSignal): Promise<HealthPayload> {
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

  private async getAvailableHealth(settings: UserscriptSettings): Promise<HealthPayload | null> {
    const cachedHealth = this.getCachedHealth(settings);
    if (cachedHealth) {
      return cachedHealth;
    }

    try {
      return await this.checkHealth(settings);
    } catch {
      return null;
    }
  }

  private async translateImageWithRemoteUrl(
    options: TranslateImageOptions,
    health: HealthPayload | null
  ): Promise<Blob> {
    if (!isRemoteImageUrl(options.sourceUrl)) {
      throw new Error("Remote URL translation requires an HTTP(S) source URL.");
    }

    const jsonPayload = createRemoteUrlTranslationPayload(options.sourceUrl, options.settings);
    const streamPath = shouldUseWebFastPath(health)
      ? "/translate/image/stream/web"
      : "/translate/image/stream";

    return this.translateJsonPayload(options, jsonPayload, streamPath, "/translate/image");
  }

  private async translateImageWithMultipartTransport(
    options: TranslateImageOptions,
    health: HealthPayload | null
  ): Promise<Blob> {
    const streamPath = shouldUseWebFastPath(health)
      ? "/translate/with-form/image/stream/web"
      : "/translate/with-form/image/stream";

    try {
      return await this.translateImageWithFetch(options, streamPath);
    } catch (fetchError) {
      if (!shouldFallback(fetchError)) {
        throw fetchError;
      }

      try {
        return await this.translateImageWithGMStream(options, streamPath);
      } catch (gmStreamError) {
        if (!shouldFallback(gmStreamError)) {
          throw gmStreamError;
        }

        return this.translateImageWithGMBlob(options, "/translate/with-form/image");
      }
    }
  }

  private async translateImageWithJsonTransport(
    options: TranslateImageOptions,
    health: HealthPayload | null
  ): Promise<Blob> {
    if (!options.imageBlob) {
      throw new Error("JSON transport requires an image blob.");
    }

    const jsonPayload = await createJsonTranslationPayload(options.imageBlob, options.settings);
    const streamPath = shouldUseWebFastPath(health)
      ? "/translate/image/stream/web"
      : "/translate/image/stream";

    return this.translateJsonPayload(options, jsonPayload, streamPath, "/translate/image");
  }

  private async translateJsonPayload(
    options: TranslateImageOptions,
    jsonPayload: string,
    streamPath: string,
    blobPath: string
  ): Promise<Blob> {
    try {
      return await this.translateImageWithJsonFetch(options, jsonPayload, streamPath);
    } catch (fetchError) {
      if (!shouldFallback(fetchError)) {
        throw fetchError;
      }

      try {
        return await this.translateImageWithJsonGMStream(options, jsonPayload, streamPath);
      } catch (gmStreamError) {
        if (!shouldFallback(gmStreamError)) {
          throw gmStreamError;
        }

        return this.translateImageWithJsonGMBlob(options, jsonPayload, blobPath);
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
    return this.fetchBlobWithGM(imageUrl, undefined, signal, "Failed to fetch the source image.");
  }

  private async fetchBlobWithGM(
    url: string,
    headers: Record<string, string> | undefined,
    signal: AbortSignal | undefined,
    errorMessage: string
  ): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
      const request = this.gmRequest({
        method: "GET",
        url,
        headers,
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

          reject(new Error("GM request did not return a blob response."));
        },
        onerror: () => reject(new Error(errorMessage)),
        ontimeout: () => reject(new Error("Request timed out."))
      });

      signal?.addEventListener("abort", () => request.abort(), { once: true });
    });
  }

  private async translateImageWithJsonFetch(
    options: TranslateImageOptions,
    jsonPayload: string,
    path: string
  ): Promise<Blob> {
    const response = await this.fetchImpl(joinServerUrl(options.settings.serverBaseUrl, path), {
      method: "POST",
      headers: buildJsonHeaders(options.settings),
      body: jsonPayload,
      signal: options.signal
    });

    if (!response.ok) {
      throw await toHttpStatusError(response);
    }

    if (!response.body) {
      throw new Error("Translation response does not expose a readable stream.");
    }

    return parseTranslationStream(response.body, options.onEvent, options.signal);
  }

  private async translateImageWithJsonGMStream(
    options: TranslateImageOptions,
    jsonPayload: string,
    path: string
  ): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
      let streamStarted = false;

      const request = this.gmRequest({
        method: "POST",
        url: joinServerUrl(options.settings.serverBaseUrl, path),
        headers: buildJsonHeaders(options.settings),
        data: jsonPayload,
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

  private async translateImageWithJsonGMBlob(
    options: TranslateImageOptions,
    jsonPayload: string,
    path: string
  ): Promise<Blob> {
    options.onEvent({
      code: 1,
      payload: new Uint8Array(),
      text: "兼容模式：等待完整结果"
    });

    return new Promise<Blob>((resolve, reject) => {
      const request = this.gmRequest({
        method: "POST",
        url: joinServerUrl(options.settings.serverBaseUrl, path),
        headers: buildJsonHeaders(options.settings),
        data: jsonPayload,
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

  private async translateImageWithFetch(
    options: TranslateImageOptions,
    path: string
  ): Promise<Blob> {
    if (!options.imageBlob) {
      throw new Error("Multipart transport requires an image blob.");
    }

    const response = await this.fetchImpl(joinServerUrl(options.settings.serverBaseUrl, path), {
      method: "POST",
      headers: buildHeaders(options.settings),
      body: createTranslationFormData(
        options.imageBlob,
        options.fileName ?? deriveFileName(options.sourceUrl),
        options.settings
      ),
      signal: options.signal
    });

    if (!response.ok) {
      throw await toHttpStatusError(response);
    }

    if (!response.body) {
      throw new Error("Translation response does not expose a readable stream.");
    }

    return parseTranslationStream(response.body, options.onEvent, options.signal);
  }

  private async translateImageWithGMStream(
    options: TranslateImageOptions,
    path: string
  ): Promise<Blob> {
    if (!options.imageBlob) {
      throw new Error("Multipart transport requires an image blob.");
    }

    return new Promise<Blob>((resolve, reject) => {
      void (async () => {
        const multipartPayload = await createGMTranslationPayload(
          options.imageBlob as Blob,
          options.fileName ?? deriveFileName(options.sourceUrl),
          options.settings
        );
        let streamStarted = false;

        const request = this.gmRequest({
          method: "POST",
          url: joinServerUrl(options.settings.serverBaseUrl, path),
          headers: multipartPayload.headers,
          data: multipartPayload.data,
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
      })().catch(reject);
    });
  }

  private async translateImageWithGMBlob(
    options: TranslateImageOptions,
    path: string
  ): Promise<Blob> {
    if (!options.imageBlob) {
      throw new Error("Multipart transport requires an image blob.");
    }

    options.onEvent({
      code: 1,
      payload: new Uint8Array(),
      text: "兼容模式：等待完整结果"
    });

    return new Promise<Blob>((resolve, reject) => {
      void (async () => {
        const multipartPayload = await createGMTranslationPayload(
          options.imageBlob as Blob,
          options.fileName ?? deriveFileName(options.sourceUrl),
          options.settings
        );

        const request = this.gmRequest({
          method: "POST",
          url: joinServerUrl(options.settings.serverBaseUrl, path),
          headers: multipartPayload.headers,
          data: multipartPayload.data,
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
      })().catch(reject);
    });
  }
}
