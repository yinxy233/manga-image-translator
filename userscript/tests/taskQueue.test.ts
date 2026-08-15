import { describe, expect, it, vi } from "vitest";

import { TaskQueue } from "../src/core/taskQueue";

describe("TaskQueue", () => {
  it("limits concurrency and resumes queued work", async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => {
      throw new Error("The first task did not start.");
    };

    const queue = new TaskQueue({ maxConcurrency: 1 });
    queue.resume();

    queue.enqueue({
      id: "first",
      run: async () =>
        new Promise<void>((resolve) => {
          order.push("first:start");
          releaseFirst = () => {
            order.push("first:end");
            resolve();
          };
        })
    });

    queue.enqueue({
      id: "second",
      run: async () => {
        order.push("second:start");
      }
    });

    await vi.waitFor(() => {
      expect(order).toEqual(["first:start"]);
    });

    releaseFirst();

    await vi.waitFor(() => {
      expect(order).toEqual(["first:start", "first:end", "second:start"]);
    });
  });

  it("cancels queued tasks without running them", () => {
    const onCancel = vi.fn();
    const queue = new TaskQueue({ maxConcurrency: 1, paused: true });

    queue.enqueue({
      id: "queued-task",
      run: async () => undefined,
      onCancel
    });
    queue.cancel("queued-task", "ignored");

    expect(onCancel).toHaveBeenCalledWith("ignored");
    expect(queue.getStats().ignored).toBe(1);
  });

  it("settles cancellation when running work resolves after abort", async () => {
    const onCancel = vi.fn();
    let finish: () => void = () => {
      throw new Error("The task did not start.");
    };
    const queue = new TaskQueue({ maxConcurrency: 1 });

    queue.enqueue({
      id: "running-task",
      run: async () => new Promise<void>((resolve) => {
        finish = resolve;
      }),
      onCancel
    });
    queue.cancel("running-task", "canceled");
    finish();

    await vi.waitFor(() => {
      expect(onCancel).toHaveBeenCalledWith("canceled");
      expect(queue.getStats().running).toBe(0);
    });
  });

  it("keeps cancellation terminal when an aborted transport rejects generically", async () => {
    const onCancel = vi.fn();
    const onError = vi.fn();
    let fail: (error: Error) => void = () => {
      throw new Error("The task did not start.");
    };
    const queue = new TaskQueue({ maxConcurrency: 1 });

    queue.enqueue({
      id: "generic-abort-error",
      run: async () => new Promise<void>((_resolve, reject) => {
        fail = reject;
      }),
      onCancel,
      onError
    });
    queue.cancel("generic-abort-error", "canceled");
    fail(new Error("GM request aborted"));

    await vi.waitFor(() => {
      expect(onCancel).toHaveBeenCalledWith("canceled");
      expect(onError).not.toHaveBeenCalled();
      expect(queue.getStats().errors).toBe(0);
    });
  });
});
