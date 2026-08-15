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
import { extractImageBlobFromElement, getManagedImageSourceUrl } from "../utils/image";
import { buildImageContentHash, buildImageContentSignature } from "../utils/signature";
import { BrowserPerformanceDiagnostics } from "../utils/performance";
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
  imageHash: string;
  diagnosticTaskId: string;
  sourceUrl: string;
  sourceImage: HTMLImageElement | null;
  sourceBlob: Blob | null;
  taskId: string;
  imageIds: Set<string>;
  resultUrl: string | null;
  status: SharedTaskStatus;
  message: string;
  queuePosition: string | null;
  activeTask: boolean;
  servedFromCache: boolean;
  resultByteSize: number;
}

interface SourceBlobRequest {
  sourceUrl: string;
  sourceImage: HTMLImageElement | null;
  sourceBlob?: Blob | null;
}

interface PreparedDiscoveredImage {
  adapterId: string;
  discoveryRun: number;
  generation: number;
  image: HTMLImageElement;
  imageHash: string;
  diagnosticTaskId: string;
  sourceBlob: Blob;
  sourceUrl: string;
}

interface ImageEntry {
  id: string;
  image: HTMLImageElement;
  sourceUrl: string;
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
  return !event.text.startsWith("rendering_folder:")
    && !event.text.startsWith("final_ready:")
    && !event.text.startsWith("diagnostics:");
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

/** Coordinates discovery, bounded preparation, translation, caching, and page replacement. */
export class TranslatorController {
  private readonly transport: TransportClient;

  private readonly resultCache: TranslationResultCache;

  private discovery: ImageDiscovery | null = null;

  private readonly overlay: OverlayManager;

  private readonly queue: TaskQueue;

  private readonly diagnostics: BrowserPerformanceDiagnostics;

  private settings = loadSettings();

  private enabled = this.settings.autoTranslateEnabled;

  private discoveryReady = !this.enabled;

  private globalShowOriginal = false;

  private connection = createConnectionState("尚未连接服务器");

  private queueStats = createQueueStats();

  private imageSequence = 0;

  private generation = 0;

  private discoverySequence = 0;

  private diagnosticSequence = 0;

  private nextDiscoveryFlushSequence = 1;

  private readonly pendingPreparedImages = new Map<number, PreparedDiscoveredImage | null>();

  private readonly pendingDiscoveryCandidates: Array<{
    sequence: number;
    candidate: DiscoveredImageCandidate;
  }> = [];

  private discoveryPreparationActive = false;

  private preparedTaskQueued = 0;

  private discoveryRuns = new WeakMap<HTMLImageElement, number>();

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
    this.diagnostics = new BrowserPerformanceDiagnostics(this.settings.performanceDiagnostics);
    this.refreshAdapterState();

