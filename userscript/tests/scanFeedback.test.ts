import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "../src/config";
import { TranslatorController } from "../src/core/controller";
import type { ImageSourceLoadRequest } from "../src/core/imageSourceLoader";
import type { OverlayManagerCallbacks } from "../src/core/overlayManager";
import { saveSettings } from "../src/storage";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  render: vi.fn(),
  toast: vi.fn(),
  actions: null as OverlayManagerCallbacks | null
}));

// Keep discovery, persisted settings and the queue real. Only external I/O and
// the final DOM renderer are replaced so the click-to-discovery seam is tested.
vi.mock("../src/cache", () => ({ TranslationResultCache: class {} }));
vi.mock("../src/utils/transport", () => ({
  HttpStatusError: class extends Error {},
  TransportClient: class {}
}));
vi.mock("../src/core/imageSourceLoader", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/core/imageSourceLoader")>(),
  ImageSourceLoader: class { load = mocks.load; }
}));
vi.mock("../src/core/overlayManager", () => ({
  OverlayManager: class {
    /** Capture the same action callbacks used by the real translate button. */
    constructor(_settings: unknown, _adapters: unknown, actions: OverlayManagerCallbacks) {
      mocks.actions = actions;
    }
    /** Chrome updates are outside this image feedback assertion. */
    updateChrome(): void {}
    renderImages = mocks.render;
    toast = mocks.toast;
  }
}));

/** Minimal observer for eager scans; no browser intersection events are needed. */
class IntersectionObserverStub {
  /** Accept a target without manufacturing a visibility event. */
  observe(): void {}
  /** Forget a target during teardown. */
  unobserve(): void {}
  /** Release the synthetic observer. */
  disconnect(): void {}
}

/** Cleanup-only view of runtime resources; tests drive the public UI callbacks. */
interface RuntimeCleanup {
  discovery: { stop(): void };
  resetRuntimeState(): void;
}

/** Create a loaded, eligible image without making an actual image request. */
function appendImage(index: number): HTMLImageElement {
  const image = document.createElement("img");
  image.src = `https://images.example.test/page-${index}.png`;
  Object.defineProperties(image, {
    complete: { value: true },
    naturalWidth: { value: 800 },
    naturalHeight: { value: 1200 }
  });
  image.getBoundingClientRect = vi.fn(() => ({
    top: 10, bottom: 910, width: 600, height: 900
  }) as DOMRect);
  document.body.append(image);
  return image;
}

describe("translate button scan feedback", () => {
  let controller: RuntimeCleanup | null = null;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("IntersectionObserver", IntersectionObserverStub);
    document.body.innerHTML = "";
    window.localStorage.clear();
    saveSettings({
      ...DEFAULT_SETTINGS,
      autoTranslateEnabled: false,
      fullPageTranslateEnabled: true,
      streamEndpoint: "standard"
    });
    mocks.load.mockReset();
    mocks.render.mockClear();
    mocks.toast.mockClear();
    mocks.actions = null;
    // Every source remains pending until teardown, making feedback independent
    // of host latency, image hashing, cache access and translation completion.
    mocks.load.mockImplementation((request: ImageSourceLoadRequest) => new Promise((_resolve, reject) => {
      request.onProgress?.({
        stage: "starting", method: "gm", loadedBytes: 0,
        totalBytes: null, attempt: 1, elapsedMs: 0
      });
      request.signal?.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    }));
  });

  afterEach(async () => {
    controller?.discovery.stop();
    controller?.resetRuntimeState();
    controller = null;
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows all discovered images in one update before any download completes", async () => {
    const images = Array.from({ length: 120 }, (_, index) => appendImage(index));
    controller = new TranslatorController() as unknown as RuntimeCleanup;
    mocks.render.mockClear();
    for (const image of images) {
      vi.mocked(image.getBoundingClientRect).mockClear();
    }

    mocks.actions!.onTranslateNow();
    await Promise.resolve();

    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(mocks.render).toHaveBeenCalledTimes(1);
    expect(mocks.render.mock.calls[0]?.[0]).toHaveLength(120);
    expect(mocks.toast).toHaveBeenLastCalledWith(expect.stringContaining("已发现 120 张"), "neutral");
    // Allow a few geometry reads per image, but catch rescanning the growing
    // pending queue on every candidate (quadratic work on long chapters).
    const geometryReads = images.reduce((count, image) =>
      count + vi.mocked(image.getBoundingClientRect).mock.calls.length, 0);
    expect(geometryReads).toBeLessThan(images.length * 8);

    // Repeated clicks must update feedback without duplicate downloads or cards.
    mocks.render.mockClear();
    mocks.actions!.onTranslateNow();
    await Promise.resolve();
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenLastCalledWith(expect.stringContaining("没有重复加入任务"), "neutral");
  });

  it("lets visible images bypass a stalled download without exceeding two reads", async () => {
    for (let index = 0; index < 3; index += 1) {
      appendImage(index);
    }
    controller = new TranslatorController() as unknown as RuntimeCleanup;
    mocks.actions!.onTranslateNow();
    await Promise.resolve();

    expect(mocks.render.mock.lastCall?.[0]).toHaveLength(3);
    expect(mocks.load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(mocks.load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(mocks.load).toHaveBeenCalledTimes(2);
  });

  it("recognizes fresh byte progress after falling back to another transport", async () => {
    appendImage(0);
    appendImage(1);
    controller = new TranslatorController() as unknown as RuntimeCleanup;
    mocks.actions!.onTranslateNow();
    const request = mocks.load.mock.calls[0]?.[0] as ImageSourceLoadRequest;
    request.onProgress?.({
      stage: "downloading", method: "gm", loadedBytes: 100,
      totalBytes: 1000, attempt: 1, elapsedMs: 0
    });
    await vi.advanceTimersByTimeAsync(2_500);
    // A fallback restarts the byte counter. A smaller count still represents
    // real progress and must prevent an unnecessary parallel long-image read.
    request.onProgress?.({
      stage: "starting", method: "fetch", loadedBytes: 0,
      totalBytes: null, attempt: 1, elapsedMs: 2_500
    });
    request.onProgress?.({
      stage: "downloading", method: "fetch", loadedBytes: 1,
      totalBytes: 1000, attempt: 1, elapsedMs: 2_500
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.load).toHaveBeenCalledTimes(2);
  });
});
