import { beforeEach, describe, expect, it, vi } from "vitest";

import { INITIAL_AUTO_TRANSLATE_SCAN_DELAY_MS } from "../src/config";
import { getManagedImageSourceUrl } from "../src/utils/image";

const {
  mockExtractImageBlobFromElement,
  mockFetchImageBlob,
  mockTranslateImage,
  mockCheckHealth
} = vi.hoisted(() => ({
  mockExtractImageBlobFromElement: vi.fn(),
  mockFetchImageBlob: vi.fn(),
  mockTranslateImage: vi.fn(),
  mockCheckHealth: vi.fn()
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
    get = vi.fn();
    set = vi.fn();
    clear = vi.fn();
  }
}));

vi.mock("../src/utils/image", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/image")>(
    "../src/utils/image"
  );

  return {
    ...actual,
    extractImageBlobFromElement: mockExtractImageBlobFromElement
  };
});

vi.mock("../src/utils/transport", () => ({
  HttpStatusError: class extends Error {
    status = 500;
  },
  TransportClient: class {
    fetchImageBlob = mockFetchImageBlob;
    translateImage = mockTranslateImage;
    checkHealth = mockCheckHealth;
  }
}));

const { MockImageDiscovery } = vi.hoisted(() => {
  class HoistedMockImageDiscovery {
    start = vi.fn();

    stop = vi.fn();

    reset = vi.fn();

    rescan = vi.fn();
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

    enqueue(_task: unknown): void {}

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

    renderImages(): void {}

    toast(): void {}
  }
}));

import { TranslatorController } from "../src/core/controller";

interface ControllerInternals {
  discovery: InstanceType<typeof MockImageDiscovery> | null;
  discoveryReady: boolean;
  transport: {
    fetchImageBlob: typeof mockFetchImageBlob;
  };
  handleDiscoveredImage(candidate: {
    image: HTMLImageElement;
    sourceUrl: string;
    adapterId: string;
  }): void;
  prepareDiscoveredImage(candidate: {
    image: HTMLImageElement;
    sourceUrl: string;
    adapterId: string;
  }): Promise<void>;
  resolveSourceBlob(
    shared: {
      sourceUrl: string;
      sourceImage: HTMLImageElement | null;
      sourceBlob?: Blob | null;
    },
    signal?: AbortSignal
  ): Promise<Blob>;
  imageEntries: Map<
    string,
    {
      shared: {
        signature: string;
        sourceUrl: string;
        resultUrl: string | null;
      };
      sourceUrl: string;
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

describe("TranslatorController image presentation", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    mockExtractImageBlobFromElement.mockReset();
    mockFetchImageBlob.mockReset();
    mockTranslateImage.mockReset();
    mockCheckHealth.mockReset();
    mockExtractImageBlobFromElement.mockResolvedValue(new Blob(["default"], { type: "image/png" }));
    mockFetchImageBlob.mockResolvedValue(new Blob(["fallback"], { type: "image/png" }));
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

    await controller.prepareDiscoveredImage({
      image,
      sourceUrl: "https://example.com/original.png",
      adapterId: "generic"
    });

    const entry = Array.from(controller.imageEntries.values())[0];
    entry!.shared.resultUrl = "blob:https://example.com/translated";
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

    await controller.prepareDiscoveredImage({
      image,
      sourceUrl: "https://example.com/original.png",
      adapterId: "generic"
    });

    const entry = Array.from(controller.imageEntries.values())[0];
    entry!.shared.resultUrl = "blob:https://example.com/translated";
    controller.renderImages();
    image.setAttribute("src", "https://example.com/new-page.png");

    await controller.prepareDiscoveredImage({
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

    mockExtractImageBlobFromElement
      .mockResolvedValueOnce(new Blob(["first-page"], { type: "image/png" }))
      .mockResolvedValueOnce(new Blob(["second-page"], { type: "image/png" }));

    await controller.prepareDiscoveredImage({
      image: firstImage,
      sourceUrl: "https://example.com/page.png",
      adapterId: "generic"
    });
    await controller.prepareDiscoveredImage({
      image: secondImage,
      sourceUrl: "https://example.com/page.png",
      adapterId: "generic"
    });

    const entries = Array.from(controller.imageEntries.values());

    expect(controller.sharedTasks.size).toBe(2);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.shared.signature).not.toBe(entries[1]?.shared.signature);
  });

  it("delays the initial auto scan until the page load has settled", () => {
    vi.useFakeTimers();
    vi.spyOn(document, "readyState", "get").mockReturnValue("interactive");

    const controller = asControllerInternals(new TranslatorController());
    const discovery = controller.discovery;

    expect(discovery?.rescan).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("load"));
    vi.advanceTimersByTime(INITIAL_AUTO_TRANSLATE_SCAN_DELAY_MS - 1);

    expect(discovery?.rescan).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);

    expect(discovery?.reset).toHaveBeenCalledTimes(1);
    expect(discovery?.rescan).toHaveBeenCalledTimes(1);
  });

  it("prefers already rendered image pixels before falling back to network fetch", async () => {
    const expectedBlob = new Blob(["page"], { type: "image/png" });
    const controller = asControllerInternals(new TranslatorController());
    const image = createImage("https://example.com/original.png");

    mockExtractImageBlobFromElement.mockResolvedValue(expectedBlob);

    const sourceBlob = await controller.resolveSourceBlob({
      sourceUrl: "https://example.com/original.png",
      sourceImage: image
    });

    expect(sourceBlob).toBe(expectedBlob);
    expect(mockExtractImageBlobFromElement).toHaveBeenCalledWith(image);
    expect(controller.transport.fetchImageBlob).not.toHaveBeenCalled();
  });

  it("falls back to network fetch when DOM pixel extraction is unavailable", async () => {
    const expectedBlob = new Blob(["fallback"], { type: "image/png" });
    const controller = asControllerInternals(new TranslatorController());
    const image = createImage("https://example.com/original.png");

    mockExtractImageBlobFromElement.mockResolvedValue(null);
    mockFetchImageBlob.mockResolvedValue(expectedBlob);

    const sourceBlob = await controller.resolveSourceBlob({
      sourceUrl: "https://example.com/original.png",
      sourceImage: image
    });

    expect(sourceBlob).toBe(expectedBlob);
    expect(mockExtractImageBlobFromElement).toHaveBeenCalledWith(image);
    expect(controller.transport.fetchImageBlob).toHaveBeenCalledWith(
      "https://example.com/original.png",
      undefined
    );
  });

  it("does not read translated blob pixels as the next source image", async () => {
    const expectedBlob = new Blob(["fallback"], { type: "image/png" });
    const controller = asControllerInternals(new TranslatorController());
    const image = createImage("blob:https://example.com/translated");

    image.setAttribute("data-mit-managed-source-url", "https://example.com/original.png");
    mockFetchImageBlob.mockResolvedValue(expectedBlob);

    const sourceBlob = await controller.resolveSourceBlob({
      sourceUrl: "https://example.com/original.png",
      sourceImage: image
    });

    expect(sourceBlob).toBe(expectedBlob);
    expect(mockExtractImageBlobFromElement).not.toHaveBeenCalled();
    expect(controller.transport.fetchImageBlob).toHaveBeenCalledWith(
      "https://example.com/original.png",
      undefined
    );
  });
});
