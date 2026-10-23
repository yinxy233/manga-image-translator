import { resolveActiveSiteAdapters, resolveSiteAdapterStates } from "../adapters";
import type { SiteAdapterDefinition, SiteAdapterState } from "../adapters/types";
import { INITIAL_AUTO_TRANSLATE_SCAN_DELAY_MS, PROGRESS_TEXT_MAP } from "../config";
import { TranslationResultCache } from "../cache";
import { loadSettings, saveSettings } from "../storage";
import type {
  ConnectionState,
  ImagePreparationStage,
  ImageScanReport,
  ImageSourceProgress,
  LauncherPosition,
  OverlayViewModel,
  SharedTaskStatus,
  TranslationSessionState,
  TranslationEvent,
  UserscriptSettings
} from "../types";
import { getManagedImageSourceUrl } from "../utils/image";
import { buildImageContentHash, buildImageContentSignature } from "../utils/signature";
import { BrowserPerformanceDiagnostics } from "../utils/performance";
import { HttpStatusError, TransportClient } from "../utils/transport";
import { type DiscoveredImageCandidate, ImageDiscovery } from "./imageDiscovery";
import { ImageSourceLoadError, ImageSourceLoader } from "./imageSourceLoader";
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
  lastProgressRenderAt: number;
}

interface SourceBlobRequest {
  sourceUrl: string;
  sourceImage: HTMLImageElement | null;
  sourceBlob?: Blob | null;
  allowLargePixelFallback?: boolean;
  onProgress?: (progress: ImageSourceProgress) => void;
}

interface PreparedDiscoveredImage {
  adapterId: string;
  generation: number;
  image: HTMLImageElement;
  imageId: string;
  imageHash: string;
  diagnosticTaskId: string;
  preparationRun: number;
  sourceBlob: Blob;
  sourceUrl: string;
}

interface ImageEntry {
  id: string;
  image: HTMLImageElement;
  adapterId: string;
  sourceUrl: string;
  shared: SharedImageTask | null;
  presentation: ImagePresentationState;
  showOriginal: boolean;
  ignored: boolean;
  canceled: boolean;
  preparationStage: ImagePreparationStage;
  preparationMessage: string;
  sourceProgress: ImageSourceProgress | null;
  preparationController: AbortController | null;
  preparationPending: boolean;
  preparationRun: number;
  priority: 0 | 1 | 2;
  readyForPreparation: boolean;
  allowLargePixelFallback: boolean;
  canRetryWithPixels: boolean;
  resumeAfterPause: boolean;
  lastProgressRenderAt: number;
}

interface ActivePreparation {
  controller: AbortController;
  lastLoadedBytes: number;
  stalled: boolean;
  stallTimer: number | null;
}

