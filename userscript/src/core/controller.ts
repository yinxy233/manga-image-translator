import { resolveActiveSiteAdapters, resolveSiteAdapterStates } from "../adapters";
import type { SiteAdapterDefinition, SiteAdapterState } from "../adapters/types";
import { INITIAL_AUTO_TRANSLATE_SCAN_DELAY_MS, PROGRESS_TEXT_MAP } from "../config";
import { TranslationResultCache } from "../cache";
import { loadSettings, saveSettings } from "../storage";
import type {
  ConnectionState,
  LauncherPosition,
  OverlayViewModel,
  QueueStats,
  SharedTaskStatus,
  TranslationEvent,
  UserscriptSettings
} from "../types";
import { extractImageBlobFromElement } from "../utils/image";
import { buildImageSignature } from "../utils/signature";
import { HttpStatusError, TransportClient } from "../utils/transport";
import { type DiscoveredImageCandidate, ImageDiscovery } from "./imageDiscovery";
import {
  createImagePresentationState,
  refreshImagePresentationState,
  releaseImagePresentation,
  syncImagePresentation,
  type ImagePresentationState
} from "./imagePresentation";
import { OverlayManager } from "./overlayManager";
import { type CancelReason, TaskQueue } from "./taskQueue";

interface SharedImageTask {
  signature: string;
  sourceUrl: string;
  sourceImage: HTMLImageElement | null;
  taskId: string;
  imageIds: Set<string>;
  resultUrl: string | null;
  status: SharedTaskStatus;
  message: string;
  queuePosition: string | null;
  activeTask: boolean;
  servedFromCache: boolean;
}

interface ImageEntry {
  id: string;
  image: HTMLImageElement;
  shared: SharedImageTask;
  presentation: ImagePresentationState;
  showOriginal: boolean;
  ignored: boolean;
  canceled: boolean;
}

function createConnectionState(
  label: string,
  tone: ConnectionState["tone"] = "neutral"
): ConnectionState {
  return { label, tone };
}

function createQueueStats(): QueueStats {
  return {
    queued: 0,
    running: 0,
    completed: 0,
    errors: 0,
    ignored: 0
  };
}

function isRenderableEvent(event: TranslationEvent): boolean {
  return !event.text.startsWith("rendering_folder:") && !event.text.startsWith("final_ready:");
}

