import type { HealthPayload, TranslationEvent, UserscriptSettings } from "../types";
import { normalizeRenderedImageBlob } from "./image";
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

function resolveImageFetchCredentials(imageUrl: string): RequestCredentials {
  try {
    const resolvedUrl = new URL(imageUrl, window.location.href);
    if (resolvedUrl.origin === window.location.origin) {
      return "same-origin";
    }
  } catch {
    return "same-origin";
  }

  // 某些图床允许跨域匿名读取，但会拒绝带 Cookie 的脚本抓取；跨域图默认去掉凭据，避免触发 ACAO=* 与凭据模式冲突。
  return "omit";
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

async function normalizeTranslationResponseBlob(blob: Blob): Promise<Blob> {
  const normalizedBlob = await normalizeRenderedImageBlob(blob);
  if (!normalizedBlob) {
    throw new Error("Translation response did not return a valid PNG image.");
  }
  return normalizedBlob;
}

async function parseTranslationStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: TranslationEvent) => void,
  signal?: AbortSignal,
  resolveFinalReadyBlob?: (folderName: string) => Promise<Blob>
): Promise<Blob> {
  const parser = new StreamFrameParser();
  let resultBlob: Blob | null = null;
  let finalReadyFolder: string | null = null;

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

        if (frame.code === 1 && text.startsWith("final_ready:")) {
          const folderName = text.slice("final_ready:".length).trim();
          if (folderName) {
            finalReadyFolder = folderName;
          }
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

  if (finalReadyFolder && resolveFinalReadyBlob) {
    // Web 快路径的最终帧只是 1x1 占位图；收到 final_ready 后必须直接读取后端已落盘的 final.png。
    return resolveFinalReadyBlob(finalReadyFolder);
  }

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
        credentials: resolveImageFetchCredentials(imageUrl),
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
    if (options.settings.uploadTransport === "base64-json") {
      return this.translateImageWithJsonTransport(options);
    }

    return this.translateImageWithMultipartTransport(options);
  }

  private async translateImageWithMultipartTransport(options: TranslateImageOptions): Promise<Blob> {
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

  private async translateImageWithJsonTransport(options: TranslateImageOptions): Promise<Blob> {
    const jsonPayload = await createJsonTranslationPayload(options.imageBlob, options.settings);

    try {
      return await this.translateImageWithJsonFetch(options, jsonPayload);
    } catch (fetchError) {
      if (!shouldFallback(fetchError)) {
        throw fetchError;
      }

      try {
        return await this.translateImageWithJsonGMStream(options, jsonPayload);
      } catch (gmStreamError) {
        if (!shouldFallback(gmStreamError)) {
          throw gmStreamError;
        }

        return this.translateImageWithJsonGMBlob(options, jsonPayload);
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

  private async translateImageWithJsonFetch(
    options: TranslateImageOptions,
    jsonPayload: string
  ): Promise<Blob> {
    const response = await this.fetchImpl(
      joinServerUrl(options.settings.serverBaseUrl, "/translate/image/stream/web"),
      {
        method: "POST",
        headers: buildJsonHeaders(options.settings),
        body: jsonPayload,
        signal: options.signal
      }
    );

    if (!response.ok) {
      throw await toHttpStatusError(response);
    }

    if (!response.body) {
      throw new Error("Translation response does not expose a readable stream.");
    }

    return parseTranslationStream(
      response.body,
      options.onEvent,
      options.signal,
      (folderName) => this.fetchWebFastPathResultBlob(options.settings, folderName, options.signal)
    );
  }

  private async translateImageWithJsonGMStream(
    options: TranslateImageOptions,
    jsonPayload: string
  ): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
      let streamStarted = false;

      const request = this.gmRequest({
        method: "POST",
        url: joinServerUrl(options.settings.serverBaseUrl, "/translate/image/stream/web"),
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
              options.signal,
              (folderName) => this.fetchWebFastPathResultBlob(options.settings, folderName, options.signal)
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
    jsonPayload: string
  ): Promise<Blob> {
    options.onEvent({
      code: 1,
      payload: new Uint8Array(),
      text: "兼容模式：等待完整结果"
    });

    return new Promise<Blob>((resolve, reject) => {
      const request = this.gmRequest({
        method: "POST",
        url: joinServerUrl(options.settings.serverBaseUrl, "/translate/image"),
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
            void normalizeTranslationResponseBlob(response.response).then(resolve).catch(reject);
            return;
          }

          if (response.response instanceof ArrayBuffer) {
            void normalizeTranslationResponseBlob(
              new Blob([response.response], { type: "image/png" })
            ).then(resolve).catch(reject);
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

  private async translateImageWithFetch(options: TranslateImageOptions): Promise<Blob> {
    const response = await this.fetchImpl(
      joinServerUrl(options.settings.serverBaseUrl, "/translate/with-form/image/stream/web"),
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

    return parseTranslationStream(
      response.body,
      options.onEvent,
      options.signal,
      (folderName) => this.fetchWebFastPathResultBlob(options.settings, folderName, options.signal)
    );
  }

  private async translateImageWithGMStream(options: TranslateImageOptions): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
      void (async () => {
        const multipartPayload = await createGMTranslationPayload(
          options.imageBlob,
          options.fileName,
          options.settings
        );
        let streamStarted = false;

        const request = this.gmRequest({
          method: "POST",
          url: joinServerUrl(options.settings.serverBaseUrl, "/translate/with-form/image/stream/web"),
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
                options.signal,
                (folderName) => this.fetchWebFastPathResultBlob(options.settings, folderName, options.signal)
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

  private async translateImageWithGMBlob(options: TranslateImageOptions): Promise<Blob> {
    options.onEvent({
      code: 1,
      payload: new Uint8Array(),
      text: "兼容模式：等待完整结果"
    });

    return new Promise<Blob>((resolve, reject) => {
      void (async () => {
        const multipartPayload = await createGMTranslationPayload(
          options.imageBlob,
          options.fileName,
          options.settings
        );

        const request = this.gmRequest({
          method: "POST",
          url: joinServerUrl(options.settings.serverBaseUrl, "/translate/with-form/image"),
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
              void normalizeTranslationResponseBlob(response.response).then(resolve).catch(reject);
              return;
            }

            if (response.response instanceof ArrayBuffer) {
              void normalizeTranslationResponseBlob(
                new Blob([response.response], { type: "image/png" })
              ).then(resolve).catch(reject);
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

  private async fetchWebFastPathResultBlob(
    settings: UserscriptSettings,
    folderName: string,
    signal?: AbortSignal
  ): Promise<Blob> {
    try {
      const response = await this.fetchImpl(
        joinServerUrl(settings.serverBaseUrl, `/result/${encodeURIComponent(folderName)}/final.png`),
        {
          method: "GET",
          headers: buildHeaders(settings),
          signal
        }
      );

      if (!response.ok) {
        throw await toHttpStatusError(response);
      }

      const normalizedBlob = await normalizeRenderedImageBlob(await response.blob());
      if (!normalizedBlob) {
        throw new Error("Fast-path result did not return a valid PNG image.");
      }
      return normalizedBlob;
    } catch (error) {
      if (!shouldFallback(error)) {
        throw error;
      }
      return this.fetchWebFastPathResultBlobWithGM(settings, folderName, signal);
    }
  }

  private async fetchWebFastPathResultBlobWithGM(
    settings: UserscriptSettings,
    folderName: string,
    signal?: AbortSignal
  ): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
      const request = this.gmRequest({
        method: "GET",
        url: joinServerUrl(settings.serverBaseUrl, `/result/${encodeURIComponent(folderName)}/final.png`),
        headers: buildHeaders(settings),
        responseType: "blob",
        fetch: true,
        onload: (response) => {
          if (response.status >= 400) {
            reject(new HttpStatusError(response.status, response.responseText || `HTTP ${response.status}`));
            return;
          }

          if (response.response instanceof Blob) {
            void normalizeTranslationResponseBlob(response.response).then(resolve).catch(reject);
            return;
          }

          if (response.response instanceof ArrayBuffer) {
            void normalizeTranslationResponseBlob(
              new Blob([response.response], { type: "image/png" })
            ).then(resolve).catch(reject);
            return;
          }

          reject(new Error("GM fast-path result request did not return an image response."));
        },
        onerror: () => reject(new Error("GM transport failed to fetch the fast-path result image.")),
        ontimeout: () => reject(new Error("GM transport timed out while fetching the fast-path result image."))
      });

      signal?.addEventListener("abort", () => request.abort(), { once: true });
    });
  }
}