    this.queue = new TaskQueue({
      maxConcurrency: 1,
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

    if (this.settings.streamEndpoint === "auto" || this.settings.maxConcurrency > 1) {
      void this.negotiateServiceCapacity();
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
        sourceUrl: entry.sourceUrl,
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

    const sequence = ++this.discoverySequence;
    this.pendingDiscoveryCandidates.push({ sequence, candidate });
    this.drainDiscoveryPreparations();
  }

  private drainDiscoveryPreparations(): void {
    if (
      this.discoveryPreparationActive ||
      this.preparedTaskQueued >= 1 ||
      !this.enabled ||
      !this.discoveryReady
    ) {
      return;
    }

    const pending = this.pendingDiscoveryCandidates.shift();
    if (!pending) {
      return;
    }

    this.discoveryPreparationActive = true;
    const diagnosticTaskId = `mit-discovery-${pending.sequence}`;
    this.diagnostics.begin(diagnosticTaskId, 0);
    this.diagnostics.mark(diagnosticTaskId, "source_fetch_start");
    void this.prepareDiscoveredImage(pending.candidate, diagnosticTaskId)
      .then((preparedImage) => {
        if (!preparedImage) {
          this.diagnostics.finish(diagnosticTaskId, "canceled");
        }
        this.commitPreparedDiscovery(pending.sequence, preparedImage);
      })
      .catch((error: unknown) => {
        const message = this.humanizeError(error);
        this.connection = createConnectionState(message, "error");
        this.renderChrome();
        this.overlay.toast(message, "error");
        this.diagnostics.finish(diagnosticTaskId, "error");
        this.commitPreparedDiscovery(pending.sequence, null);
      })
      .finally(() => {
        this.discoveryPreparationActive = false;
        this.drainDiscoveryPreparations();
      });
  }

  private async prepareDiscoveredImage(
    candidate: DiscoveredImageCandidate,
    diagnosticTaskId = `mit-direct-discovery-${this.discoverySequence + 1}`
  ): Promise<PreparedDiscoveredImage | null> {
    const { image, sourceUrl } = candidate;
    const discoveryRun = this.nextDiscoveryRun(image);
    const generation = this.generation;
    const existingId = this.imageIds.get(image);
    const existingEntry = existingId ? this.imageEntries.get(existingId) : null;
    const currentSource = image.currentSrc || image.src || "";

    if (
      existingEntry?.shared.resultUrl &&
      currentSource === existingEntry.shared.resultUrl &&
      getManagedImageSourceUrl(image) === sourceUrl
    ) {
      existingEntry.sourceUrl = sourceUrl;
      refreshImagePresentationState(existingEntry.image, existingEntry.presentation, sourceUrl);
      return null;
    }

    const sourceBlob = await this.resolveSourceBlob({ sourceUrl, sourceImage: image, sourceBlob: null });
    this.diagnostics.setSourceBytes(diagnosticTaskId, sourceBlob.size);
    this.diagnostics.mark(diagnosticTaskId, "source_ready");

    if (
      generation !== this.generation ||
      this.discoveryRuns.get(image) !== discoveryRun ||
      !this.enabled ||
      !this.discoveryReady ||
      !image.isConnected
    ) {
      return null;
    }

    const currentSourceUrl = this.resolveCurrentSourceUrl(candidate);
    if (currentSourceUrl !== sourceUrl) {
      return null;
    }

    const imageHash = await buildImageContentHash(sourceBlob);
    this.diagnostics.mark(diagnosticTaskId, "hash_ready");
    if (
      generation !== this.generation ||
      this.discoveryRuns.get(image) !== discoveryRun ||
      !this.enabled ||
      !this.discoveryReady ||
      !image.isConnected
    ) {
      return null;
    }

    return {
      adapterId: candidate.adapterId,
      discoveryRun,
      generation,
      image,
      imageHash,
      diagnosticTaskId,
      sourceBlob,
      sourceUrl
    };
  }

  private commitPreparedDiscovery(
    sequence: number,
    preparedImage: PreparedDiscoveredImage | null
  ): void {
    if (sequence < this.nextDiscoveryFlushSequence) {
      return;
    }

    this.pendingPreparedImages.set(sequence, preparedImage);
    this.flushPreparedDiscoveries();
  }

  private flushPreparedDiscoveries(): void {
    while (this.pendingPreparedImages.has(this.nextDiscoveryFlushSequence)) {
      const preparedImage = this.pendingPreparedImages.get(this.nextDiscoveryFlushSequence) ?? null;
      this.pendingPreparedImages.delete(this.nextDiscoveryFlushSequence);
      this.nextDiscoveryFlushSequence += 1;

      if (preparedImage) {
        this.registerPreparedImage(preparedImage);
      }
    }
  }

  private registerPreparedImage(preparedImage: PreparedDiscoveredImage): void {
    const {
      adapterId,
      discoveryRun,
      generation,
      image,
      imageHash,
      diagnosticTaskId,
      sourceBlob,
      sourceUrl
    } = preparedImage;

    if (
      generation !== this.generation ||
      this.discoveryRuns.get(image) !== discoveryRun ||
      !this.enabled ||
      !this.discoveryReady ||
      !image.isConnected
    ) {
      this.diagnostics.finish(diagnosticTaskId, "canceled");
      return;
    }

    const currentSourceUrl = this.resolveCurrentSourceUrl({ adapterId, image, sourceUrl });
    if (currentSourceUrl !== sourceUrl) {
      this.diagnostics.finish(diagnosticTaskId, "canceled");
      return;
    }

    const signature = buildImageContentSignature(imageHash, this.settings);
    const existingId = this.imageIds.get(image);
    const existingEntry = existingId ? this.imageEntries.get(existingId) : null;
    if (existingId) {
      if (existingEntry?.shared.signature === signature) {
        existingEntry.sourceUrl = sourceUrl;
        refreshImagePresentationState(existingEntry.image, existingEntry.presentation, sourceUrl);
        this.diagnostics.finish(diagnosticTaskId, "cache");
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
        imageHash,
        diagnosticTaskId,
        sourceUrl,
        sourceImage: image,
        sourceBlob,
        taskId: `mit-task-${signature}`,
        imageIds: new Set<string>(),
        resultUrl: null,
        status: "queued",
        message: "等待加入队列",
        queuePosition: null,
        activeTask: false,
        servedFromCache: false,
        resultByteSize: 0
      };
      this.sharedTasks.set(signature, shared);
      this.enqueueSharedTask(shared);
    } else if (diagnosticTaskId !== shared.diagnosticTaskId) {
      this.diagnostics.finish(diagnosticTaskId, "cache");
    }

    if (!shared.sourceImage || !shared.sourceImage.isConnected) {
      shared.sourceImage = image;
    }
    if (!shared.sourceBlob) {
      shared.sourceBlob = sourceBlob;
    }

    shared.imageIds.add(imageId);
    this.imageEntries.set(imageId, {
      id: imageId,
      image,
      sourceUrl,
      shared,
      presentation: createImagePresentationState(image, sourceUrl),
      showOriginal: false,
      ignored: false,
      canceled: false
    });
    this.renderImages();
  }

  private nextDiscoveryRun(image: HTMLImageElement): number {
    const nextRun = (this.discoveryRuns.get(image) ?? 0) + 1;
    this.discoveryRuns.set(image, nextRun);
    return nextRun;
  }

  private resolveCurrentSourceUrl(candidate: DiscoveredImageCandidate): string | null {
    const adapter = resolveActiveSiteAdapters(window.location, this.settings.adapterOverrides)
      .find((activeAdapter) => activeAdapter.id === candidate.adapterId);

    return adapter?.resolveImageSource(candidate.image) ?? null;
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
    let awaitingStart = true;
    this.preparedTaskQueued += 1;
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
        if (awaitingStart) {
          awaitingStart = false;
          this.preparedTaskQueued = Math.max(0, this.preparedTaskQueued - 1);
          this.drainDiscoveryPreparations();
        }
        if (generation !== this.generation) {
          return;
        }
        shared.status = "processing";
        shared.message = "读取原图";
        this.diagnostics.mark(shared.diagnosticTaskId, "queue_started");
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
          this.diagnostics.mark(shared.diagnosticTaskId, "cache_lookup");
          this.renderImages();

          cacheKey = this.resultCache.buildKeyFromHash(shared.imageHash, this.settings);
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
              shared.resultByteSize = cachedResult.size;
              shared.resultUrl = URL.createObjectURL(cachedResult);
              shared.message = "命中本地缓存";
              this.renderImages();
              return;
            }
          }
        }

