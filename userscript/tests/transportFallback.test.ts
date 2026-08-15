import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "../src/config";
import { TransportClient } from "../src/utils/transport";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+g5XsAAAAASUVORK5CYII=";
const PNG_BYTES = Uint8Array.from(Buffer.from(PNG_BASE64, "base64"));
const STANDARD_SETTINGS = { ...DEFAULT_SETTINGS, streamEndpoint: "standard" as const };

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

function createFastPathStreamResponse(folderName: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const progressFrame = createFrame(1, encoder.encode(`final_ready:${folderName}`));
  const placeholderFrame = createFrame(0, PNG_BYTES);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(progressFrame);
      controller.enqueue(placeholderFrame);
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
      settings: STANDARD_SETTINGS,
      onEvent: vi.fn()
    });

    expect(result).toBeInstanceOf(Blob);
    expect(gmRequest).toHaveBeenCalledTimes(1);
  });

  it("does not resubmit after the service has accepted a translation", async () => {
    const encoder = new TextEncoder();
    let emittedProgress = false;
    const acceptedThenBroken = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!emittedProgress) {
          emittedProgress = true;
          controller.enqueue(createFrame(1, encoder.encode("detection")));
          return;
        }
        controller.error(new Error("connection closed"));
      }
    });
    const fetchImpl = vi.fn(async () => new Response(acceptedThenBroken, { status: 200 }));
    const gmRequest = vi.fn();
    const transport = new TransportClient({
      fetchImpl,
      gmRequest: gmRequest as unknown as (details: GMRequestDetails<unknown>) => GMRequestHandle
    });

    await expect(transport.translateImage({
      imageBlob: new Blob(["test"], { type: "image/png" }),
      fileName: "page.png",
      settings: STANDARD_SETTINGS,
      onEvent: vi.fn()
    })).rejects.toThrow("connection closed");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(gmRequest).not.toHaveBeenCalled();
  });

  it("parses the same accepted fetch response when streaming is unavailable", async () => {
    const terminalFrame = createFrame(0, PNG_BYTES);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: null,
      arrayBuffer: async () => terminalFrame.buffer
    }) as Response);
    const gmRequest = vi.fn();
    const transport = new TransportClient({
      fetchImpl,
      gmRequest: gmRequest as unknown as (details: GMRequestDetails<unknown>) => GMRequestHandle
    });

    const result = await transport.translateImage({
      imageBlob: new Blob(["test"], { type: "image/png" }),
      fileName: "page.png",
      settings: STANDARD_SETTINGS,
      onEvent: vi.fn()
    });

    expect(result.type).toBe("image/png");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(gmRequest).not.toHaveBeenCalled();
  });

  it("parses one buffered GM request when streaming is unavailable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    const onEvent = vi.fn();
    const gmRequest = vi.fn(
      ((details: GMRequestDetails<ReadableStream<Uint8Array> | ArrayBuffer>) => {
        queueMicrotask(() => {
          const bufferedFrame = createFrame(0, PNG_BYTES);
          const bufferedFrames = bufferedFrame.buffer as ArrayBuffer;
          details.onloadstart?.({
            status: 200,
            response: bufferedFrames
          });
          details.onload?.({
            status: 200,
            response: bufferedFrames
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
      settings: STANDARD_SETTINGS,
      onEvent
    });

    expect(result).toBeInstanceOf(Blob);
    expect(result.type).toBe("image/png");
    expect(onEvent).not.toHaveBeenCalled();
    expect(gmRequest).toHaveBeenCalledTimes(1);
    expect(gmRequest.mock.calls[0]?.[0]?.responseType).toBe("stream");
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
      streamEndpoint: "standard" as const,
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
    expect(requestUrl).not.toContain("/translate/image/stream/web");
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

  it("uses the explicitly selected standard multipart stream endpoint", async () => {
    const fetchImpl = vi.fn(async () => new Response(createStreamResponse(), { status: 200 }));
    const transport = new TransportClient({
      fetchImpl,
      gmRequest: vi.fn() as unknown as (details: GMRequestDetails<unknown>) => GMRequestHandle
    });

    const result = await transport.translateImage({
      imageBlob: new Blob(["test-image"], { type: "image/png" }),
      fileName: "page.png",
      settings: STANDARD_SETTINGS,
      onEvent: vi.fn()
    });

    const requestUrls = (
      fetchImpl.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit?]>
    ).map((call) => String(call[0]));

    expect(result).toBeInstanceOf(Blob);
    expect(requestUrls).toHaveLength(1);
    expect(requestUrls[0]).toContain("/translate/with-form/image/stream");
    expect(requestUrls[0]).not.toContain("/translate/with-form/image/stream/web");
  });

  it("loads the web fast-path final image after final_ready progress", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/result/")) {
        return new Response(PNG_BYTES, {
          status: 200,
          headers: { "Content-Type": "image/png" }
        });
      }
      return new Response(createFastPathStreamResponse("folder 1"), { status: 200 });
    });
    const gmRequest = vi.fn();
    const onEvent = vi.fn();

    const transport = new TransportClient({
      fetchImpl,
      gmRequest: gmRequest as unknown as (details: GMRequestDetails<unknown>) => GMRequestHandle
    });

    const result = await transport.translateImage({
      imageBlob: new Blob(["test-image"], { type: "image/png" }),
      fileName: "page.png",
      settings: {
        ...DEFAULT_SETTINGS,
        streamEndpoint: "web-fast"
      },
      onEvent
    });

    const requestUrls = fetchImpl.mock.calls.map((call) => String(call[0]));

    expect(result).toBeInstanceOf(Blob);
    expect(result.size).toBe(PNG_BYTES.length);
    expect(requestUrls[0]).toContain("/translate/with-form/image/stream/web");
    expect(requestUrls[1]).toContain("/result/folder%201/final.png");
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0]?.[0]).toMatchObject({
      code: 1,
      text: "final_ready:folder 1"
    });
    expect(gmRequest).not.toHaveBeenCalled();
  });

  it("returns the final image without waiting for the progress stream to close", async () => {
    const encoder = new TextEncoder();
    const neverClosedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(createFrame(1, encoder.encode("final_ready:ready-now")));
      }
    });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/result/")) {
        return new Response(PNG_BYTES, {
          status: 200,
          headers: { "Content-Type": "image/png" }
        });
      }
      return new Response(neverClosedStream, { status: 200 });
    });
    const transport = new TransportClient({
      fetchImpl,
      gmRequest: vi.fn() as unknown as (details: GMRequestDetails<unknown>) => GMRequestHandle
    });

    const result = await transport.translateImage({
      imageBlob: new Blob(["test-image"], { type: "image/png" }),
      fileName: "page.png",
      settings: { ...DEFAULT_SETTINGS, streamEndpoint: "web-fast" },
      onEvent: vi.fn()
    });

    expect(result.size).toBe(PNG_BYTES.length);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("uses the web fast-path JSON endpoint when configured", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/result/")) {
        return new Response(PNG_BYTES, {
          status: 200,
          headers: { "Content-Type": "image/png" }
        });
      }
      return new Response(createFastPathStreamResponse("json folder"), { status: 200 });
    });
    const transport = new TransportClient({
      fetchImpl,
      gmRequest: vi.fn() as unknown as (details: GMRequestDetails<unknown>) => GMRequestHandle
    });

    const result = await transport.translateImage({
      imageBlob: new Blob(["test-image"], { type: "image/png" }),
      fileName: "page.png",
      settings: {
        ...DEFAULT_SETTINGS,
        uploadTransport: "base64-json",
        streamEndpoint: "web-fast"
      },
      onEvent: vi.fn()
    });

    const requestUrls = fetchImpl.mock.calls.map((call) => String(call[0]));

    expect(result).toBeInstanceOf(Blob);
    expect(requestUrls[0]).toContain("/translate/image/stream/web");
    expect(requestUrls[1]).toContain("/result/json%20folder/final.png");
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
      settings: STANDARD_SETTINGS,
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

  it("automatically negotiates the web fast path from health capabilities", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response(
          JSON.stringify({
            status: "ok",
            version: "test",
            queue_size: 0,
            capabilities: { web_result_fastpath: true }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/result/")) {
        return new Response(PNG_BYTES, { status: 200, headers: { "Content-Type": "image/png" } });
      }
      return new Response(createFastPathStreamResponse("auto-folder"), { status: 200 });
    });
    const transport = new TransportClient({
      fetchImpl,
      gmRequest: vi.fn() as unknown as (details: GMRequestDetails<unknown>) => GMRequestHandle
    });

    await transport.translateImage({
      imageBlob: new Blob(["test-image"], { type: "image/png" }),
      fileName: "page.png",
      settings: DEFAULT_SETTINGS,
      onEvent: vi.fn()
    });

    const requestUrls = fetchImpl.mock.calls.map((call) => String(call[0]));
    expect(requestUrls[0]).toContain("/health");
    expect(requestUrls[1]).toContain("/translate/with-form/image/stream/web");
  });
});
