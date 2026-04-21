import type { StreamFrame } from "../types";

function mergeUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

export class StreamFrameParser {
  private buffer = new Uint8Array();

  push(chunk: Uint8Array): StreamFrame[] {
    const merged = mergeUint8Arrays([this.buffer, chunk]);
    const frames: StreamFrame[] = [];
    let cursor = 0;

    while (cursor + 5 <= merged.length) {
      const view = new DataView(merged.buffer, merged.byteOffset + cursor, 5);
      const code = view.getUint8(0);
      const size = view.getUint32(1, false);
      const end = cursor + 5 + size;
      if (end > merged.length) {
        break;
      }

      frames.push({
        code,
        data: merged.slice(cursor + 5, end)
      });
      cursor = end;
    }

    this.buffer = merged.slice(cursor);
    return frames;
  }
}

export function decodeFrameText(data: Uint8Array): string {
  return new TextDecoder("utf-8").decode(data);
}

export async function readReadableStream(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: Uint8Array) => void,
  signal?: AbortSignal
): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      if (signal?.aborted) {
        throw new DOMException("Request aborted", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      if (value) {
        onChunk(value);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
