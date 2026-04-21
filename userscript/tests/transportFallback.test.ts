import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "../src/config";
import { TransportClient } from "../src/utils/transport";

function createFrame(code: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = code;
  new DataView(frame.buffer).setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
}

function createStreamResponse(): ReadableStream<Uint8Array> {
  const pngBytes = new Uint8Array([137, 80, 78, 71]);
  const frame = createFrame(0, pngBytes);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(frame);
      controller.close();
    }
  });
}

describe("TransportClient", () => {
  it("falls back to GM transport when fetch upload fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    const gmRequest = vi.fn(
      ((details: GMRequestDetails<ReadableStream<Uint8Array>>) => {
        queueMicrotask(() => {
          details.onloadstart?.({
            status: 200,
            response: createStreamResponse()
          });
        });
        return {
          abort: vi.fn()
        };
      }) as unknown as (details: GMRequestDetails<unknown>) => GMRequestHandle
    );

    const transport = new TransportClient({ fetchImpl, gmRequest });
    const result = await transport.translateImage({
      imageBlob: new Blob(["test"], { type: "image/png" }),
      fileName: "page.png",
      settings: DEFAULT_SETTINGS,
      onEvent: vi.fn()
    });

    expect(result).toBeInstanceOf(Blob);
    expect(gmRequest).toHaveBeenCalledTimes(1);
  });

  it("falls back to GM blob mode when GM stream is unavailable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    const onEvent = vi.fn();
    const gmRequest = vi.fn(
      ((details: GMRequestDetails<ReadableStream<Uint8Array> | Blob>) => {
        queueMicrotask(() => {
          if (details.responseType === "stream") {
            details.onloadstart?.({
              status: 200,
              response: new Blob(["not-a-stream"], { type: "application/octet-stream" })
            });
            return;
          }

          details.onload?.({
            status: 200,
            response: new Blob(["png-binary"], { type: "image/png" })
          });
        });

        return {
          abort: vi.fn()
        };
      }) as unknown as (details: GMRequestDetails<unknown>) => GMRequestHandle
    );

    const transport = new TransportClient({ fetchImpl, gmRequest });
    const result = await transport.translateImage({
      imageBlob: new Blob(["test"], { type: "image/png" }),
      fileName: "page.png",
      settings: DEFAULT_SETTINGS,
      onEvent
    });

    expect(result).toBeInstanceOf(Blob);
    expect(onEvent).toHaveBeenCalledWith({
      code: 1,
      payload: new Uint8Array(),
      text: "兼容模式：等待完整结果"
    });
    expect(gmRequest).toHaveBeenCalledTimes(2);
    expect(gmRequest.mock.calls[0]?.[0]?.responseType).toBe("stream");
    expect(gmRequest.mock.calls[1]?.[0]?.responseType).toBe("blob");
  });
});