function createConnectionState(
  label: string,
  tone: ConnectionState["tone"] = "neutral"
): ConnectionState {
  return { label, tone };
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

function describeScanReport(report: ImageScanReport): string {
  if (report.candidates === 0) {
    return report.inspected === 0
      ? "当前阅读区域还没有普通图片；会继续监听后续懒加载内容。"
      : `检查了 ${report.inspected} 张图片，暂未找到尺寸和站点规则都符合的漫画图；会继续监听。`;
  }

  const waiting = report.waitingForLoad > 0
    ? `，其中 ${report.waitingForLoad} 张仍在加载`
    : "";
  const added = report.added > 0 ? `，新增 ${report.added} 张` : "，没有重复加入任务";
  return `已发现 ${report.candidates} 张${added}${waiting}；仍在监听后续图片。`;
}

const SOURCE_STALL_BYPASS_MS = 3_000;
const SOURCE_PROGRESS_RENDER_INTERVAL_MS = 100;

/** Coordinates discovery, bounded preparation, translation, caching, and page replacement. */
export class TranslatorController {
  private readonly transport: TransportClient;

  private readonly sourceLoader: ImageSourceLoader;

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

  private imageSequence = 0;

  private generation = 0;

  private diagnosticSequence = 0;

  private readonly pendingPreparationIds: string[] = [];

  private readonly activePreparations = new Map<string, ActivePreparation>();

  private preparedTaskQueued = 0;

  private imageIds = new WeakMap<HTMLImageElement, string>();

  private readonly imageEntries = new Map<string, ImageEntry>();

  private readonly sharedTasks = new Map<string, SharedImageTask>();

  private adapterStates: SiteAdapterState[] = [];

  private adapterDomTweaksCleanup: (() => void) | null = null;

  private waitingForInitialAutoScanLoad = false;

  private initialAutoScanTimer: number | null = null;

  private imageRenderQueued = false;

  constructor() {
    this.transport = new TransportClient();
    this.sourceLoader = new ImageSourceLoader();
    this.resultCache = new TranslationResultCache();
    this.diagnostics = new BrowserPerformanceDiagnostics(this.settings.performanceDiagnostics);
    this.refreshAdapterState();

    this.queue = new TaskQueue({
      maxConcurrency: 1,
      paused: !this.enabled,
      onStatsChange: () => {
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
      onRetryImageWithPixels: (id) => this.retryImageWithPixels(id),
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
      globalShowOriginal: this.globalShowOriginal,
      session: this.createSessionState(),
      connection: this.connection
    });
  }

  private createSessionState(): TranslationSessionState {
    const state: TranslationSessionState = {
      enabled: this.enabled,
      listening: this.enabled && this.discoveryReady,
      reading: 0,
      queued: 0,
      processing: 0,
      completed: 0,
      errors: 0,
      total: 0
    };

    for (const entry of this.imageEntries.values()) {
      if (!entry.image.isConnected || entry.ignored || entry.canceled) {
        continue;
      }
      state.total += 1;
      if (!entry.shared) {
        if (entry.preparationStage === "error") {
          state.errors += 1;
        } else {
          state.reading += 1;
        }
        continue;
      }
      if (entry.shared.status === "queued") {
        state.queued += 1;
      } else if (entry.shared.status === "processing") {
        state.processing += 1;
      } else if (entry.shared.status === "complete") {
        state.completed += 1;
      } else if (entry.shared.status === "error") {
        state.errors += 1;
      }
    }
    return state;
  }

  /** Coalesce one scan's synchronous discoveries before the browser paints, without awaiting I/O. */
  private requestImageRender(): void {
    if (this.imageRenderQueued) {
      return;
    }
    this.imageRenderQueued = true;
    queueMicrotask(() => {
      if (this.imageRenderQueued) {
        this.renderImages();
      }
    });
  }

  /** Render the current image state, superseding any pending discovery refresh. */
  private renderImages(): void {
    this.imageRenderQueued = false;
    const models: OverlayViewModel[] = [];

    for (const entry of this.imageEntries.values()) {
      if (!entry.image.isConnected) {
        continue;
      }

      const shared = entry.shared;
      const status = entry.ignored
        ? "ignored"
        : entry.canceled
          ? "canceled"
          : shared?.status ?? (entry.preparationStage === "error" ? "error" : "pending");

      let message = shared?.message ?? entry.preparationMessage;
      if (entry.ignored) {
        message = "已忽略此图片";
      } else if (entry.canceled) {
        message = "已取消此图片";
      }

      const showOriginal = this.globalShowOriginal || entry.showOriginal;
      syncImagePresentation(entry.image, entry.presentation, {
        sourceUrl: entry.sourceUrl,
        resultUrl: shared?.resultUrl ?? null,
        showOriginal
      });

      models.push({
        id: entry.id,
        image: entry.image,
        status,
        message,
        resultUrl: shared?.resultUrl ?? null,
        showOriginal,
        queuePosition: entry.ignored || entry.canceled ? null : shared?.queuePosition ?? null,
        canRetry: status === "error" || status === "canceled" || status === "ignored",
        canRetryWithPixels: status === "error" && entry.canRetryWithPixels,
        canCancel: !entry.ignored && !entry.canceled && status !== "complete",
        canIgnore: !entry.ignored && status !== "complete",
        preparationStage: shared ? null : entry.preparationStage,
        sourceProgress: shared ? null : entry.sourceProgress
      });
    }

    this.overlay.renderImages(models);
    this.renderChrome();
  }

  private toggleSession(): void {
    this.enabled = !this.enabled;
    if (this.enabled) {
      this.discoveryReady = true;
      this.clearInitialAutoTranslateScan();
      this.queue.resume();
      this.resumePausedPreparations();
      this.discovery?.reset();
      const report = this.discovery?.rescan();
      this.overlay.toast(report ? describeScanReport(report) : "已启动本页自动翻译。", "neutral");
    } else {
      this.discoveryReady = false;
      this.clearInitialAutoTranslateScan();
      this.pauseSourcePreparations();
      this.queue.pause();
      this.overlay.toast("已暂停原图读取和新任务排队；服务端正在处理的任务会继续。", "neutral");
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
    if (!wasEnabled) {
      this.discovery?.reset();
    }
    const report = this.discovery?.rescan();
    this.renderChrome();
    this.overlay.toast(
      report ? describeScanReport(report) : "扫描器尚未就绪；会在页面加载后自动继续。",
      "neutral"
    );
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

  /** Register each candidate immediately; defer only the shared DOM update to a microtask. */
  private handleDiscoveredImage(candidate: DiscoveredImageCandidate): void {
    if (!this.enabled || !this.discoveryReady) {
      return;
    }

    const existingId = this.imageIds.get(candidate.image);
    const existingEntry = existingId ? this.imageEntries.get(existingId) : null;
    if (
      existingEntry &&
      existingEntry.adapterId === candidate.adapterId &&
      existingEntry.sourceUrl === candidate.sourceUrl
    ) {
      existingEntry.priority = Math.min(existingEntry.priority, candidate.priority) as 0 | 1 | 2;
      existingEntry.readyForPreparation ||= candidate.readyForPreparation;
      if (
        candidate.readyForPreparation &&
        !existingEntry.shared &&
        !existingEntry.ignored &&
        !existingEntry.canceled &&
        existingEntry.preparationStage !== "error"
      ) {
        this.schedulePreparation(existingEntry);
      }
      this.drainDiscoveryPreparations();
      this.requestImageRender();
      return;
    }

    const imageId = existingId ?? `mit-image-${++this.imageSequence}`;
    if (existingEntry) {
      this.cancelEntryPreparation(existingEntry);
      this.detachEntryFromShared(existingEntry, "canceled");
      releaseImagePresentation(existingEntry.image, existingEntry.presentation);
    }

    const entry: ImageEntry = {
      id: imageId,
      image: candidate.image,
      adapterId: candidate.adapterId,
      sourceUrl: candidate.sourceUrl,
      shared: null,
      presentation: createImagePresentationState(candidate.image, candidate.sourceUrl),
      showOriginal: false,
      ignored: false,
      canceled: false,
      preparationStage: candidate.readyForPreparation ? "discovered" : "waiting-load",
      preparationMessage: candidate.readyForPreparation ? "等待读取原图" : "等待网页图片加载",
      sourceProgress: null,
      preparationController: null,
      preparationPending: false,
      preparationRun: (existingEntry?.preparationRun ?? 0) + 1,
      priority: candidate.priority,
      readyForPreparation: candidate.readyForPreparation,
      allowLargePixelFallback: false,
      canRetryWithPixels: false,
      resumeAfterPause: false,
      lastProgressRenderAt: -SOURCE_PROGRESS_RENDER_INTERVAL_MS
    };
    this.imageIds.set(candidate.image, imageId);
    this.imageEntries.set(imageId, entry);

    // A scan may report hundreds of images synchronously. Render their states
    // together before the next paint, independently of download/hash completion.
    this.requestImageRender();
    if (candidate.readyForPreparation) {
      this.schedulePreparation(entry);
    }
  }

  /** Admit one normal read or one visible bypass without repeatedly measuring a blocked queue. */
  private drainDiscoveryPreparations(): void {
    if (!this.enabled || !this.discoveryReady || this.preparedTaskQueued >= 1) {
      return;
    }

    // Check capacity before walking pending images: during a large scan, a
    // healthy active read otherwise causes quadratic queue/layout work.
    if (
      this.activePreparations.size >= 2 ||
      (this.activePreparations.size > 0 &&
        !Array.from(this.activePreparations.values()).some((active) => active.stalled))
    ) {
      return;
    }

    const nextEntry = this.takeNextPreparation();
    if (!nextEntry) {
      return;
    }

    if (this.activePreparations.size > 0 && this.getCurrentPriority(nextEntry) !== 0) {
      this.pendingPreparationIds.unshift(nextEntry.id);
      nextEntry.preparationPending = true;
      return;
    }

    const controller = new AbortController();
    const active: ActivePreparation = {
      controller,
      lastLoadedBytes: 0,
      stalled: false,
      stallTimer: null
    };
    this.activePreparations.set(nextEntry.id, active);
    nextEntry.preparationController = controller;
    nextEntry.preparationPending = false;
    nextEntry.preparationStage = "reading-source";
    nextEntry.preparationMessage = "读取原图";
    nextEntry.sourceProgress = null;
    nextEntry.resumeAfterPause = false;
    const preparationRun = nextEntry.preparationRun;
    const diagnosticTaskId = `mit-discovery-${++this.diagnosticSequence}`;
    this.diagnostics.begin(diagnosticTaskId, 0);
    this.diagnostics.mark(diagnosticTaskId, "source_fetch_start");
    this.scheduleStallCheck(nextEntry.id);
    this.requestImageRender();

    void this.prepareDiscoveredImage(nextEntry, diagnosticTaskId, controller.signal)
      .then((preparedImage) => {
        if (!preparedImage) {
          this.diagnostics.finish(diagnosticTaskId, "canceled");
          return;
        }
        this.registerPreparedImage(preparedImage);
      })
      .catch((error: unknown) => {
        const currentEntry = this.imageEntries.get(nextEntry.id);
        if (
          !currentEntry ||
          currentEntry.preparationRun !== preparationRun ||
          isAbortError(error)
        ) {
          this.diagnostics.finish(diagnosticTaskId, "canceled");
          return;
        }
        const message = this.humanizeError(error);
        currentEntry.preparationStage = "error";
        currentEntry.preparationMessage = message;
        currentEntry.canRetryWithPixels =
          error instanceof ImageSourceLoadError && error.canUseLargePixelFallback;
        currentEntry.sourceProgress = null;
        this.connection = createConnectionState(message, "error");
        this.renderImages();
        this.diagnostics.finish(diagnosticTaskId, "error");
      })
      .finally(() => {
        const currentActive = this.activePreparations.get(nextEntry.id);
        if (currentActive?.controller === controller) {
          if (currentActive.stallTimer !== null) {
            window.clearTimeout(currentActive.stallTimer);
          }
          this.activePreparations.delete(nextEntry.id);
        }
        const currentEntry = this.imageEntries.get(nextEntry.id);
        if (currentEntry?.preparationController === controller) {
          currentEntry.preparationController = null;
        }
        this.drainDiscoveryPreparations();
      });

    // A normal read keeps one slot. Only a visible image may use the second
    // slot, and only after this read has reported no byte progress for 3 s.
    this.drainDiscoveryPreparations();
  }

  private async prepareDiscoveredImage(
    entry: ImageEntry,
    diagnosticTaskId: string,
    signal: AbortSignal
  ): Promise<PreparedDiscoveredImage | null> {
    const { adapterId, id: imageId, image, sourceUrl } = entry;
    const preparationRun = entry.preparationRun;
    const generation = this.generation;
    const sourceBlob = await this.resolveSourceBlob(
      {
        sourceUrl,
        sourceImage: image,
        sourceBlob: null,
        allowLargePixelFallback: entry.allowLargePixelFallback,
        onProgress: (progress) => this.handleSourceProgress(imageId, preparationRun, progress)
      },
      signal
    );
    this.diagnostics.setSourceBytes(diagnosticTaskId, sourceBlob.size);
    this.diagnostics.mark(diagnosticTaskId, "source_ready");

    if (!this.isPreparationCurrent(imageId, preparationRun, generation)) {
      return null;
    }

    const currentSourceUrl = this.resolveCurrentSourceUrl({ adapterId, image });
    if (currentSourceUrl !== sourceUrl) {
      return null;
    }

    entry.preparationStage = "hashing";
    entry.preparationMessage = "校验内容与缓存";
    entry.sourceProgress = null;
    this.renderImages();
    const imageHash = await buildImageContentHash(sourceBlob);
    this.diagnostics.mark(diagnosticTaskId, "hash_ready");
    if (!this.isPreparationCurrent(imageId, preparationRun, generation)) {
      return null;
    }

    return {
      adapterId,
      generation,
      image,
      imageId,
      imageHash,
      diagnosticTaskId,
      preparationRun,
      sourceBlob,
      sourceUrl
    };
  }

  private registerPreparedImage(preparedImage: PreparedDiscoveredImage): void {
    const {
      adapterId,
      generation,
      image,
      imageId,
      imageHash,
      diagnosticTaskId,
      preparationRun,
      sourceBlob,
      sourceUrl
    } = preparedImage;

    if (!this.isPreparationCurrent(imageId, preparationRun, generation)) {
      this.diagnostics.finish(diagnosticTaskId, "canceled");
      return;
    }

    const currentSourceUrl = this.resolveCurrentSourceUrl({ adapterId, image });
    if (currentSourceUrl !== sourceUrl) {
      this.diagnostics.finish(diagnosticTaskId, "canceled");
      return;
    }

    const signature = buildImageContentSignature(imageHash, this.settings);
    const entry = this.imageEntries.get(imageId);
    if (!entry) {
      this.diagnostics.finish(diagnosticTaskId, "canceled");
      return;
    }

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
        resultByteSize: 0,
        lastProgressRenderAt: -SOURCE_PROGRESS_RENDER_INTERVAL_MS
      };
      this.sharedTasks.set(signature, shared);
    } else if (diagnosticTaskId !== shared.diagnosticTaskId) {
      this.diagnostics.finish(diagnosticTaskId, "cache");
    }

    if (!shared.sourceImage || !shared.sourceImage.isConnected) {
      shared.sourceImage = image;
    }
    if (!shared.sourceBlob && shared.status !== "complete") {
      shared.sourceBlob = sourceBlob;
    }

    shared.imageIds.add(imageId);
    entry.shared = shared;
    entry.preparationStage = "ready";
    entry.preparationMessage = "已准备，等待翻译";
    entry.sourceProgress = null;
    entry.canRetryWithPixels = false;
    refreshImagePresentationState(image, entry.presentation, sourceUrl);
    if (!shared.activeTask && shared.status !== "complete") {
      this.enqueueSharedTask(shared);
    }
    this.renderImages();
  }

  private schedulePreparation(entry: ImageEntry): void {
    if (
      entry.shared ||
      entry.preparationPending ||
      entry.preparationController ||
      !entry.readyForPreparation ||
      entry.ignored ||
      entry.canceled
    ) {
      return;
    }
    entry.preparationPending = true;
    entry.preparationStage = "discovered";
    entry.preparationMessage = "等待读取原图";
    this.pendingPreparationIds.push(entry.id);
    this.drainDiscoveryPreparations();
  }

  private takeNextPreparation(): ImageEntry | null {
    let bestIndex = -1;
    let bestPriority = 3;
    for (let index = 0; index < this.pendingPreparationIds.length; index += 1) {
      const imageId = this.pendingPreparationIds[index];
      const entry = imageId ? this.imageEntries.get(imageId) : null;
      if (!entry || !entry.preparationPending || entry.shared || !entry.image.isConnected) {
        this.pendingPreparationIds.splice(index, 1);
        index -= 1;
        continue;
      }
      const priority = this.getCurrentPriority(entry);
      if (priority < bestPriority) {
        bestPriority = priority;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) {
      return null;
    }
    const [imageId] = this.pendingPreparationIds.splice(bestIndex, 1);
    return imageId ? this.imageEntries.get(imageId) ?? null : null;
  }

  private getCurrentPriority(entry: ImageEntry): 0 | 1 | 2 {
    const rect = entry.image.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return entry.priority;
    }
    if (rect.bottom >= 0 && rect.top <= window.innerHeight) {
      return 0;
    }
    if (rect.bottom >= -window.innerHeight && rect.top <= window.innerHeight * 2) {
      return 1;
    }
    return 2;
  }

  private scheduleStallCheck(imageId: string): void {
    const active = this.activePreparations.get(imageId);
    if (!active) {
      return;
    }
    if (active.stallTimer !== null) {
      window.clearTimeout(active.stallTimer);
    }
    active.stallTimer = window.setTimeout(() => {
      active.stalled = true;
      active.stallTimer = null;
      this.drainDiscoveryPreparations();
    }, SOURCE_STALL_BYPASS_MS);
  }

  /** Update byte progress and coalesce synchronous transport events with discovery feedback. */
  private handleSourceProgress(
    imageId: string,
    preparationRun: number,
    progress: ImageSourceProgress
  ): void {
    const entry = this.imageEntries.get(imageId);
    if (!entry || entry.preparationRun !== preparationRun) {
      return;
    }
    const active = this.activePreparations.get(imageId);
    if (active && progress.stage === "starting") {
      // Each transport/retry counts bytes from zero. Keep the existing stall
      // deadline until real bytes arrive, then measure progress on this attempt.
      active.lastLoadedBytes = 0;
    }
    if (active && progress.loadedBytes > active.lastLoadedBytes) {
      active.lastLoadedBytes = progress.loadedBytes;
      active.stalled = false;
      this.scheduleStallCheck(imageId);
    }

    const previousProgress = entry.sourceProgress;
    entry.sourceProgress = progress;
    entry.preparationStage = "reading-source";
    entry.preparationMessage = progress.stage === "retrying"
      ? "网络不稳定，自动重试 1 次"
      : progress.stage === "pixels"
        ? "从页面像素读取原图"
        : "读取原图";
    const stageChanged = previousProgress?.stage !== progress.stage ||
      previousProgress?.method !== progress.method;
    if (
      stageChanged ||
      progress.elapsedMs - entry.lastProgressRenderAt >= SOURCE_PROGRESS_RENDER_INTERVAL_MS
    ) {
      entry.lastProgressRenderAt = progress.elapsedMs;
      this.requestImageRender();
    }
  }

  private isPreparationCurrent(
    imageId: string,
    preparationRun: number,
    generation: number
  ): boolean {
    const entry = this.imageEntries.get(imageId);
    return Boolean(
      entry &&
      generation === this.generation &&
      entry.preparationRun === preparationRun &&
      this.enabled &&
      this.discoveryReady &&
      entry.image.isConnected
    );
  }

  private resolveCurrentSourceUrl(
    candidate: Pick<DiscoveredImageCandidate, "adapterId" | "image">
  ): string | null {
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
    shared.message = "等待翻译队列";
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
        shared.message = "等待翻译队列";
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
        shared.message = "准备上传原图";
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
        this.disposeSharedTaskIfOrphaned(shared);
      }
    });
  }

  private async resolveSourceBlob(shared: SourceBlobRequest, signal?: AbortSignal): Promise<Blob> {
    if (shared.sourceBlob) {
      return shared.sourceBlob;
    }

    const currentSource = shared.sourceImage?.currentSrc || shared.sourceImage?.src || "";
    const managedSource = shared.sourceImage
      ? getManagedImageSourceUrl(shared.sourceImage)
      : null;
    const sourceImage = currentSource.startsWith("blob:") && managedSource === shared.sourceUrl
      ? null
      : shared.sourceImage;
    const result = await this.sourceLoader.load({
      sourceUrl: shared.sourceUrl,
      image: sourceImage,
      signal,
      allowLargePixelFallback: shared.allowLargePixelFallback,
      onProgress: shared.onProgress
    });
    return result.blob;
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
      const now = performance.now();
      if (now - shared.lastProgressRenderAt >= SOURCE_PROGRESS_RENDER_INTERVAL_MS) {
        shared.lastProgressRenderAt = now;
        this.renderImages();
      }
    }
  }

  private applySettings(nextSettings: UserscriptSettings): void {
    this.settings = saveSettings(nextSettings);
    this.diagnostics.setEnabled(this.settings.performanceDiagnostics);
    this.refreshAdapterState();
    this.overlay.updateSettings(this.settings);
    this.overlay.updateAdapterStates(this.adapterStates);
    this.resetRuntimeState();
    this.enabled = this.settings.autoTranslateEnabled;
    this.discoveryReady = this.enabled;
    this.clearInitialAutoTranslateScan();
    this.rebuildDiscovery();
    // Raise above one only after the service explicitly recommends it.
    this.queue.setMaxConcurrency(1);
    if (this.enabled) {
      this.queue.resume();
      if (this.settings.streamEndpoint === "auto" || this.settings.maxConcurrency > 1) {
        void this.negotiateServiceCapacity();
      }
    } else {
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
    for (const active of this.activePreparations.values()) {
      if (active.stallTimer !== null) {
        window.clearTimeout(active.stallTimer);
      }
      active.controller.abort();
    }
    this.activePreparations.clear();
    this.pendingPreparationIds.length = 0;
    this.queue.reset("canceled");
    this.diagnostics.reset();
    this.preparedTaskQueued = 0;
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
      onImageEligible: (candidate) => this.handleDiscoveredImage(candidate),
      onImageRemoved: (image) => this.handleRemovedImage(image)
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
    this.cancelEntryPreparation(entry);
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
    this.cancelEntryPreparation(entry);
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

    if (!entry.shared) {
      this.restartPreparation(entry, false);
      return;
    }

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

  private retryImageWithPixels(id: string): void {
    const entry = this.imageEntries.get(id);
    if (!entry || entry.shared) {
      return;
    }
    entry.ignored = false;
    entry.canceled = false;
    this.restartPreparation(entry, true);
  }

  private restartPreparation(entry: ImageEntry, allowLargePixels: boolean): void {
    this.cancelEntryPreparation(entry);
    entry.allowLargePixelFallback = allowLargePixels;
    entry.canRetryWithPixels = false;
    entry.sourceProgress = null;
    entry.readyForPreparation = Boolean(
      entry.image.complete && entry.image.naturalWidth > 0 && entry.image.naturalHeight > 0
    );
    entry.preparationStage = entry.readyForPreparation ? "discovered" : "waiting-load";
    entry.preparationMessage = entry.readyForPreparation
      ? "等待重新读取原图"
      : "等待网页图片重新加载";
    this.renderImages();
    if (entry.readyForPreparation) {
      this.schedulePreparation(entry);
    }
  }

  private pauseSourcePreparations(): void {
    for (const entry of this.imageEntries.values()) {
      if (entry.shared || entry.ignored || entry.canceled || entry.preparationStage === "error") {
        continue;
      }
      entry.resumeAfterPause = entry.preparationPending || Boolean(entry.preparationController);
      this.cancelEntryPreparation(entry, true);
      entry.preparationStage = entry.readyForPreparation ? "discovered" : "waiting-load";
      entry.preparationMessage = "已暂停，恢复后继续读取";
    }
    this.renderImages();
  }

  private resumePausedPreparations(): void {
    for (const entry of this.imageEntries.values()) {
      if (!entry.resumeAfterPause || entry.shared || entry.ignored || entry.canceled) {
        continue;
      }
      entry.resumeAfterPause = false;
      entry.preparationMessage = entry.readyForPreparation ? "等待读取原图" : "等待网页图片加载";
      if (entry.readyForPreparation) {
        this.schedulePreparation(entry);
      }
    }
  }

  private cancelEntryPreparation(entry: ImageEntry, preserveResume = false): void {
    entry.preparationRun += 1;
    entry.preparationPending = false;
    for (let index = this.pendingPreparationIds.length - 1; index >= 0; index -= 1) {
      if (this.pendingPreparationIds[index] === entry.id) {
        this.pendingPreparationIds.splice(index, 1);
      }
    }
    entry.preparationController?.abort();
    entry.preparationController = null;
    if (!preserveResume) {
      entry.resumeAfterPause = false;
    }
  }

  private detachEntryFromShared(entry: ImageEntry, reason: CancelReason): void {
    const shared = entry.shared;
    if (!shared) {
      return;
    }
    shared.imageIds.delete(entry.id);
    entry.shared = null;
    this.cancelSharedTaskIfUnused(shared, reason);
  }

  private handleRemovedImage(image: HTMLImageElement): void {
    const imageId = this.imageIds.get(image);
    const entry = imageId ? this.imageEntries.get(imageId) : null;
    if (!imageId || !entry) {
      return;
    }
    this.cancelEntryPreparation(entry);
    this.detachEntryFromShared(entry, "canceled");
    releaseImagePresentation(entry.image, entry.presentation);
    this.imageEntries.delete(imageId);
    this.imageIds.delete(image);
    this.renderImages();
  }

  private cancelSharedTaskIfUnused(
    shared: SharedImageTask | null,
    reason: CancelReason
  ): void {
    if (!shared) {
      return;
    }
    for (const imageId of shared.imageIds) {
      const entry = this.imageEntries.get(imageId);
      if (entry && !entry.ignored && !entry.canceled) {
        return;
      }
    }
    if (shared.activeTask) {
      this.queue.cancel(shared.taskId, reason);
      return;
    }
    this.disposeSharedTaskIfOrphaned(shared);
  }

  private disposeSharedTaskIfOrphaned(shared: SharedImageTask): void {
    if (shared.activeTask || shared.imageIds.size > 0) {
      return;
    }
    if (shared.resultUrl) {
      URL.revokeObjectURL(shared.resultUrl);
      shared.resultUrl = null;
    }
    shared.sourceBlob = null;
    shared.sourceImage = null;
    if (this.sharedTasks.get(shared.signature) === shared) {
      this.sharedTasks.delete(shared.signature);
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
