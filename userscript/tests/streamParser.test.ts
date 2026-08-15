import { describe, expect, it } from "vitest";

import { decodeFrameText, StreamFrameParser } from "../src/utils/stream";

function createFrame(code: number, text: string): Uint8Array {
  const payload = new TextEncoder().encode(text);
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = code;
  new DataView(frame.buffer).setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
}

describe("StreamFrameParser", () => {
  it("parses sticky packets", () => {
    const parser = new StreamFrameParser();
    const chunk = new Uint8Array([...createFrame(1, "ocr"), ...createFrame(3, "2")]);
    const frames = parser.push(chunk);

    expect(frames).toHaveLength(2);
    expect(decodeFrameText(frames[0].data)).toBe("ocr");
    expect(decodeFrameText(frames[1].data)).toBe("2");
  });

  it("handles split packets", () => {
    const parser = new StreamFrameParser();
    const frame = createFrame(1, "rendering");
    const first = parser.push(frame.slice(0, 4));
    const second = parser.push(frame.slice(4));

    expect(first).toHaveLength(0);
    expect(second).toHaveLength(1);
    expect(decodeFrameText(second[0].data)).toBe("rendering");
  });

  it("parses a large frame delivered one byte at a time", () => {
    const parser = new StreamFrameParser();
    const text = "长图结果".repeat(20_000);
    const frame = createFrame(1, text);
    const frames = [];

    for (const byte of frame) {
      frames.push(...parser.push(Uint8Array.of(byte)));
    }

    expect(frames).toHaveLength(1);
    expect(decodeFrameText(frames[0].data)).toBe(text);
  });
});
