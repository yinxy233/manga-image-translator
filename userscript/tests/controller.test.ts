import { beforeEach, describe, expect, it, vi } from "vitest";

import { getManagedImageSourceUrl } from "../src/utils/image";

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

vi.mock("../src/utils/transport", () => ({
  HttpStatusError: class extends Error {
    status = 500;
  },
  TransportClient: class {
    fetchImageBlob = vi.fn();
    translateImage = vi.fn();
    checkHealth = vi.fn();
  }
}));

vi.mock("../src/core/imageDiscovery", () => ({
  ImageDiscovery: class {
    start(): void {}

    stop(): void {}

    reset(): void {}

    rescan(): void {}
  }
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
  handleDiscoveredImage(candidate: {
    image: HTMLImageElement;
    sourceUrl: string;
    adapterId: string;
  }): void;
  imageEntries: Map<
    string,
    {
      shared: {
        sourceUrl: string;
        resultUrl: string | null;
      };
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
    document.body.innerHTML = "";
    if (typeof URL.revokeObjectURL !== "function") {
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: vi.fn()
      });
    }
  });

  it("restores the original source when runtime state is reset", () => {
    const controller = asControllerInternals(new TranslatorController());
    const image = createImage("https://example.com/original.png");

    controller.handleDiscoveredImage({
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

  it("keeps a replaced image source instead of restoring the previous original", () => {
    const controller = asControllerInternals(new TranslatorController());
    const image = createImage("https://example.com/original.png");

    controller.handleDiscoveredImage({
      image,
      sourceUrl: "https://example.com/original.png",
      adapterId: "generic"
    });

    const entry = Array.from(controller.imageEntries.values())[0];
    entry!.shared.resultUrl = "blob:https://example.com/translated";
    controller.renderImages();
    image.setAttribute("src", "https://example.com/new-page.png");

    controller.handleDiscoveredImage({
      image,
      sourceUrl: "https://example.com/new-page.png",
      adapterId: "generic"
    });

    expect(image.getAttribute("src")).toBe("https://example.com/new-page.png");
    expect(Array.from(controller.imageEntries.values())[0]?.shared.sourceUrl).toBe(
      "https://example.com/new-page.png"
    );
    expect(getManagedImageSourceUrl(image)).toBe("https://example.com/new-page.png");
  });
});
