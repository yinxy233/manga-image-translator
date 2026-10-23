import { beforeEach, describe, expect, it, vi } from "vitest";

import { INITIAL_AUTO_TRANSLATE_SCAN_DELAY_MS } from "../src/config";
import { getManagedImageSourceUrl } from "../src/utils/image";

const {
  mockLoadSource,
  mockTranslateImage,
  mockCheckHealth,
  mockRenderImages,
  mockToast
} = vi.hoisted(() => ({
  mockLoadSource: vi.fn(),
  mockTranslateImage: vi.fn(),
  mockCheckHealth: vi.fn(),
  mockRenderImages: vi.fn(),
  mockToast: vi.fn()
}));

vi.mock("../src/storage", async () => {
  const { DEFAULT_SETTINGS } = await vi.importActual<typeof import("../src/config")>(
    "../src/config"
  );

  return {
    loadSettings: () => ({
      ...DEFAULT_SETTINGS,
      autoTranslateEnabled: true
    }),
    saveSettings: <T>(settings: T) => settings
  };
});

vi.mock("../src/cache", () => ({
  TranslationResultCache: class {
    buildKey = vi.fn();
    buildKeyFromHash = vi.fn();
    get = vi.fn();
    set = vi.fn();
    clear = vi.fn();
  }
}));

vi.mock("../src/utils/transport", () => ({
  HttpStatusError: class extends Error {
    status = 500;
  },
  TransportClient: class {
    translateImage = mockTranslateImage;
    checkHealth = mockCheckHealth;
  }
}));

vi.mock("../src/core/imageSourceLoader", async () => {
  const actual = await vi.importActual<typeof import("../src/core/imageSourceLoader")>(
    "../src/core/imageSourceLoader"
  );
  return {
    ...actual,
    ImageSourceLoader: class {
      load = mockLoadSource;
    }
  };
});

const { MockImageDiscovery } = vi.hoisted(() => {
  class HoistedMockImageDiscovery {
    start = vi.fn();

    stop = vi.fn();

    reset = vi.fn();

    rescan = vi.fn(() => ({
      inspected: 4,
      candidates: 2,
      added: 0,
      waitingForLoad: 1
    }));
  }

  return {
    MockImageDiscovery: HoistedMockImageDiscovery
  };
});

vi.mock("../src/core/imageDiscovery", () => ({
  ImageDiscovery: MockImageDiscovery
}));

vi.mock("../src/core/taskQueue", () => ({
  TaskQueue: class {
    constructor(_options: unknown) {}

    enqueue(task: { onQueued?: () => void; onStart?: () => void }): void {
      task.onQueued?.();
      task.onStart?.();
    }

    resume(): void {}

    pause(): void {}

    reset(_reason: unknown): void {}

    setMaxConcurrency(_value: number): void {}

    cancel(_id: string, _reason: unknown): void {}
  }
}));

vi.mock("../src/core/overlayManager", () => ({
  OverlayManager: class {
    updateChrome(): void {}

    updateSettings(): void {}

    updateAdapterStates(): void {}

    renderImages = mockRenderImages;

    toast = mockToast;
  }
}));

import { TranslatorController } from "../src/core/controller";

interface ControllerInternals {
  discovery: InstanceType<typeof MockImageDiscovery> | null;
  discoveryReady: boolean;
  sourceLoader: {
    load: typeof mockLoadSource;
  };
  handleDiscoveredImage(candidate: {
    image: HTMLImageElement;
    sourceUrl: string;
    adapterId: string;
    readyForPreparation: boolean;
    priority: 0 | 1 | 2;
  }): void;
  toggleSession(): void;
  translateCurrentPage(): void;
  resolveSourceBlob(
    shared: {
      sourceUrl: string;
      sourceImage: HTMLImageElement | null;
      sourceBlob?: Blob | null;
      allowLargePixelFallback?: boolean;
    },
    signal?: AbortSignal
  ): Promise<Blob>;
  imageEntries: Map<
    string,
    {
      image: HTMLImageElement;
      shared: {
        signature: string;
        sourceUrl: string;
        resultUrl: string | null;
      } | null;
      sourceUrl: string;
      preparationStage: string | null;
    }
  >;
  sharedTasks: Map<
    string,
    {
      sourceUrl: string;
    }
  >;
  renderImages(): void;
  resetRuntimeState(): void;
}

