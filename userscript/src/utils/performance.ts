/** Lightweight browser timing collector enabled explicitly from userscript settings. */

interface DiagnosticTask {
  startedAt: number;
  marks: Array<{ stage: string; elapsedMs: number }>;
  sourceBytes: number;
  uploadBytes: number;
  serverDiagnostics: Record<string, unknown> | null;
}

interface LongTaskSample {
  startTime: number;
  duration: number;
}

/** Collects opt-in per-image timing without retaining image pixels or blobs. */
export class BrowserPerformanceDiagnostics {
  private enabled: boolean;

  private readonly sessionId =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  private observer: PerformanceObserver | null = null;

  private readonly longTasks: LongTaskSample[] = [];

  private readonly tasks = new Map<string, DiagnosticTask>();

  /** Configure initial collection state from persisted userscript settings. */
  constructor(enabled: boolean) {
    this.enabled = enabled;
    this.configureObserver();
  }

  /** Enable or disable collection without retaining prior page samples. */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) {
      return;
    }
    this.enabled = enabled;
    this.tasks.clear();
    this.longTasks.length = 0;
    this.configureObserver();
  }

  /** Drop unfinished task records when the controller resets its generation. */
  reset(): void {
    this.tasks.clear();
    this.longTasks.length = 0;
  }

  /** Start timing one image task before source acquisition and hashing. */
  begin(taskId: string, sourceBytes: number): void {
    if (!this.enabled) {
      return;
    }
    this.tasks.set(taskId, {
      startedAt: performance.now(),
      marks: [],
      sourceBytes,
      uploadBytes: 0,
      serverDiagnostics: null
    });
  }

  /** Record a stage boundary relative to the task start. */
  mark(taskId: string, stage: string): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }
    task.marks.push({ stage, elapsedMs: performance.now() - task.startedAt });
  }

  /** Update byte accounting once source acquisition has completed. */
  setSourceBytes(taskId: string, sourceBytes: number): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.sourceBytes = sourceBytes;
    }
  }

  /** Account for bytes actually sent to the translation endpoint. */
  setUploadBytes(taskId: string, uploadBytes: number): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.uploadBytes = uploadBytes;
    }
  }

  /** Attach compact worker/Ollama diagnostics emitted by the local service. */
  setServerDiagnostics(taskId: string, diagnostics: Record<string, unknown>): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.serverDiagnostics = diagnostics;
    }
  }

  /** Emit one compact JSON record and release task-local samples. */
  finish(
    taskId: string,
    outcome: "complete" | "cache" | "error" | "canceled",
    resultBytes = 0
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }
    for (const entry of this.observer?.takeRecords() ?? []) {
      this.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
    }
    const finishedAt = performance.now();
    const longTasks = this.longTasks.filter(
      (sample) =>
        sample.startTime + sample.duration >= task.startedAt && sample.startTime <= finishedAt
    );
    console.info("[mit-performance]", JSON.stringify({
      sessionId: this.sessionId,
      taskId,
      outcome,
      startedAt: task.startedAt,
      finishedAt,
      totalMs: finishedAt - task.startedAt,
      mainThreadLongTaskMs: longTasks.reduce((sum, sample) => sum + sample.duration, 0),
      mainThreadLongTaskCount: longTasks.length,
      sourceBytes: task.sourceBytes,
      uploadBytes: task.uploadBytes,
      downloadBytes: resultBytes,
      marks: task.marks,
      serverDiagnostics: task.serverDiagnostics
    }));
    this.tasks.delete(taskId);
    this.pruneLongTasks();
  }

  private configureObserver(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (!this.enabled || typeof PerformanceObserver === "undefined") {
      return;
    }
    try {
      this.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
        }
      });
      this.observer.observe({ type: "longtask", buffered: true });
    } catch {
      // Firefox and older WebViews do not expose the Long Tasks API. Stage
      // timing remains available without it.
      this.observer = null;
    }
  }

  /** Retain only samples that can still overlap an unfinished task. */
  private pruneLongTasks(): void {
    const oldestActiveStart = Math.min(
      ...Array.from(this.tasks.values(), (task) => task.startedAt),
      performance.now()
    );
    const firstRelevant = this.longTasks.findIndex(
      (sample) => sample.startTime + sample.duration >= oldestActiveStart
    );
    if (firstRelevant < 0) {
      this.longTasks.length = 0;
    } else if (firstRelevant > 0) {
      this.longTasks.splice(0, firstRelevant);
    }
  }
}
