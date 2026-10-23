import type { ImageSourceMethod, ImageSourceProgress } from "../types";
import { extractImageBlobFromElement, isImageDisplayingSource } from "../utils/image";

type FetchImpl = typeof fetch;
type GMRequestFn = (details: GMRequestDetails<unknown>) => GMRequestHandle;

/** Default first-response deadline for one source transport. */
export const IMAGE_SOURCE_FIRST_BYTE_TIMEOUT_MS = 10_000;
/** Default maximum gap between source download progress events. */
export const IMAGE_SOURCE_IDLE_TIMEOUT_MS = 15_000;
/** Default total deadline for one source transport. */
export const IMAGE_SOURCE_TOTAL_TIMEOUT_MS = 120_000;
/** Delay before the single automatic retry while the browser is online. */
export const IMAGE_SOURCE_RETRY_DELAY_MS = 1_500;
/** Largest image that may be copied to an RGBA canvas without explicit consent. */
export const IMAGE_SOURCE_AUTO_PIXEL_LIMIT = 12_000_000;

/** Request accepted by the source-loading module's single public operation. */
export interface ImageSourceLoadRequest {
  sourceUrl: string;
  image: HTMLImageElement | null;
  signal?: AbortSignal;
  allowLargePixelFallback?: boolean;
  onProgress?: (progress: ImageSourceProgress) => void;
}

/** Successful original-image read together with the transport that produced it. */
export interface ImageSourceLoadResult {
  blob: Blob;
  method: ImageSourceMethod;
}

/** Recoverable source failure metadata used to present the correct retry action. */
export class ImageSourceLoadError extends Error {
  readonly canUseLargePixelFallback: boolean;

  readonly retryable: boolean;

  constructor(
    message: string,
    options: {
      cause?: unknown;
      canUseLargePixelFallback?: boolean;
      retryable?: boolean;
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "ImageSourceLoadError";
    this.canUseLargePixelFallback = Boolean(options.canUseLargePixelFallback);
    this.retryable = options.retryable ?? true;
  }
}

interface ImageSourceLoaderOptions {
  fetchImpl?: FetchImpl;
  gmRequest?: GMRequestFn;
  pixelExtractor?: (image: HTMLImageElement) => Promise<Blob | null>;
  firstByteTimeoutMs?: number;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
  retryDelayMs?: number;
  automaticPixelLimit?: number;
  now?: () => number;
}

type NetworkMethod = "fetch" | "gm" | "direct";

class SourceHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = "SourceHttpError";
    this.status = status;
  }
}

class SourceTimeoutError extends Error {
  constructor(kind: "first-byte" | "idle" | "total") {
    const labels = {
      "first-byte": "等待首包超时",
      idle: "下载长时间没有进度",
      total: "下载超过 120 秒"
    } as const;
    super(labels[kind]);
    this.name = "SourceTimeoutError";
  }
}

function getGMRequest(gmRequest?: GMRequestFn): GMRequestFn {
  if (gmRequest) {
    return gmRequest;
  }
  if (typeof GM_xmlhttpRequest === "function") {
    return GM_xmlhttpRequest;
  }
  return () => {
    throw new Error("当前油猴环境不支持 GM_xmlhttpRequest");
  };
}

