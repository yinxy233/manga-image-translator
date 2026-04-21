import type { QueueStats } from "../types";

export type CancelReason = "canceled" | "ignored";

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

  enqueue(task: QueueTask): void {
    if (this.tasks.has(task.id)) {
      return;
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

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.drain();
  }

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

  reset(reason: CancelReason = "canceled"): void {
    this.clear(reason);
    this.pendingOrder.length = 0;
    this.tasks.clear();
    this.emitStats();
  }

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

  setMaxConcurrency(maxConcurrency: number): void {
    this.maxConcurrency = Math.max(1, maxConcurrency);
    this.drain();
  }

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
          return;
        }
        record.status = "completed";
        record.onSuccess?.();
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) {
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