function deriveProgressMessage(event: TranslationEvent): string {
  if (!event.text) {
    return "处理中";
  }
  return PROGRESS_TEXT_MAP[event.text] ?? event.text;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function deriveFileName(sourceUrl: string): string {
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

export class TranslatorController {
  private readonly transport: TransportClient;

  private readonly resultCache: TranslationResultCache;

  private discovery: ImageDiscovery | null = null;

  private readonly overlay: OverlayManager;

  private readonly queue: TaskQueue;

  private settings = loadSettings();

  private enabled = this.settings.autoTranslateEnabled;

  private discoveryReady = !this.enabled;

  private globalShowOriginal = false;

  private connection = createConnectionState("尚未连接服务器");

  private queueStats = createQueueStats();

  private imageSequence = 0;

  private generation = 0;

  private imageIds = new WeakMap<HTMLImageElement, string>();

  private readonly imageEntries = new Map<string, ImageEntry>();

  private readonly sharedTasks = new Map<string, SharedImageTask>();

  private adapterStates: SiteAdapterState[] = [];

  private adapterDomTweaksCleanup: (() => void) | null = null;

  private waitingForInitialAutoScanLoad = false;

  private initialAutoScanTimer: number | null = null;

  constructor() {
    this.transport = new TransportClient();
    this.resultCache = new TranslationResultCache();
    this.refreshAdapterState();

    this.queue = new TaskQueue({
      maxConcurrency: this.settings.maxConcurrency,
      paused: !this.enabled,
      onStatsChange: (stats) => {
        this.queueStats = stats;
        this.renderChrome();
      }
    });

    this.overlay = new OverlayManager(this.settings, this.adapterStates, {
      onTranslateNow: () => this.translateCurrentPage(),
      onLauncherPositionChange: (position) => this.persistLauncherPosition(position),
      onToggleSession: () => this.toggleSession(),
      onToggleGlobalOriginal: () => this.toggleGlobalOriginal(),
      onTestConnection: () => {
        void this.testConnection();
      },
      onClearCache: () => {
        void this.clearCache();
      },
      onSaveSettings: (settings) => this.applySettings(settings),
      onToggleImageOriginal: (id) => this.toggleImageOriginal(id),
      onRetryImage: (id) => this.retryImage(id),
      onCancelImage: (id) => this.cancelImage(id),
      onIgnoreImage: (id) => this.ignoreImage(id)
    });

    this.rebuildDiscovery();

    if (this.enabled) {
      this.scheduleInitialAutoTranslateScan();
    }

    this.renderChrome();
  }

  private renderChrome(): void {
    this.overlay.updateChrome({
      enabled: this.enabled,
      globalShowOriginal: this.globalShowOriginal,
      queueStats: this.queueStats,
      connection: this.connection
    });
  }

  private renderImages(): void {
    const models: OverlayViewModel[] = [];

    for (const entry of this.imageEntries.values()) {
      if (!entry.image.isConnected) {
        continue;
      }

      const status = entry.ignored
        ? "ignored"
        : entry.canceled
          ? "canceled"
          : entry.shared.status;

      let message = entry.shared.message;
      if (entry.ignored) {
        message = "已忽略此图片";
      } else if (entry.canceled) {
        message = "已取消此图片";
      }

      const showOriginal = this.globalShowOriginal || entry.showOriginal;
      syncImagePresentation(entry.image, entry.presentation, {
        sourceUrl: entry.shared.sourceUrl,
        resultUrl: entry.shared.resultUrl,
        showOriginal
      });

      models.push({
        id: entry.id,
        image: entry.image,
        status,
        message,
        resultUrl: entry.shared.resultUrl,
        showOriginal,
        queuePosition: entry.ignored || entry.canceled ? null : entry.shared.queuePosition,
        canRetry: status === "error" || status === "canceled" || status === "ignored",
        canCancel: !entry.ignored && !entry.canceled && entry.shared.activeTask,
        canIgnore: !entry.ignored && status !== "complete"
      });
    }

    this.overlay.renderImages(models);
  }

  private toggleSession(): void {
    this.enabled = !this.enabled;
    if (this.enabled) {
      this.discoveryReady = true;
      this.clearInitialAutoTranslateScan();
      this.queue.resume();
      this.discovery?.reset();
      this.discovery?.rescan();
      this.overlay.toast("已启动本页自动翻译。", "neutral");
    } else {
      this.discoveryReady = false;
      this.clearInitialAutoTranslateScan();
      this.queue.pause();
      this.overlay.toast("已暂停新任务排队。正在处理的任务会继续完成。", "neutral");
    }
    this.renderChrome();
  }

  private translateCurrentPage(): void {
    const wasEnabled = this.enabled;
    if (!wasEnabled) {
      this.enabled = true;
      this.queue.resume();
    }

    this.discoveryReady = true;
    this.clearInitialAutoTranslateScan();
    this.discovery?.reset();
    this.discovery?.rescan();
    this.renderChrome();
    this.overlay.toast(wasEnabled ? "已重新扫描当前页图片。" : "已启动本页自动翻译。", "neutral");
  }

  private toggleGlobalOriginal(): void {
    this.globalShowOriginal = !this.globalShowOriginal;
    this.renderChrome();
    this.renderImages();
  }

  private persistLauncherPosition(position: LauncherPosition): void {
    this.settings = saveSettings({
      ...this.settings,
      launcherPosition: position
    });
    this.overlay.updateSettings(this.settings);
  }

  private handleDiscoveredImage(candidate: DiscoveredImageCandidate): void {
    if (!this.enabled || !this.discoveryReady) {
      return;
    }

    const { image, sourceUrl } = candidate;

    const signature = buildImageSignature(sourceUrl, this.settings);
    const existingId = this.imageIds.get(image);
    if (existingId) {
      const existingEntry = this.imageEntries.get(existingId);
      if (existingEntry?.shared.signature === signature) {
        refreshImagePresentationState(existingEntry.image, existingEntry.presentation, sourceUrl);
        return;
      }
      if (existingEntry) {
        existingEntry.shared.imageIds.delete(existingId);
        releaseImagePresentation(existingEntry.image, existingEntry.presentation);
        this.imageEntries.delete(existingId);
        this.cancelSharedTaskIfUnused(existingEntry.shared, "canceled");
      }
    }

    const imageId = existingId ?? `mit-image-${++this.imageSequence}`;
    this.imageIds.set(image, imageId);

    let shared = this.sharedTasks.get(signature);
    if (!shared) {
      shared = {
        signature,
        sourceUrl,
        sourceImage: image,
        taskId: `mit-task-${signature}`,
        imageIds: new Set<string>(),
        resultUrl: null,
        status: "queued",
        message: "等待加入队列",
        queuePosition: null,
        activeTask: false,
        servedFromCache: false
      };
      this.sharedTasks.set(signature, shared);
      this.enqueueSharedTask(shared);
    }

    if (!shared.sourceImage || !shared.sourceImage.isConnected) {
      shared.sourceImage = image;
    }

    shared.imageIds.add(imageId);
    this.imageEntries.set(imageId, {
      id: imageId,
      image,
      shared,
      presentation: createImagePresentationState(image, sourceUrl),
      showOriginal: false,
      ignored: false,
      canceled: false
    });
    this.renderImages();
  }

  private enqueueSharedTask(shared: SharedImageTask): void {
    if (shared.activeTask) {
      return;
    }

    shared.activeTask = true;
    shared.status = "queued";
    shared.message = "等待读取原图";
    shared.queuePosition = null;
    shared.servedFromCache = false;

    const generation = this.generation;
    this.queue.enqueue({
      id: shared.taskId,
      onQueued: () => {
        if (generation !== this.generation) {
          return;
        }
        shared.status = "queued";
        shared.message = "等待读取原图";
        this.renderImages();
      },
      onStart: () => {
        if (generation !== this.generation) {
          return;
        }
        shared.status = "processing";
        shared.message = "读取原图";
        this.renderImages();
      },
      run: async (signal) => {
        const sourceBlob = await this.resolveSourceBlob(shared, signal);
        if (generation !== this.generation) {
          return;
        }

        let cacheKey: string | null = null;
        if (this.settings.cacheEnabled) {
          shared.status = "processing";
          shared.message = "检查本地缓存";
          this.renderImages();

          cacheKey = await this.resultCache.buildKey(sourceBlob, shared.sourceUrl, this.settings);
          if (cacheKey) {
            const cachedResult = await this.resultCache.get(cacheKey);
            if (generation !== this.generation) {
              return;
            }

            if (cachedResult) {
              if (shared.resultUrl) {
                URL.revokeObjectURL(shared.resultUrl);
              }
              shared.servedFromCache = true;
              shared.resultUrl = URL.createObjectURL(cachedResult);
              shared.message = "命中本地缓存";
              this.renderImages();
              return;
            }
          }
        }

        shared.status = "processing";
        shared.message = "上传到翻译服务";
        this.renderImages();

        const result = await this.transport.translateImage({
          imageBlob: sourceBlob,
          fileName: deriveFileName(shared.sourceUrl),
          settings: this.settings,
          signal,
          onEvent: (event) => this.handleTranslationEvent(shared, generation, event)
        });

        if (generation !== this.generation) {
          return;
        }

        if (cacheKey) {
          await this.resultCache.set(cacheKey, result);
        }

        if (shared.resultUrl) {
          URL.revokeObjectURL(shared.resultUrl);
        }
        shared.resultUrl = URL.createObjectURL(result);
      },
      onSuccess: () => {
        if (generation !== this.generation) {
          return;
        }
        shared.activeTask = false;
        shared.status = "complete";
        shared.message = shared.servedFromCache ? "已从缓存加载" : "翻译完成";
        shared.queuePosition = null;
        this.connection = createConnectionState(
          shared.servedFromCache ? "已命中本地缓存" : "翻译服务已响应",
          "success"
        );
        this.renderChrome();
        this.renderImages();
      },
      onError: (error) => {
        if (generation !== this.generation) {
          return;
        }
        shared.activeTask = false;
        shared.status = "error";
        shared.message = this.humanizeError(error);
        shared.queuePosition = null;
        this.connection = createConnectionState(shared.message, "error");
        this.renderChrome();
        this.renderImages();
        this.overlay.toast(shared.message, "error");
      },
      onCancel: (reason) => {
        if (generation !== this.generation) {
          return;
        }
        shared.activeTask = false;
        shared.status = reason;
        shared.message = reason === "ignored" ? "已忽略未完成任务" : "已取消未完成任务";
        shared.queuePosition = null;
        this.renderImages();
      }
    });
  }

  private async resolveSourceBlob(shared: SharedImageTask, signal?: AbortSignal): Promise<Blob> {
    if (shared.sourceImage?.isConnected) {
      // 对已显示在页面上的图片优先复用浏览器内存中的像素，避免某些图床对脚本二次拉图返回 403。
      const sourceBlob = await extractImageBlobFromElement(shared.sourceImage);
      if (sourceBlob) {
        return sourceBlob;
      }
    }

    return this.transport.fetchImageBlob(shared.sourceUrl, signal);
  }

  private handleTranslationEvent(
    shared: SharedImageTask,
    generation: number,
    event: TranslationEvent
  ): void {
    if (generation !== this.generation || !isRenderableEvent(event)) {
      return;
    }

    if (event.code === 3) {
      shared.status = "queued";
      shared.queuePosition = event.text;
      shared.message = "等待可用实例";
      this.renderImages();
      return;
    }

    if (event.code === 4) {
      shared.status = "processing";
      shared.queuePosition = null;
      shared.message = "实例已就绪";
      this.renderImages();
      return;
    }

    if (event.code === 1) {
      shared.status = "processing";
      shared.message = deriveProgressMessage(event);
      this.renderImages();
    }
  }

  private applySettings(nextSettings: UserscriptSettings): void {
    this.settings = saveSettings(nextSettings);
    this.refreshAdapterState();
    this.overlay.updateSettings(this.settings);
    this.overlay.updateAdapterStates(this.adapterStates);
    this.resetRuntimeState();
    this.rebuildDiscovery();
    this.queue.setMaxConcurrency(this.settings.maxConcurrency);
    this.enabled = this.settings.autoTranslateEnabled;
    this.clearInitialAutoTranslateScan();
    if (this.enabled) {
      this.discoveryReady = true;
      this.queue.resume();
      this.discovery?.reset();
      this.discovery?.rescan();
    } else {
      this.discoveryReady = false;
      this.queue.pause();
    }
    this.overlay.toast("设置已保存。后续任务将使用新配置。", "neutral");
    this.renderChrome();
  }

  private async clearCache(): Promise<void> {
    const cleared = await this.resultCache.clear();
    if (cleared) {
      this.overlay.toast("本地缓存已清空。", "neutral");
      return;
    }

    this.overlay.toast("清理本地缓存失败。", "error");
  }

  private resetRuntimeState(): void {
    this.clearInitialAutoTranslateScan();
    this.generation += 1;
    this.queue.reset("canceled");
    for (const entry of this.imageEntries.values()) {
      releaseImagePresentation(entry.image, entry.presentation);
    }
    for (const shared of this.sharedTasks.values()) {
      if (shared.resultUrl) {
        URL.revokeObjectURL(shared.resultUrl);
      }
    }
    this.imageEntries.clear();
    this.sharedTasks.clear();
    this.imageIds = new WeakMap<HTMLImageElement, string>();
    this.discovery?.reset();
    this.renderImages();
  }

  private scheduleInitialAutoTranslateScan(): void {
    this.discoveryReady = false;
    this.clearInitialAutoTranslateScan();

    if (document.readyState === "complete") {
      this.startInitialAutoTranslateTimer();
      return;
    }

    this.waitingForInitialAutoScanLoad = true;
    window.addEventListener(
      "load",
      this.handleInitialAutoScanLoad,
      { once: true }
    );
  }

  private handleInitialAutoScanLoad = (): void => {
    this.waitingForInitialAutoScanLoad = false;
    this.startInitialAutoTranslateTimer();
  };

  private startInitialAutoTranslateTimer(): void {
    this.initialAutoScanTimer = window.setTimeout(() => {
      this.initialAutoScanTimer = null;
      if (!this.enabled) {
        return;
      }
      this.discoveryReady = true;
      this.discovery?.reset();
      this.discovery?.rescan();
    }, INITIAL_AUTO_TRANSLATE_SCAN_DELAY_MS);
  }

  private clearInitialAutoTranslateScan(): void {
    if (this.waitingForInitialAutoScanLoad) {
      window.removeEventListener("load", this.handleInitialAutoScanLoad);
      this.waitingForInitialAutoScanLoad = false;
    }

    if (this.initialAutoScanTimer !== null) {
      window.clearTimeout(this.initialAutoScanTimer);
      this.initialAutoScanTimer = null;
    }
  }

  private refreshAdapterState(): void {
    this.adapterStates = resolveSiteAdapterStates(window.location, this.settings.adapterOverrides);
  }

  private rebuildDiscovery(): void {
    this.discovery?.stop();
    this.adapterDomTweaksCleanup?.();
    this.adapterDomTweaksCleanup = null;

    const activeAdapters = resolveActiveSiteAdapters(window.location, this.settings.adapterOverrides);
    this.adapterDomTweaksCleanup = this.installAdapterDomTweaks(activeAdapters);
    this.discovery = new ImageDiscovery({
      adapters: activeAdapters,
      eagerScanEnabled: this.settings.fullPageTranslateEnabled,
      onImageEligible: (candidate) => this.handleDiscoveredImage(candidate)
    });
    this.discovery.start();
  }

  private installAdapterDomTweaks(adapters: ReadonlyArray<SiteAdapterDefinition>): (() => void) | null {
    const cleanups = adapters
      .map((adapter) => adapter.installDomTweaks?.(document))
      .filter((cleanup): cleanup is () => void => typeof cleanup === "function");

    if (cleanups.length === 0) {
      return null;
    }

    return () => {
      for (const cleanup of cleanups.reverse()) {
        cleanup();
      }
    };
  }

  private toggleImageOriginal(id: string): void {
    const entry = this.imageEntries.get(id);
    if (!entry) {
      return;
    }
    entry.showOriginal = !entry.showOriginal;
    this.renderImages();
  }

  private ignoreImage(id: string): void {
    const entry = this.imageEntries.get(id);
    if (!entry) {
      return;
    }
    entry.ignored = true;
    entry.canceled = false;
    this.cancelSharedTaskIfUnused(entry.shared, "ignored");
    this.renderImages();
  }

  private cancelImage(id: string): void {
    const entry = this.imageEntries.get(id);
    if (!entry) {
      return;
    }
    entry.canceled = true;
    entry.ignored = false;
    this.cancelSharedTaskIfUnused(entry.shared, "canceled");
    this.renderImages();
  }

  private retryImage(id: string): void {
    const entry = this.imageEntries.get(id);
    if (!entry) {
      return;
    }

    entry.ignored = false;
    entry.canceled = false;

    if (entry.shared.status === "complete") {
      this.renderImages();
      return;
    }

    if (!entry.shared.activeTask) {
      this.enqueueSharedTask(entry.shared);
    }

    this.renderImages();
  }

  private cancelSharedTaskIfUnused(shared: SharedImageTask, reason: CancelReason): void {
    for (const imageId of shared.imageIds) {
      const entry = this.imageEntries.get(imageId);
      if (entry && !entry.ignored && !entry.canceled) {
        return;
      }
    }
    if (shared.activeTask) {
      this.queue.cancel(shared.taskId, reason);
    }
  }

  private async testConnection(): Promise<void> {
    try {
      const health = await this.transport.checkHealth(this.settings);
      this.connection = createConnectionState(
        `连接成功 · v${health.version} · 队列 ${health.queue_size}`,
        "success"
      );
      this.renderChrome();
      this.overlay.toast("连接成功，远程服务可用。");
    } catch (error) {
      const message = this.humanizeError(error);
      this.connection = createConnectionState(message, "error");
      this.renderChrome();
      this.overlay.toast(message, "error");
    }
  }

  private humanizeError(error: unknown): string {
    if (isAbortError(error)) {
      return "任务已取消";
    }

    if (error instanceof HttpStatusError) {
      if (error.status === 401) {
        return "API Key 无效或缺失";
      }
      return `服务器返回 ${error.status}`;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return "未知错误";
  }
}
