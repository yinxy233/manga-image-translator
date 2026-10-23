import { describe, expect, it, vi } from "vitest";

import {
  ImageSourceLoadError,
  ImageSourceLoader
} from "../src/core/imageSourceLoader";

function gmHandle(abort = vi.fn()): GMRequestHandle {
  return { abort };
}

describe("ImageSourceLoader", () => {
  it("uses GM before Fetch for a cross-origin source", async () => {
    const fetchImpl = vi.fn();
    const gmRequest = vi.fn((details: GMRequestDetails<unknown>) => {
      queueMicrotask(() => details.onload?.({
        status: 200,
        response: new Blob(["cross-origin"])
      }));
      return gmHandle();
    });
    const loader = new ImageSourceLoader({ fetchImpl, gmRequest });

    const result = await loader.load({
      sourceUrl: "https://images.example.net/page.webp",
      image: null
    });

    expect(result.method).toBe("gm");
    expect(gmRequest).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses Fetch before GM for a same-origin source", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Blob(["same-origin"]), {
      status: 200
    }));
    const gmRequest = vi.fn();
    const loader = new ImageSourceLoader({ fetchImpl, gmRequest });

    const result = await loader.load({
      sourceUrl: `${window.location.origin}/page.webp`,
      image: null
    });

    expect(result.method).toBe("fetch");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls as unknown[][])[0]?.[1]).toMatchObject({
      credentials: "same-origin"
    });
    expect(gmRequest).not.toHaveBeenCalled();
  });

  it("falls through to the alternate cross-origin transport", async () => {
    const callOrder: string[] = [];
    const fetchImpl = vi.fn(async () => {
      callOrder.push("fetch");
      return new Response(new Blob(["fallback"]), { status: 200 });
    });
    const gmRequest = vi.fn((details: GMRequestDetails<unknown>) => {
      callOrder.push("gm");
      queueMicrotask(() => details.onerror?.({ status: 0 }));
      return gmHandle();
    });
    const loader = new ImageSourceLoader({ fetchImpl, gmRequest });

    const result = await loader.load({
      sourceUrl: "https://cdn.example.net/page.webp",
      image: null
    });

    expect(result.method).toBe("fetch");
    expect(callOrder).toEqual(["gm", "fetch"]);
    expect((fetchImpl.mock.calls as unknown[][])[0]?.[1]).toMatchObject({ credentials: "omit" });
  });

  it("reports streamed Fetch byte progress", async () => {
    const progress = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4, 5]));
        controller.close();
      }
    });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({
        "content-length": "5",
        "content-type": "image/webp"
      }),
      body: stream
    }) as Response);
    const loader = new ImageSourceLoader({ fetchImpl, gmRequest: vi.fn() });

    const result = await loader.load({
      sourceUrl: `${window.location.origin}/page.webp`,
      image: null,
      onProgress: progress
    });

    expect(result.blob.size).toBe(5);
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({
      stage: "downloading",
      method: "fetch",
      loadedBytes: 5,
      totalBytes: 5
    }));
  });

  it("reports GM byte progress and aborts a stalled transfer before using Fetch", async () => {
    vi.useFakeTimers();
    const abort = vi.fn();
    const gmRequest = vi.fn((details: GMRequestDetails<unknown>) => {
      return gmHandle(abort);
    });
    const fetchImpl = vi.fn(async () => new Response(new Blob(["fallback"]), { status: 200 }));
    const progress = vi.fn();
    const loader = new ImageSourceLoader({
      fetchImpl,
      gmRequest,
      firstByteTimeoutMs: 50,
      idleTimeoutMs: 5,
      totalTimeoutMs: 100
    });

    const pending = loader.load({
      sourceUrl: "https://cdn.example.net/stalled.webp",
      image: null,
      onProgress: progress
    });
    const gmDetails = gmRequest.mock.calls[0]?.[0];
    gmDetails?.onprogress?.({
      status: 200,
      loaded: 4,
      total: 10,
      lengthComputable: true
    });
    await vi.advanceTimersByTimeAsync(4);
    gmDetails?.onprogress?.({
      status: 200,
      loaded: 4,
      total: 10,
      lengthComputable: true
    });
    await vi.advanceTimersByTimeAsync(2);
    const result = await pending;

    expect(abort).toHaveBeenCalledOnce();
    expect(result.method).toBe("fetch");
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({
      method: "gm",
      loadedBytes: 4,
      totalBytes: 10
    }));
    vi.useRealTimers();
  });

  it("aborts the underlying GM request when the caller cancels", async () => {
    const abort = vi.fn();
    const gmRequest = vi.fn(() => gmHandle(abort));
    const loader = new ImageSourceLoader({ fetchImpl: vi.fn(), gmRequest });
    const controller = new AbortController();

    const pending = loader.load({
      sourceUrl: "https://cdn.example.net/page.webp",
      image: null,
      signal: controller.signal
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("automatically retries a transient failure exactly once", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("network down");
    });
    const gmRequest = vi.fn((details: GMRequestDetails<unknown>) => {
      queueMicrotask(() => details.onerror?.({ status: 0 }));
      return gmHandle();
    });
    const loader = new ImageSourceLoader({
      fetchImpl,
      gmRequest,
      retryDelayMs: 0
    });

    await expect(loader.load({
      sourceUrl: `${window.location.origin}/page.webp`,
      image: null
    })).rejects.toBeInstanceOf(ImageSourceLoadError);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(gmRequest).toHaveBeenCalledTimes(2);
  });

  it("waits for the browser to come online before its final retry", async () => {
    let online = false;
    let signalRetryReady: (() => void) | null = null;
    const retryReady = new Promise<void>((resolve) => {
      signalRetryReady = resolve;
    });
    const onlineSpy = vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(new Response(new Blob(["online"]), { status: 200 }));
    const gmRequest = vi.fn((details: GMRequestDetails<unknown>) => {
      queueMicrotask(() => details.onerror?.({ status: 0 }));
      return gmHandle();
    });
    const loader = new ImageSourceLoader({ fetchImpl, gmRequest });

    const pending = loader.load({
      sourceUrl: `${window.location.origin}/page.webp`,
      image: null,
      onProgress: (progress) => {
        if (progress.stage === "retrying") {
          signalRetryReady?.();
        }
      }
    });
    await retryReady;
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    online = true;
    window.dispatchEvent(new Event("online"));
    const result = await pending;

    expect(result.method).toBe("fetch");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    onlineSpy.mockRestore();
  });

  it("enforces first-byte timeouts and aborts both bounded attempts", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      }));
    const loader = new ImageSourceLoader({
      fetchImpl,
      gmRequest: vi.fn(),
      firstByteTimeoutMs: 5,
      totalTimeoutMs: 100,
      retryDelayMs: 0
    });

    const pending = loader.load({ sourceUrl: "blob:test-source", image: null });
    const assertion = expect(pending).rejects.toBeInstanceOf(ImageSourceLoadError);
    await vi.advanceTimersByTimeAsync(20);
    await assertion;

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("requires explicit consent before copying a very large rendered image", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("blocked");
    });
    const gmRequest = vi.fn((details: GMRequestDetails<unknown>) => {
      queueMicrotask(() => details.onerror?.({ status: 0 }));
      return gmHandle();
    });
    const pixelBlob = new Blob(["pixels"], { type: "image/png" });
    const pixelExtractor = vi.fn(async () => pixelBlob);
    const image = document.createElement("img");
    image.src = "https://cdn.example.net/long.webp";
    Object.defineProperty(image, "complete", { value: true });
    Object.defineProperty(image, "naturalWidth", { value: 4000 });
    Object.defineProperty(image, "naturalHeight", { value: 4000 });
    document.body.append(image);
    const loader = new ImageSourceLoader({
      fetchImpl,
      gmRequest,
      pixelExtractor,
      retryDelayMs: 0
    });

    const denied = loader.load({
      sourceUrl: "https://cdn.example.net/long.webp",
      image
    });
    await expect(denied).rejects.toMatchObject({
      canUseLargePixelFallback: true
    });
    expect(pixelExtractor).not.toHaveBeenCalled();

    const allowed = await loader.load({
      sourceUrl: "https://cdn.example.net/long.webp",
      image,
      allowLargePixelFallback: true
    });
    expect(allowed).toEqual({ blob: pixelBlob, method: "pixels" });
    expect(pixelExtractor).toHaveBeenCalledWith(image);
  });

  it("never copies stale pixels after a lazy image changes to a new source", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("blocked");
    });
    const gmRequest = vi.fn((details: GMRequestDetails<unknown>) => {
      queueMicrotask(() => details.onerror?.({ status: 0 }));
      return gmHandle();
    });
    const pixelExtractor = vi.fn(async () => new Blob(["stale"]));
    const image = document.createElement("img");
    image.src = "https://cdn.example.net/previous.webp";
    Object.defineProperty(image, "complete", { value: true });
    Object.defineProperty(image, "naturalWidth", { value: 1200 });
    Object.defineProperty(image, "naturalHeight", { value: 1800 });
    document.body.append(image);
    const loader = new ImageSourceLoader({
      fetchImpl,
      gmRequest,
      pixelExtractor,
      retryDelayMs: 0
    });

    await expect(loader.load({
      sourceUrl: "https://cdn.example.net/next.webp",
      image
    })).rejects.toBeInstanceOf(ImageSourceLoadError);
    expect(pixelExtractor).not.toHaveBeenCalled();
  });
});
