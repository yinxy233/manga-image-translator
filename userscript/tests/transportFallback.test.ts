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
});