function createAbortError(): DOMException {
  return new DOMException("Request aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function resolveContentLength(headers: Headers): number | null {
  const contentLength = Number(headers.get("content-length"));
  return Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null;
}

function isLocalSource(sourceUrl: string): boolean {
  return sourceUrl.startsWith("blob:") || sourceUrl.startsWith("data:");
}

function isSameOriginSource(sourceUrl: string): boolean {
  try {
    return new URL(sourceUrl, window.location.href).origin === window.location.origin;
  } catch {
    return true;
  }
}

function isTransientSourceError(error: unknown): boolean {
  if (error instanceof SourceTimeoutError || error instanceof TypeError) {
    return true;
  }
  if (error instanceof SourceHttpError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return error instanceof Error && !isAbortError(error);
}

function formatSourceFailure(error: unknown): string {
  if (error instanceof SourceHttpError) {
    return `原图服务器返回 ${error.status}`;
  }
  if (error instanceof TypeError) {
    return "网络或跨域读取失败";
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "无法读取原始图片";
}

/**
 * Loads original compressed bytes with origin-aware fallbacks, bounded retry,
 * progress, timeouts, cancellation, and a guarded DOM-pixel escape hatch.
 */
export class ImageSourceLoader {
  private readonly fetchImpl: FetchImpl;

  private readonly gmRequest: GMRequestFn;

  private readonly pixelExtractor: (image: HTMLImageElement) => Promise<Blob | null>;

  private readonly firstByteTimeoutMs: number;

  private readonly idleTimeoutMs: number;

  private readonly totalTimeoutMs: number;

  private readonly retryDelayMs: number;

  private readonly automaticPixelLimit: number;

  private readonly now: () => number;

  constructor(options: ImageSourceLoaderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.gmRequest = getGMRequest(options.gmRequest);
    this.pixelExtractor = options.pixelExtractor ?? extractImageBlobFromElement;
    this.firstByteTimeoutMs = options.firstByteTimeoutMs ?? IMAGE_SOURCE_FIRST_BYTE_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? IMAGE_SOURCE_IDLE_TIMEOUT_MS;
    this.totalTimeoutMs = options.totalTimeoutMs ?? IMAGE_SOURCE_TOTAL_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs ?? IMAGE_SOURCE_RETRY_DELAY_MS;
    this.automaticPixelLimit = options.automaticPixelLimit ?? IMAGE_SOURCE_AUTO_PIXEL_LIMIT;
    this.now = options.now ?? (() => performance.now());
  }

  /** Read one source using the correct transport order and return reusable bytes. */
  async load(request: ImageSourceLoadRequest): Promise<ImageSourceLoadResult> {
    if (request.signal?.aborted) {
      throw createAbortError();
    }

    const startedAt = this.now();
    if (request.allowLargePixelFallback) {
      return this.loadFromPixels(
        request,
        new Error("页面像素读取失败"),
        startedAt
      );
    }
    const methods: NetworkMethod[] = isLocalSource(request.sourceUrl)
      ? ["direct"]
      : isSameOriginSource(request.sourceUrl)
        ? ["fetch", "gm"]
        : ["gm", "fetch"];
    let lastError: unknown = null;
    let retryable = false;

    for (const attempt of [1, 2] as const) {
      if (attempt === 2) {
        if (!retryable) {
          break;
        }
        await this.waitForRetry(request, startedAt);
      }

      retryable = false;
      for (const method of methods) {
        try {
          const blob = method === "gm"
            ? await this.loadWithGM(request, attempt, startedAt)
            : await this.loadWithFetch(request, attempt, startedAt, method);
          return { blob, method };
        } catch (error) {
          if (isAbortError(error) || request.signal?.aborted) {
            throw createAbortError();
          }
          lastError = error;
          retryable ||= isTransientSourceError(error);
        }
      }
    }

    return this.loadFromPixels(request, lastError, startedAt);
  }

  private emitProgress(
    request: ImageSourceLoadRequest,
    startedAt: number,
    progress: Omit<ImageSourceProgress, "elapsedMs">
  ): void {
    request.onProgress?.({
      ...progress,
      elapsedMs: Math.max(0, this.now() - startedAt)
    });
  }

  private async waitForRetry(request: ImageSourceLoadRequest, startedAt: number): Promise<void> {
    this.emitProgress(request, startedAt, {
      stage: "retrying",
      method: null,
      loadedBytes: 0,
      totalBytes: null,
      attempt: 2
    });
    if (request.signal?.aborted) {
      throw createAbortError();
    }

    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      await new Promise<void>((resolve, reject) => {
        const onOnline = (): void => {
          cleanup();
          resolve();
        };
        const onAbort = (): void => {
          cleanup();
          reject(createAbortError());
        };
        const cleanup = (): void => {
          window.removeEventListener("online", onOnline);
          request.signal?.removeEventListener("abort", onAbort);
        };
        window.addEventListener("online", onOnline, { once: true });
        request.signal?.addEventListener("abort", onAbort, { once: true });
      });
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        cleanup();
        resolve();
      }, this.retryDelayMs);
      const onAbort = (): void => {
        cleanup();
        reject(createAbortError());
      };
      const cleanup = (): void => {
        window.clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async loadWithFetch(
    request: ImageSourceLoadRequest,
    attempt: 1 | 2,
    startedAt: number,
    method: "fetch" | "direct"
  ): Promise<Blob> {
    const controller = new AbortController();
    let timeoutError: SourceTimeoutError | null = null;
    let idleTimer: number | null = null;
    const abortForTimeout = (kind: "first-byte" | "idle" | "total"): void => {
      timeoutError = new SourceTimeoutError(kind);
      controller.abort();
    };
    const firstByteTimer = window.setTimeout(
      () => abortForTimeout("first-byte"),
      this.firstByteTimeoutMs
    );
    const totalTimer = window.setTimeout(
      () => abortForTimeout("total"),
      this.totalTimeoutMs
    );
    const onAbort = (): void => controller.abort();
    request.signal?.addEventListener("abort", onAbort, { once: true });

    const resetIdleTimer = (): void => {
      if (idleTimer !== null) {
        window.clearTimeout(idleTimer);
      }
      idleTimer = window.setTimeout(() => abortForTimeout("idle"), this.idleTimeoutMs);
    };

    this.emitProgress(request, startedAt, {
      stage: "starting",
      method,
      loadedBytes: 0,
      totalBytes: null,
      attempt
    });

    try {
      const response = await this.fetchImpl(request.sourceUrl, {
        method: "GET",
        credentials: method === "direct" || isSameOriginSource(request.sourceUrl)
          ? "same-origin"
          : "omit",
        signal: controller.signal
      });
      if (!response.ok) {
        throw new SourceHttpError(response.status);
      }

      const totalBytes = resolveContentLength(response.headers);
      if (!response.body) {
        window.clearTimeout(firstByteTimer);
        const blob = await response.blob();
        this.emitProgress(request, startedAt, {
          stage: "downloading",
          method,
          loadedBytes: blob.size,
          totalBytes: totalBytes ?? blob.size,
          attempt
        });
        return blob;
      }

      const reader = response.body.getReader();
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let loadedBytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (!value) {
            continue;
          }
          if (value.byteLength === 0) {
            continue;
          }
          window.clearTimeout(firstByteTimer);
          resetIdleTimer();
          const ownedChunk = new Uint8Array(value);
          chunks.push(ownedChunk);
          loadedBytes += ownedChunk.byteLength;
          this.emitProgress(request, startedAt, {
            stage: "downloading",
            method,
            loadedBytes,
            totalBytes,
            attempt
          });
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }

      if (loadedBytes === 0) {
        window.clearTimeout(firstByteTimer);
      }
      return new Blob(chunks, {
        type: response.headers.get("content-type") ?? "application/octet-stream"
      });
    } catch (error) {
      if (timeoutError) {
        throw timeoutError;
      }
      if (request.signal?.aborted) {
        throw createAbortError();
      }
      throw error;
    } finally {
      window.clearTimeout(firstByteTimer);
      window.clearTimeout(totalTimer);
      if (idleTimer !== null) {
        window.clearTimeout(idleTimer);
      }
      request.signal?.removeEventListener("abort", onAbort);
    }
  }

  private async loadWithGM(
    request: ImageSourceLoadRequest,
    attempt: 1 | 2,
    startedAt: number
  ): Promise<Blob> {
    this.emitProgress(request, startedAt, {
      stage: "starting",
      method: "gm",
      loadedBytes: 0,
      totalBytes: null,
      attempt
    });
    if (request.signal?.aborted) {
      throw createAbortError();
    }

    return new Promise<Blob>((resolve, reject) => {
      let settled = false;
      let gmHandle: GMRequestHandle | null = null;
      let idleTimer: number | null = null;
      let lastLoadedBytes = 0;
      const firstByteTimer = window.setTimeout(
        () => fail(new SourceTimeoutError("first-byte"), true),
        this.firstByteTimeoutMs
      );
      const totalTimer = window.setTimeout(
        () => fail(new SourceTimeoutError("total"), true),
        this.totalTimeoutMs
      );

      const cleanup = (): void => {
        window.clearTimeout(firstByteTimer);
        window.clearTimeout(totalTimer);
        if (idleTimer !== null) {
          window.clearTimeout(idleTimer);
        }
        request.signal?.removeEventListener("abort", onAbort);
      };
      const succeed = (blob: Blob): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(blob);
      };
      const fail = (error: unknown, abortRequest = false): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (abortRequest) {
          gmHandle?.abort();
        }
        reject(error);
      };
      const onAbort = (): void => fail(createAbortError(), true);
      const resetIdleTimer = (): void => {
        if (idleTimer !== null) {
          window.clearTimeout(idleTimer);
        }
        idleTimer = window.setTimeout(
          () => fail(new SourceTimeoutError("idle"), true),
          this.idleTimeoutMs
        );
      };

      request.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        gmHandle = this.gmRequest({
          method: "GET",
          url: request.sourceUrl,
          responseType: "blob",
          fetch: true,
          timeout: this.totalTimeoutMs,
          onprogress: (response) => {
            if (settled) {
              return;
            }
            const loadedBytes = Number(response.loaded) || 0;
            const total = Number(response.total);
            if (loadedBytes > lastLoadedBytes) {
              lastLoadedBytes = loadedBytes;
              window.clearTimeout(firstByteTimer);
              resetIdleTimer();
            }
            this.emitProgress(request, startedAt, {
              stage: "downloading",
              method: "gm",
              loadedBytes,
              totalBytes: Number.isFinite(total) && total > 0 ? total : null,
              attempt
            });
          },
          onload: (response) => {
            if (settled) {
              return;
            }
            window.clearTimeout(firstByteTimer);
            if (response.status >= 400) {
              fail(new SourceHttpError(response.status));
              return;
            }

            const blob = response.response instanceof Blob
              ? response.response
              : response.response instanceof ArrayBuffer
                ? new Blob([response.response])
                : null;
            if (!blob) {
              fail(new Error("GM 请求没有返回可读取的图片数据"));
              return;
            }

            this.emitProgress(request, startedAt, {
              stage: "downloading",
              method: "gm",
              loadedBytes: blob.size,
              totalBytes: blob.size,
              attempt
            });
            succeed(blob);
          },
          onabort: () => fail(request.signal?.aborted ? createAbortError() : new Error("原图请求已中止")),
          onerror: () => fail(new Error("GM 请求无法读取原图")),
          ontimeout: () => fail(new SourceTimeoutError("total"))
        });
      } catch (error) {
        fail(error);
      }
    });
  }

  private async loadFromPixels(
    request: ImageSourceLoadRequest,
    networkError: unknown,
    startedAt: number
  ): Promise<ImageSourceLoadResult> {
    const image = request.image;
    const pixelCount = image ? image.naturalWidth * image.naturalHeight : 0;
    const canReadDisplayedPixels = Boolean(
      image?.isConnected &&
      image.complete &&
      pixelCount > 0 &&
      isImageDisplayingSource(image, request.sourceUrl)
    );
    if (
      canReadDisplayedPixels &&
      pixelCount > this.automaticPixelLimit &&
      !request.allowLargePixelFallback
    ) {
      throw new ImageSourceLoadError(
        `原图网络读取失败；页面图约 ${Math.ceil(pixelCount / 1_000_000)} 百万像素，改用页面像素可能占用较多内存`,
        {
          cause: networkError,
          canUseLargePixelFallback: true,
          retryable: isTransientSourceError(networkError)
        }
      );
    }

    if (image && canReadDisplayedPixels) {
      this.emitProgress(request, startedAt, {
        stage: "pixels",
        method: "pixels",
        loadedBytes: 0,
        totalBytes: null,
        attempt: 2
      });
      if (request.signal?.aborted) {
        throw createAbortError();
      }
      const blob = await this.pixelExtractor(image);
      if (request.signal?.aborted) {
        throw createAbortError();
      }
      if (blob) {
        return { blob, method: "pixels" };
      }
    }

    throw new ImageSourceLoadError(
      `${formatSourceFailure(networkError)}。可检查网络、图床防盗链或稍后手动重试。`,
      {
        cause: networkError,
        retryable: isTransientSourceError(networkError)
      }
    );
  }
}