        shared.status = "processing";
        shared.message = "上传到翻译服务";
        this.diagnostics.setUploadBytes(shared.diagnosticTaskId, sourceBlob.size);
        this.diagnostics.mark(shared.diagnosticTaskId, "upload_start");
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
          // IndexedDB bookkeeping must not delay replacement with a result
          // that has already completed translation and download.
          void this.resultCache.set(cacheKey, result);
        }

        shared.resultByteSize = result.size;
        this.diagnostics.mark(shared.diagnosticTaskId, "result_received");

        if (shared.resultUrl) {
          URL.revokeObjectURL(shared.resultUrl);
        }
        shared.resultUrl = URL.createObjectURL(result);
      },
      onSuccess: () => {
        if (generation !== this.generation) {
          return;
        }
        // Successful pages retain only the displayed result URL. Keeping every
        // compressed source Blob would make long reader sessions grow linearly;
        // failed/canceled tasks still retain theirs for an explicit retry.
        shared.sourceBlob = null;
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
        this.diagnostics.mark(shared.diagnosticTaskId, "page_replaced");
        this.diagnostics.finish(
          shared.diagnosticTaskId,
          shared.servedFromCache ? "cache" : "complete",
          shared.resultByteSize
        );
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
        this.diagnostics.finish(shared.diagnosticTaskId, "error");
      },
      onCancel: (reason) => {
        if (awaitingStart) {
          awaitingStart = false;
          this.preparedTaskQueued = Math.max(0, this.preparedTaskQueued - 1);
          this.drainDiscoveryPreparations();
        }
        if (generation !== this.generation) {
          return;
        }
        shared.activeTask = false;
        shared.status = reason;
        shared.message = reason === "ignored" ? "已忽略未完成任务" : "已取消未完成任务";
        shared.queuePosition = null;
        this.renderImages();
        this.diagnostics.finish(shared.diagnosticTaskId, "canceled");
      }
    });
  }

  private async resolveSourceBlob(shared: SourceBlobRequest, signal?: AbortSignal): Promise<Blob> {
    if (shared.sourceBlob) {
      return shared.sourceBlob;
    }

    let networkError: unknown = null;
    try {
      return await this.transport.fetchImageBlob(shared.sourceUrl, signal);
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      networkError = error;
    }

    if (shared.sourceImage?.isConnected) {
      const currentSource = shared.sourceImage.currentSrc || shared.sourceImage.src || "";
      const managedSource = getManagedImageSourceUrl(shared.sourceImage);
      if (!currentSource.startsWith("blob:") || managedSource !== shared.sourceUrl) {
        // Canvas is intentionally the last fallback: a 704×26000 RGBA canvas
        // consumes roughly 70 MiB and PNG re-encoding blocks the main thread.
        const sourceBlob = await extractImageBlobFromElement(shared.sourceImage);
        if (sourceBlob) {
          return sourceBlob;
        }
      }
    }

    throw networkError instanceof Error
      ? networkError
      : new Error("无法读取原始图片。请检查图床跨域权限。");
  }

  private handleTranslationEvent(
    shared: SharedImageTask,
    generation: number,
    event: TranslationEvent
  ): void {
    if (generation !== this.generation) {
      return;
    }

    if (event.code === 1 && event.text.startsWith("diagnostics:")) {
      try {
        const diagnostics = JSON.parse(event.text.slice("diagnostics:".length)) as Record<
          string,
          unknown
        >;
        this.diagnostics.setServerDiagnostics(shared.diagnosticTaskId, diagnostics);
      } catch {
        // Malformed optional diagnostics never block a completed translation.
      }
      return;
    }

    if (event.code === 1) {
      this.diagnostics.mark(shared.diagnosticTaskId, `server:${event.text || "progress"}`);
    }
    if (!isRenderableEvent(event)) {
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
    this.diagnostics.setEnabled(this.settings.performanceDiagnostics);
    this.refreshAdapterState();
    this.overlay.updateSettings(this.settings);
    this.overlay.updateAdapterStates(this.adapterStates);
    this.resetRuntimeState();
    this.rebuildDiscovery();
    // Raise above one only after the service explicitly recommends it.
    this.queue.setMaxConcurrency(1);
    this.enabled = this.settings.autoTranslateEnabled;
    this.clearInitialAutoTranslateScan();
    if (this.enabled) {
      this.discoveryReady = true;
      this.queue.resume();
      this.discovery?.reset();
      this.discovery?.rescan();
      if (this.settings.streamEndpoint === "auto" || this.settings.maxConcurrency > 1) {
        void this.negotiateServiceCapacity();
      }
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
    this.diagnostics.reset();
    this.pendingPreparedImages.clear();
    this.pendingDiscoveryCandidates.length = 0;
    this.preparedTaskQueued = 0;
    this.nextDiscoveryFlushSequence = this.discoverySequence + 1;
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
    this.discoveryRuns = new WeakMap<HTMLImageElement, number>();
    this.discovery?.reset();
    this.renderImages();
  }

  private scheduleInitialAutoTranslateScan(): void {
    this.discoveryReady = false;
    this.clearInitialAutoTranslateScan();

    if (document.readyState !== "loading") {
      this.startInitialAutoTranslateTimer();
      return;
    }

    this.waitingForInitialAutoScanLoad = true;
    document.addEventListener(
      "DOMContentLoaded",
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
      document.removeEventListener("DOMContentLoaded", this.handleInitialAutoScanLoad);
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
      entry.shared.diagnosticTaskId = `mit-retry-${++this.diagnosticSequence}`;
      this.diagnostics.begin(
        entry.shared.diagnosticTaskId,
        entry.shared.sourceBlob?.size ?? 0
      );
      this.diagnostics.mark(entry.shared.diagnosticTaskId, "retry_reuse_source");
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
      this.applyServiceCapacity(health);
      this.connection = createConnectionState(
        `连接成功 · v${health.version} · 队列 ${health.queue_size}`,
        "success"
      );
      this.renderChrome();
      this.overlay.toast("连接成功，本地翻译服务可用。");
    } catch (error) {
      const message = this.humanizeError(error);
      this.connection = createConnectionState(message, "error");
      this.renderChrome();
      this.overlay.toast(message, "error");
    }
  }

  private async negotiateServiceCapacity(): Promise<void> {
    try {
      const health = await this.transport.checkHealth(this.settings);
      this.applyServiceCapacity(health);
    } catch {
      // Translation retains the standard endpoint fallback and surfaces errors
      // at the task boundary; a background capability probe is best-effort.
    }
  }

  private applyServiceCapacity(health: { recommended_client_concurrency?: number }): void {
    const recommended = Number(health.recommended_client_concurrency);
    if (!Number.isFinite(recommended) || recommended < 1) {
      return;
    }
    this.queue.setMaxConcurrency(Math.min(this.settings.maxConcurrency, Math.floor(recommended)));
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
