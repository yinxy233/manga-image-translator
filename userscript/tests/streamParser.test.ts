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
});
