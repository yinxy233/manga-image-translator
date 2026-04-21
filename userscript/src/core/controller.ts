import { PROGRESS_TEXT_MAP } from "../config";
import { loadSettings, saveSettings } from "../storage";
import type {
  ConnectionState,
  OverlayViewModel,
  QueueStats,
  SharedTaskStatus,
  TranslationEvent,
  UserscriptSettings
} from "../types";
import { buildImageSignature } from "../utils/signature";
import { HttpStatusError, TransportClient } from "../utils/transport";
import { ImageDiscovery, getImageSource } from "./imageDiscovery";
import { OverlayManager } from "./overlayManager";
import { type CancelReason, TaskQueue } from "./taskQueue";

interface SharedImageTask {
  signature: string;
  sourceUrl: string;
  taskId: string;
  imageIds: Set<string>;
  resultUrl: string | null;
  status: SharedTaskStatus;
  message: string;
  queuePosition: string | null;
  activeTask: boolean;
}

interface ImageEntry {
  id: string;
  image: HTMLImageElement;
  shared: SharedImageTask;
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
  private readonly transport = new TransportClient();

  private readonly discovery: ImageDiscovery;

  private readonly overlay: OverlayManager;

  private readonly queue: TaskQueue;

  private settings = loadSettings();

  private enabled = this.settings.autoTranslateEnabled;

  private globalShowOriginal = false;

  private connection = createConnectionState("尚未连接服务器");

  private queueStats = createQueueStats();

  private imageSequence = 0;

  private generation = 0;

  private imageIds = new WeakMap<HTMLImageElement, string>();

  private readonly imageEntries = new Map<string, ImageEntry>();

  private readonly sharedTasks = new Map<string, SharedImageTask>();

  constructor() {
    this.queue = new TaskQueue({
      maxConcurrency: this.settings.maxConcurrency,
      paused: !this.enabled,
      onStatsChange: (stats) => {
        this.queueStats = stats;
        this.renderChrome();
      }
    });

    this.overlay = new OverlayManager(this.settings, {
      onToggleSession: () => this.toggleSession(),
      onToggleGlobalOriginal: () => this.toggleGlobalOriginal(),
      onTestConnection: () => {
        void this.testConnection();
      },
      onSaveSettings: (settings) => this.applySettings(settings),
      onToggleImageOriginal: (id) => this.toggleImageOriginal(id),
      onRetryImage: (id) => this.retryImage(id),
      onCancelImage: (id) => this.cancelImage(id),
      onIgnoreImage: (id) => this.ignoreImage(id)
    });

    this.discovery = new ImageDiscovery({
      onImageEligible: (image) => this.handleDiscoveredImage(image)
    });
    this.discovery.start();

    if (this.enabled) {
      this.discovery.rescan();
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

      models.push({
        id: entry.id,
        image: entry.image,
        status,
        message,
        resultUrl: entry.shared.resultUrl,
        showOriginal: this.globalShowOriginal || entry.showOriginal,
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
      this.queue.resume();
      this.discovery.reset();
      this.discovery.rescan();
      this.overlay.toast("已启动本页自动翻译。", "neutral");
    } else {
      this.queue.pause();
      this.overlay.toast("已暂停新任务排队。正在处理的任务会继续完成。", "neutral");
    }
    this.renderChrome();
  }

  private toggleGlobalOriginal(): void {
    this.globalShowOriginal = !this.globalShowOriginal;
    this.renderChrome();
    this.renderImages();
  }

  private handleDiscoveredImage(image: HTMLImageElement): void {
    if (!this.enabled) {
      return;
    }

    const sourceUrl = getImageSource(image);
    if (!sourceUrl) {
      return;
    }

    const signature = buildImageSignature(sourceUrl, this.settings);
    const existingId = this.imageIds.get(image);
    if (existingId) {
      const existingEntry = this.imageEntries.get(existingId);
      if (existingEntry?.shared.signature === signature) {
        return;
      }
      if (existingEntry) {
        existingEntry.shared.imageIds.delete(existingId);
        this.imageEntries.delete(existingId);
      }
    }

    const imageId = existingId ?? `mit-image-${++this.imageSequence}`;
    this.imageIds.set(image, imageId);

    let shared = this.sharedTasks.get(signature);
    if (!shared) {
      shared = {
        signature,
        sourceUrl,
        taskId: `mit-task-${signature}`,
        imageIds: new Set<string>(),
        resultUrl: null,
        status: "queued",
        message: "等待加入队列",
        queuePosition: null,
        activeTask: false
      };
      this.sharedTasks.set(signature, shared);
      this.enqueueSharedTask(shared);
    }

    shared.imageIds.add(imageId);
    this.imageEntries.set(imageId, {
      id: imageId,
      image,
      shared,
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
    shared.message = "等待抓取原图";
    shared.queuePosition = null;

    const generation = this.generation;
    this.queue.enqueue({
      id: shared.taskId,
      onQueued: () => {
        if (generation !== this.generation) {
          return;
        }
        shared.status = "queued";
        shared.message = "等待抓取原图";
        this.renderImages();
      },
      onStart: () => {
        if (generation !== this.generation) {
          return;
        }
        shared.status = "processing";
        shared.message = "抓取原图";
        this.renderImages();
      },
      run: async (signal) => {
        const sourceBlob = await this.transport.fetchImageBlob(shared.sourceUrl, signal);
        if (generation !== this.generation) {
          return;
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
        shared.message = "翻译完成";
        shared.queuePosition = null;
        this.connection = createConnectionState("翻译服务已响应", "success");
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
    this.overlay.updateSettings(this.settings);
    this.resetRuntimeState();
    this.queue.setMaxConcurrency(this.settings.maxConcurrency);
    this.enabled = this.settings.autoTranslateEnabled;
    if (this.enabled) {
      this.queue.resume();
      this.discovery.rescan();
    } else {
      this.queue.pause();
    }
    this.overlay.toast("设置已保存。后续任务将使用新配置。", "neutral");
    this.renderChrome();
  }

  private resetRuntimeState(): void {
    this.generation += 1;
    this.queue.reset("canceled");
    for (const shared of this.sharedTasks.values()) {
      if (shared.resultUrl) {
        URL.revokeObjectURL(shared.resultUrl);
      }
    }
    this.imageEntries.clear();
    this.sharedTasks.clear();
    this.imageIds = new WeakMap<HTMLImageElement, string>();
    this.discovery.reset();
    this.renderImages();
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
