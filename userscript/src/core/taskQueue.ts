import type { QueueStats } from "../types";

/** User-visible reason for ending queued or running work. */
export type CancelReason = "canceled" | "ignored";

/** One abortable unit managed by the bounded browser queue. */
export interface QueueTask {
  id: string;
  run: (signal: AbortSignal) => Promise<void>;
  onQueued?: () => void;
  onStart?: () => void;
  onSuccess?: () => void;
  onError?: (error: Error) => void;
  onCancel?: (reason: CancelReason) => void;
}

interface QueueTaskRecord extends QueueTask {
  status: "queued" | "running" | "completed" | "error" | "ignored" | "canceled";
  controller: AbortController | null;
  cancelReason: CancelReason | null;
}

interface TaskQueueOptions {
  maxConcurrency: number;
  paused?: boolean;
  onStatsChange?: (stats: QueueStats) => void;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Small FIFO queue with bounded concurrency and abort-aware terminal states. */
export class TaskQueue {
  private readonly tasks = new Map<string, QueueTaskRecord>();

  private readonly pendingOrder: string[] = [];

  private readonly onStatsChange?: (stats: QueueStats) => void;

  private maxConcurrency: number;

  private paused: boolean;

  constructor(options: TaskQueueOptions) {
    this.maxConcurrency = Math.max(1, options.maxConcurrency);
    this.paused = Boolean(options.paused);
    this.onStatsChange = options.onStatsChange;
  }

  /** Add a new task or replace a terminal record when the user retries it. */
  enqueue(task: QueueTask): void {
    const existing = this.tasks.get(task.id);
    if (existing) {
      if (existing.status === "queued" || existing.status === "running") {
        return;
      }
      this.tasks.delete(task.id);
    }

    const record: QueueTaskRecord = {
      ...task,
      status: "queued",
      controller: null,
      cancelReason: null
    };

    this.tasks.set(task.id, record);
    this.pendingOrder.push(task.id);
    task.onQueued?.();
    this.emitStats();
    this.drain();
  }

  /** Pause admission of queued tasks without canceling running work. */
  pause(): void {
    this.paused = true;
  }

  /** Resume queued task admission. */
  resume(): void {
    this.paused = false;
    this.drain();
  }

  /** Cancel every queued or running task while retaining terminal statistics. */
  clear(reason: CancelReason = "canceled"): void {
    for (const taskId of [...this.pendingOrder]) {
      this.cancel(taskId, reason);
    }
    for (const record of this.tasks.values()) {
      if (record.status === "running") {
        this.cancel(record.id, reason);
      }
    }
  }

  /** Cancel tasks and discard all queue history. */
  reset(reason: CancelReason = "canceled"): void {
    this.clear(reason);
    this.pendingOrder.length = 0;
    this.tasks.clear();
    this.emitStats();
  }

  /** Cancel one task by identifier. */
  cancel(taskId: string, reason: CancelReason = "canceled"): void {
    const record = this.tasks.get(taskId);
    if (!record) {
      return;
    }

    record.cancelReason = reason;

    if (record.status === "queued") {
      const pendingIndex = this.pendingOrder.indexOf(taskId);
      if (pendingIndex >= 0) {
        this.pendingOrder.splice(pendingIndex, 1);
      }
      record.status = reason;
      record.onCancel?.(reason);
      this.emitStats();
      return;
    }

    if (record.status === "running") {
      record.controller?.abort();
    }
  }

  /** Change the admission limit for future queue drains. */
  setMaxConcurrency(maxConcurrency: number): void {
    this.maxConcurrency = Math.max(1, maxConcurrency);
    this.drain();
  }

  /** Return a snapshot of queue state counters. */
  getStats(): QueueStats {
    let queued = 0;
    let running = 0;
    let completed = 0;
    let errors = 0;
    let ignored = 0;

    for (const record of this.tasks.values()) {
      switch (record.status) {
        case "queued":
          queued += 1;
          break;
        case "running":
          running += 1;
          break;
        case "completed":
          completed += 1;
          break;
        case "error":
          errors += 1;
          break;
        case "ignored":
          ignored += 1;
          break;
        default:
          break;
      }
    }

    return { queued, running, completed, errors, ignored };
  }

  private emitStats(): void {
    this.onStatsChange?.(this.getStats());
  }

  private drain(): void {
    if (this.paused) {
      return;
    }

    while (this.getRunningCount() < this.maxConcurrency && this.pendingOrder.length > 0) {
      const taskId = this.pendingOrder.shift();
      if (!taskId) {
        continue;
      }
      const record = this.tasks.get(taskId);
      if (!record || record.status !== "queued") {
        continue;
      }
      this.startTask(record);
    }
  }

  private getRunningCount(): number {
    let running = 0;
    for (const record of this.tasks.values()) {
      if (record.status === "running") {
        running += 1;
      }
    }
    return running;
  }

  private startTask(record: QueueTaskRecord): void {
    const controller = new AbortController();
    record.controller = controller;
    record.status = "running";
    record.onStart?.();
    this.emitStats();

    void record
      .run(controller.signal)
      .then(() => {
        if (record.cancelReason) {
          record.status = record.cancelReason;
          record.onCancel?.(record.cancelReason);
          return;
        }
        record.status = "completed";
        record.onSuccess?.();
      })
      .catch((error: unknown) => {
        if (record.cancelReason || isAbortError(error)) {
          const reason = record.cancelReason ?? "canceled";
          record.status = reason;
          record.onCancel?.(reason);
          return;
        }

        record.status = "error";
        record.onError?.(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        record.controller = null;
        this.emitStats();
        this.drain();
      });
  }
}
