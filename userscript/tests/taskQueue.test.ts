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

  it("reorders queued tasks when a later task gets a higher priority", async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => {
      throw new Error("The first task did not start.");
    };

    const queue = new TaskQueue({ maxConcurrency: 1 });
    queue.resume();

    queue.enqueue({
      id: "first",
      priority: 10,
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
      priority: 10,
      run: async () => {
        order.push("second:start");
      }
    });

    queue.enqueue({
      id: "third",
      priority: 1,
      run: async () => {
        order.push("third:start");
      }
    });

    queue.setPriority("third", 100);

    await vi.waitFor(() => {
      expect(order).toEqual(["first:start"]);
    });

    releaseFirst();

    await vi.waitFor(() => {
      expect(order).toEqual(["first:start", "first:end", "third:start", "second:start"]);
    });
  });
});
