import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "../src/config";

const mockCheckHealth = vi.fn();
const mockGetCachedHealth = vi.fn();
const mockShouldUseRemoteUrl = vi.fn();
const mockFetchFinalImage = vi.fn();
const mockQueueSetMaxConcurrency = vi.fn();
const mockRenderImages = vi.fn();

vi.mock("../src/storage", () => ({
  loadSettings: () => DEFAULT_SETTINGS,
  saveSettings: <T>(settings: T) => settings
}));

vi.mock("../src/adapters", () => ({
  buildDefaultAdapterOverrides: () => ({}),
  resolveActiveSiteAdapters: () => [],
  resolveSiteAdapterStates: () => []
}));

vi.mock("../src/cache", () => ({
  TranslationResultCache: class TranslationResultCache {
    buildKey = vi.fn();
    get = vi.fn();
    set = vi.fn();
  }
}));

vi.mock("../src/core/imageDiscovery", () => ({
  ImageDiscovery: class ImageDiscovery {
    start(): void {}
    stop(): void {}
    reset(): void {}
    rescan(): void {}
  }
}));

vi.mock("../src/core/overlayManager", () => ({
  OverlayManager: class OverlayManager {
    updateChrome = vi.fn();
    updateSettings = vi.fn();
    updateAdapterStates = vi.fn();
    renderImages = mockRenderImages;
    toast = vi.fn();
  }
}));

vi.mock("../src/core/taskQueue", () => ({
  TaskQueue: class TaskQueue {
    enqueue = vi.fn();
    pause = vi.fn();
    resume = vi.fn();
    reset = vi.fn();
    cancel = vi.fn();
    setMaxConcurrency = mockQueueSetMaxConcurrency;
  }
}));

vi.mock("../src/utils/transport", () => ({
  HttpStatusError: class HttpStatusError extends Error {
    status: number;

    body: string;

    constructor(status: number, message: string, body = "") {
      super(message);
      this.status = status;
      this.body = body;
    }
  },
  TransportClient: class TransportClient {
    checkHealth = mockCheckHealth;
    getCachedHealth = mockGetCachedHealth;
    shouldUseRemoteUrl = mockShouldUseRemoteUrl;
    fetchFinalImage = mockFetchFinalImage;
    fetchImageBlob = vi.fn();
    translateImage = vi.fn();
  }
}));

describe("TranslatorController", () => {
  beforeEach(() => {
    mockCheckHealth.mockReset();
    mockGetCachedHealth.mockReset();
    mockShouldUseRemoteUrl.mockReset();
    mockFetchFinalImage.mockReset();
    mockQueueSetMaxConcurrency.mockReset();
    mockRenderImages.mockReset();
    mockGetCachedHealth.mockReturnValue(null);
    mockShouldUseRemoteUrl.mockResolvedValue(false);
    mockFetchFinalImage.mockResolvedValue(new Blob(["translated"], { type: "image/png" }));
    mockCheckHealth.mockResolvedValue({
      status: "ok",
      version: "1.0.0",
      queue_size: 0,
      total_instances: 2
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(() => "blob:translated")
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn()
    });
  });

  it("downloads the final result once after final_ready", async () => {
    const { TranslatorController } = await import("../src/core/controller");
    const controller = new TranslatorController();
    const shared = {
      signature: "sig",
      sourceUrl: "https://cdn.example.com/page.png",
      taskId: "task",
      imageIds: new Set<string>(),
      resultUrl: null,
      status: "processing" as const,
      message: "处理中",
      queuePosition: null,
      activeTask: true,
      servedFromCache: false,
      resultFolder: null,
      finalResultFetched: false,
      finalFetchInFlight: null
    };

    (controller as unknown as {
      handleTranslationEvent: (
        sharedTask: typeof shared,
        generation: number,
        event: { code: number; payload: Uint8Array; text: string }
      ) => void;
    }).handleTranslationEvent(shared, 0, {
      code: 1,
      payload: new Uint8Array(),
      text: "final_ready:folder-a"
    });

    await shared.finalFetchInFlight;

    expect(mockFetchFinalImage).toHaveBeenCalledTimes(1);
    expect(mockFetchFinalImage).toHaveBeenCalledWith(DEFAULT_SETTINGS, "folder-a");
    expect(shared.resultFolder).toBe("folder-a");
    expect(shared.finalResultFetched).toBe(true);

    (controller as unknown as {
      handleTranslationEvent: (
        sharedTask: typeof shared,
        generation: number,
        event: { code: number; payload: Uint8Array; text: string }
      ) => void;
    }).handleTranslationEvent(shared, 0, {
      code: 1,
      payload: new Uint8Array(),
      text: "final_ready:folder-a"
    });

    expect(mockFetchFinalImage).toHaveBeenCalledTimes(1);
  });

  it("limits queue concurrency by the server instance count", async () => {
    mockCheckHealth.mockResolvedValue({
      status: "ok",
      version: "1.0.0",
      queue_size: 0,
      total_instances: 1
    });

    const { TranslatorController } = await import("../src/core/controller");
    const controller = new TranslatorController();
    mockQueueSetMaxConcurrency.mockClear();

    await (controller as unknown as { refreshServerHealth: (silent: boolean) => Promise<void> }).refreshServerHealth(
      true
    );

    expect(mockQueueSetMaxConcurrency).toHaveBeenCalledWith(1);
  });
});
