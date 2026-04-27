import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "../src/config";
import { TransportClient } from "../src/utils/transport";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+g5XsAAAAASUVORK5CYII=";
const PNG_BYTES = Uint8Array.from(Buffer.from(PNG_BASE64, "base64"));

function createPngBlob(type = "image/png"): Blob {
  return new Blob([PNG_BYTES], { type });
}

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
  it("fetches cross-origin images without credentials to avoid wildcard ACAO conflicts", async () => {
    const fetchImpl = vi.fn(async () => new Response(createPngBlob(), { status: 200 }));
    const transport = new TransportClient({
      fetchImpl,
      gmRequest: vi.fn() as unknown as (details: GMRequestDetails<unknown>) => GMRequestHandle
    });

    const imageBlob = await transport.fetchImageBlob(
      "https://zek6.mrawx.cyou/manga/example/01.webp"
    );

    const requestInit = (fetchImpl.mock.calls as unknown[][])[0]?.[1] as RequestInit | undefined;

    expect(imageBlob).toBeInstanceOf(Blob);
    expect(requestInit?.credentials).toBe("omit");
  });

  it("keeps same-origin image fetches on the browser credential policy", async () => {
    const fetchImpl = vi.fn(async () => new Response(createPngBlob(), { status: 200 }));
    const transport = new TransportClient({
      fetchImpl,
      gmRequest: vi.fn() as unknown as (details: GMRequestDetails<unknown>) => GMRequestHandle
    });

    const imageBlob = await transport.fetchImageBlob(
      `${window.location.origin}/assets/page.png`
    );

    const requestInit = (fetchImpl.mock.calls as unknown[][])[0]?.[1] as RequestInit | undefined;

    expect(imageBlob).toBeInstanceOf(Blob);
    expect(requestInit?.credentials).toBe("same-origin");
  });

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
            response: createPngBlob("application/octet-stream")
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
    expect(result.type).toBe("image/png");
    expect(onEvent).toHaveBeenCalledWith({
      code: 1,
      payload: new Uint8Array(),
      text: "兼容模式：等待完整结果"
    });
    expect(gmRequest).toHaveBeenCalledTimes(2);
    expect(gmRequest.mock.calls[0]?.[0]?.responseType).toBe("stream");
    expect(gmRequest.mock.calls[1]?.[0]?.responseType).toBe("blob");
  });

  it("uses base64 JSON transport when configured", async () => {
    const fetchImpl = vi.fn(async () => new Response(createStreamResponse(), { status: 200 }));
    const gmRequest = vi.fn();

    const transport = new TransportClient({
      fetchImpl,
      gmRequest: gmRequest as unknown as (details: GMRequestDetails<unknown>) => GMRequestHandle
    });

    const settings = {
      ...DEFAULT_SETTINGS,
      uploadTransport: "base64-json" as const,
      detector: "ctd" as const,
      detectionSize: 1664,
      boxThreshold: 0.45,
      unclipRatio: 2.7,
      renderDirection: "vertical" as const,
      inpainter: "lama_mpe" as const,
      inpaintingSize: 1536,
      maskDilationOffset: 18
    };

    const result = await transport.translateImage({
      imageBlob: new Blob(["test-image"], { type: "image/png" }),
      fileName: "page.png",
      settings,
      onEvent: vi.fn()
    });

    const firstCall = fetchImpl.mock.calls[0] as unknown[] | undefined;
    const requestUrl = String(firstCall?.[0] ?? "");
    const requestInit = (firstCall?.[1] ?? {}) as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      image: string;
      config: {
        detector: {
          detector: string;
          detection_size: number;
          box_threshold: number;
          unclip_ratio: number;
        };
        render: {
          direction: string;
        };
        translator: {
          target_lang: string;
        };
        inpainter: {
          inpainter: string;
          inpainting_size: number;
        };
        mask_dilation_offset: number;
      };
    };

    expect(result).toBeInstanceOf(Blob);
    expect(requestUrl).toContain("/translate/image/stream");
    expect(requestInit.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(body.image.startsWith("data:image/png;base64,")).toBe(true);
    expect(body.config.translator.target_lang).toBe("CHS");
    expect(body.config.detector).toMatchObject({
      detector: "ctd",
      detection_size: 1664,
      box_threshold: 0.45,
      unclip_ratio: 2.7
    });
    expect(body.config.render.direction).toBe("vertical");
    expect(body.config.inpainter).toMatchObject({
      inpainter: "lama_mpe",
      inpainting_size: 1536
    });
    expect(body.config.mask_dilation_offset).toBe(18);
    expect(gmRequest).not.toHaveBeenCalled();
  });

  it("serializes GM uploads as explicit multipart payloads", async () => {
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
    await transport.translateImage({
      imageBlob: new Blob(["test-image"], { type: "image/png" }),
      fileName: "page.png",
      settings: DEFAULT_SETTINGS,
      onEvent: vi.fn()
    });

    const firstRequest = gmRequest.mock.calls[0]?.[0];
    const contentType = firstRequest?.headers?.["Content-Type"] ?? "";
    const payload = firstRequest?.data as ArrayBuffer;
    const boundary = contentType.match(/boundary=(.+)$/)?.[1] ?? "";
    const payloadText = new TextDecoder().decode(new Uint8Array(payload));

    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(payload).toBeInstanceOf(ArrayBuffer);
    expect(firstRequest?.data).not.toBeInstanceOf(FormData);
    expect(payload.byteLength).toBeGreaterThan("test-image".length);
    expect(payloadText.startsWith(`--${boundary}\r\n`)).toBe(true);
    expect(payloadText).toContain('name="image"');
    expect(payloadText).toContain('name="config"');
  });
});