function asControllerInternals(controller: TranslatorController): ControllerInternals {
  return controller as unknown as ControllerInternals;
}

function createImage(src: string): HTMLImageElement {
  const image = document.createElement("img");
  image.setAttribute("src", src);
  Object.defineProperty(image, "currentSrc", {
    configurable: true,
    get: () => image.getAttribute("src") ?? ""
  });
  document.body.appendChild(image);
  return image;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

async function waitForAsyncDiscovery(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await waitForAsyncDiscovery();
  }
  throw new Error("Timed out waiting for async controller work.");
}

async function prepareAndRegister(
  controller: ControllerInternals,
  candidate: {
    image: HTMLImageElement;
    sourceUrl: string;
    adapterId: string;
  }
): Promise<void> {
  controller.handleDiscoveredImage({
    ...candidate,
    readyForPreparation: true,
    priority: 0
  });
  await waitForCondition(() => Array.from(controller.imageEntries.values())
    .some((entry) => entry.image === candidate.image && entry.shared !== null));
}

describe("TranslatorController image presentation", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    mockLoadSource.mockReset();
    mockTranslateImage.mockReset();
    mockCheckHealth.mockReset();
    mockRenderImages.mockReset();
    mockToast.mockReset();
    mockLoadSource.mockResolvedValue({
      blob: new Blob(["fallback"], { type: "image/png" }),
      method: "fetch"
    });
    document.body.innerHTML = "";
    if (typeof URL.revokeObjectURL !== "function") {
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: vi.fn()
      });
    }
  });

  it("restores the original source when runtime state is reset", async () => {
    const controller = asControllerInternals(new TranslatorController());
    controller.discoveryReady = true;
    const image = createImage("https://example.com/original.png");

    await prepareAndRegister(controller, {
      image,
      sourceUrl: "https://example.com/original.png",
      adapterId: "generic"
    });

    const entry = Array.from(controller.imageEntries.values())[0];
    entry!.shared!.resultUrl = "blob:https://example.com/translated";
    controller.renderImages();

    expect(image.getAttribute("src")).toBe("blob:https://example.com/translated");

    controller.resetRuntimeState();

    expect(image.getAttribute("src")).toBe("https://example.com/original.png");
    expect(getManagedImageSourceUrl(image)).toBeNull();
  });

  it("keeps a replaced image source instead of restoring the previous original", async () => {
    const controller = asControllerInternals(new TranslatorController());
    controller.discoveryReady = true;
    const image = createImage("https://example.com/original.png");
    mockLoadSource
      .mockResolvedValueOnce({
        blob: new Blob(["old-page"], { type: "image/png" }),
        method: "fetch"
      })
      .mockResolvedValueOnce({
        blob: new Blob(["new-page"], { type: "image/png" }),
        method: "fetch"
      });

    await prepareAndRegister(controller, {
      image,
      sourceUrl: "https://example.com/original.png",
      adapterId: "generic"
    });

    const entry = Array.from(controller.imageEntries.values())[0];
    entry!.shared!.resultUrl = "blob:https://example.com/translated";
    controller.renderImages();
    image.setAttribute("src", "https://example.com/new-page.png");

    await prepareAndRegister(controller, {
      image,
      sourceUrl: "https://example.com/new-page.png",
      adapterId: "generic"
    });

    expect(image.getAttribute("src")).toBe("https://example.com/new-page.png");
    expect(Array.from(controller.imageEntries.values())[0]?.sourceUrl).toBe(
      "https://example.com/new-page.png"
    );
    expect(getManagedImageSourceUrl(image)).toBe("https://example.com/new-page.png");
  });

  it("uses image content hash so the same source URL can create separate tasks", async () => {
    const controller = asControllerInternals(new TranslatorController());
    controller.discoveryReady = true;
    const firstImage = createImage("https://example.com/page.png");
    const secondImage = createImage("https://example.com/page.png");

    mockLoadSource
      .mockResolvedValueOnce({
        blob: new Blob(["first-page"], { type: "image/png" }),
        method: "fetch"
      })
      .mockResolvedValueOnce({
        blob: new Blob(["second-page"], { type: "image/png" }),
        method: "fetch"
      });

    await prepareAndRegister(controller, {
      image: firstImage,
      sourceUrl: "https://example.com/page.png",
      adapterId: "generic"
    });
    await prepareAndRegister(controller, {
      image: secondImage,
      sourceUrl: "https://example.com/page.png",
      adapterId: "generic"
    });

    const entries = Array.from(controller.imageEntries.values());

    expect(controller.sharedTasks.size).toBe(2);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.shared?.signature).not.toBe(entries[1]?.shared?.signature);
  });

  it("shows discovered tasks immediately while keeping one normal source read", async () => {
    const controller = asControllerInternals(new TranslatorController());
    controller.discoveryReady = true;
    const firstImage = createImage("https://example.com/page-1.png");
    const secondImage = createImage("https://example.com/page-2.png");
    const firstBlob = createDeferred<{ blob: Blob; method: "fetch" }>();
    const secondBlob = createDeferred<{ blob: Blob; method: "fetch" }>();

    mockLoadSource
      .mockReturnValueOnce(firstBlob.promise)
      .mockReturnValueOnce(secondBlob.promise);

    controller.handleDiscoveredImage({
      image: firstImage,
      sourceUrl: "https://example.com/page-1.png",
      adapterId: "generic",
      readyForPreparation: true,
      priority: 0
    });
    controller.handleDiscoveredImage({
      image: secondImage,
      sourceUrl: "https://example.com/page-2.png",
      adapterId: "generic",
      readyForPreparation: true,
      priority: 1
    });

    await waitForAsyncDiscovery();

    expect(controller.imageEntries.size).toBe(2);
    expect(mockRenderImages).toHaveBeenCalled();
    expect(mockLoadSource).toHaveBeenCalledTimes(1);

    firstBlob.resolve({
      blob: new Blob(["first-page"], { type: "image/png" }),
      method: "fetch"
    });
    await waitForCondition(() => mockLoadSource.mock.calls.length === 2);
    secondBlob.resolve({
      blob: new Blob(["second-page"], { type: "image/png" }),
      method: "fetch"
    });
    await waitForCondition(() => Array.from(controller.imageEntries.values())
      .every((entry) => entry.shared !== null));

    expect(Array.from(controller.imageEntries.values()).map((entry) => entry.sourceUrl)).toEqual([
      "https://example.com/page-1.png",
      "https://example.com/page-2.png"
    ]);
  });

  it("keeps repeated discovery idempotent while a source read is pending", async () => {
    const controller = asControllerInternals(new TranslatorController());
    controller.discoveryReady = true;
    const image = createImage("https://example.com/pending.png");
    const source = createDeferred<{ blob: Blob; method: "fetch" }>();
    mockLoadSource.mockReturnValueOnce(source.promise);
    const candidate = {
      image,
      sourceUrl: "https://example.com/pending.png",
      adapterId: "generic",
      readyForPreparation: true,
      priority: 0 as const
    };

    controller.handleDiscoveredImage(candidate);
    controller.handleDiscoveredImage(candidate);
    controller.handleDiscoveredImage(candidate);

    expect(controller.imageEntries.size).toBe(1);
    expect(mockLoadSource).toHaveBeenCalledTimes(1);
    source.resolve({
      blob: new Blob(["pending"], { type: "image/png" }),
      method: "fetch"
    });
    await waitForCondition(() => Array.from(controller.imageEntries.values())[0]?.shared !== null);
  });

  it("moves a newly visible image ahead of far images that have not started", async () => {
    const controller = asControllerInternals(new TranslatorController());
    controller.discoveryReady = true;
    const firstImage = createImage("https://example.com/first.png");
    const farImage = createImage("https://example.com/far.png");
    const visibleImage = createImage("https://example.com/visible.png");
    const firstSource = createDeferred<{ blob: Blob; method: "fetch" }>();
    mockLoadSource
      .mockReturnValueOnce(firstSource.promise)
      .mockResolvedValue({
        blob: new Blob(["ready"], { type: "image/png" }),
        method: "fetch"
      });
    firstImage.getBoundingClientRect = visibleImage.getBoundingClientRect = () => ({
      top: 20,
      bottom: 720,
      width: 480,
      height: 700
    }) as DOMRect;
    farImage.getBoundingClientRect = () => ({
      top: window.innerHeight * 4,
      bottom: window.innerHeight * 4 + 700,
      width: 480,
      height: 700
    }) as DOMRect;

    for (const [imageElement, sourceUrl, priority] of [
      [firstImage, "https://example.com/first.png", 0],
      [farImage, "https://example.com/far.png", 2],
      [visibleImage, "https://example.com/visible.png", 0]
    ] as const) {
      controller.handleDiscoveredImage({
        image: imageElement,
        sourceUrl,
        adapterId: "generic",
        readyForPreparation: true,
        priority
      });
    }

    firstSource.resolve({
      blob: new Blob(["first"], { type: "image/png" }),
      method: "fetch"
    });
    await waitForCondition(() => mockLoadSource.mock.calls.length >= 2);

    expect(mockLoadSource.mock.calls[1]?.[0]).toMatchObject({
      sourceUrl: "https://example.com/visible.png"
    });
    await waitForCondition(() => mockLoadSource.mock.calls.length === 3);
  });

  it("scans immediately once the DOM is interactive", () => {
    vi.useFakeTimers();
    vi.spyOn(document, "readyState", "get").mockReturnValue("interactive");

    const controller = asControllerInternals(new TranslatorController());
    const discovery = controller.discovery;

    expect(discovery?.rescan).not.toHaveBeenCalled();

    vi.advanceTimersByTime(INITIAL_AUTO_TRANSLATE_SCAN_DELAY_MS);

    expect(discovery?.reset).toHaveBeenCalledTimes(1);
    expect(discovery?.rescan).toHaveBeenCalledTimes(1);
  });

  it("reports real rescan counts instead of an unconditional success toast", () => {
    const controller = asControllerInternals(new TranslatorController());
    controller.discoveryReady = true;

    controller.translateCurrentPage();

    expect(mockToast).toHaveBeenLastCalledWith(
      "已发现 2 张，没有重复加入任务，其中 1 张仍在加载；仍在监听后续图片。",
      "neutral"
    );
  });

  it("prefers original compressed bytes over rendered image pixels", async () => {
    const expectedBlob = new Blob(["page"], { type: "image/png" });
    const controller = asControllerInternals(new TranslatorController());
    const image = createImage("https://example.com/original.png");

    mockLoadSource.mockResolvedValue({ blob: expectedBlob, method: "fetch" });

    const sourceBlob = await controller.resolveSourceBlob({
      sourceUrl: "https://example.com/original.png",
      sourceImage: image
    });

    expect(sourceBlob).toBe(expectedBlob);
    expect(controller.sourceLoader.load).toHaveBeenCalledWith(expect.objectContaining({
      sourceUrl: "https://example.com/original.png",
      image
    }));
  });

  it("passes explicit large-pixel consent to the source loader", async () => {
    const expectedBlob = new Blob(["canvas-fallback"], { type: "image/png" });
    const controller = asControllerInternals(new TranslatorController());
    const image = createImage("https://example.com/original.png");

    mockLoadSource.mockResolvedValue({ blob: expectedBlob, method: "pixels" });

    const sourceBlob = await controller.resolveSourceBlob({
      sourceUrl: "https://example.com/original.png",
      sourceImage: image,
      allowLargePixelFallback: true
    });

    expect(sourceBlob).toBe(expectedBlob);
    expect(controller.sourceLoader.load).toHaveBeenCalledWith(expect.objectContaining({
      allowLargePixelFallback: true
    }));
  });

  it("does not read translated blob pixels as the next source image", async () => {
    const expectedBlob = new Blob(["fallback"], { type: "image/png" });
    const controller = asControllerInternals(new TranslatorController());
    const image = createImage("blob:https://example.com/translated");

    image.setAttribute("data-mit-managed-source-url", "https://example.com/original.png");
    mockLoadSource.mockResolvedValue({ blob: expectedBlob, method: "fetch" });

    const sourceBlob = await controller.resolveSourceBlob({
      sourceUrl: "https://example.com/original.png",
      sourceImage: image
    });

    expect(sourceBlob).toBe(expectedBlob);
    expect(controller.sourceLoader.load).toHaveBeenCalledWith(expect.objectContaining({
      sourceUrl: "https://example.com/original.png",
      image: null
    }));
  });

  it("aborts an obsolete source read when the same element changes source", async () => {
    const controller = asControllerInternals(new TranslatorController());
    controller.discoveryReady = true;
    const image = createImage("https://example.com/first.png");
    mockLoadSource
      .mockImplementationOnce((request: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        }))
      .mockResolvedValueOnce({
        blob: new Blob(["second"], { type: "image/png" }),
        method: "fetch"
      });

    controller.handleDiscoveredImage({
      image,
      sourceUrl: "https://example.com/first.png",
      adapterId: "generic",
      readyForPreparation: true,
      priority: 0
    });
    const firstSignal = mockLoadSource.mock.calls[0]?.[0]?.signal as AbortSignal;
    image.setAttribute("src", "https://example.com/second.png");
    controller.handleDiscoveredImage({
      image,
      sourceUrl: "https://example.com/second.png",
      adapterId: "generic",
      readyForPreparation: true,
      priority: 0
    });

    await waitForCondition(() => mockLoadSource.mock.calls.length === 2);
    expect(firstSignal.aborted).toBe(true);
    expect(Array.from(controller.imageEntries.values())[0]?.sourceUrl).toBe(
      "https://example.com/second.png"
    );
  });

  it("lets a visible image bypass a source read stalled for three seconds", async () => {
    vi.useFakeTimers();
    const controller = asControllerInternals(new TranslatorController());
    controller.discoveryReady = true;
    const firstImage = createImage("https://example.com/stalled.png");
    const secondImage = createImage("https://example.com/visible.png");
    const firstResult = createDeferred<{ blob: Blob; method: "fetch" }>();
    mockLoadSource
      .mockReturnValueOnce(firstResult.promise)
      .mockResolvedValueOnce({
        blob: new Blob(["visible"], { type: "image/png" }),
        method: "fetch"
      });

    for (const [imageElement, sourceUrl] of [
      [firstImage, "https://example.com/stalled.png"],
      [secondImage, "https://example.com/visible.png"]
    ] as const) {
      imageElement.getBoundingClientRect = () => ({
        top: 10,
        bottom: 700,
        width: 500,
        height: 690
      }) as DOMRect;
      controller.handleDiscoveredImage({
        image: imageElement,
        sourceUrl,
        adapterId: "generic",
        readyForPreparation: true,
        priority: 0
      });
    }

    expect(mockLoadSource).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(mockLoadSource).toHaveBeenCalledTimes(2);

    firstResult.resolve({
      blob: new Blob(["stalled"], { type: "image/png" }),
      method: "fetch"
    });
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  });

  it("pause aborts source reads and resume restarts preparation", async () => {
    const controller = asControllerInternals(new TranslatorController());
    controller.discoveryReady = true;
    const image = createImage("https://example.com/page.png");
    mockLoadSource
      .mockImplementationOnce((request: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        }))
      .mockResolvedValueOnce({
        blob: new Blob(["resumed"], { type: "image/png" }),
        method: "fetch"
      });

    controller.handleDiscoveredImage({
      image,
      sourceUrl: "https://example.com/page.png",
      adapterId: "generic",
      readyForPreparation: true,
      priority: 0
    });
    const firstSignal = mockLoadSource.mock.calls[0]?.[0]?.signal as AbortSignal;
    controller.toggleSession();
    expect(firstSignal.aborted).toBe(true);
    expect(Array.from(controller.imageEntries.values())[0]?.preparationStage).toBe("discovered");

    controller.toggleSession();
    await waitForCondition(() =>
      mockLoadSource.mock.calls.length === 2 &&
      Array.from(controller.imageEntries.values())[0]?.shared !== null
    );
  });
});
