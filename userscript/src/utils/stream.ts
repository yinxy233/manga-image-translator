import type { StreamFrame } from "../types";

/** Incremental byte queue that copies each completed frame exactly once. */
class ChunkQueue {
  private readonly chunks: Uint8Array[] = [];

  private headIndex = 0;

  private headOffset = 0;

  length = 0;

  append(chunk: Uint8Array): void {
    if (chunk.length === 0) {
      return;
    }
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  peekUint8(offset: number): number {
    let remaining = this.headOffset + offset;
    for (let index = this.headIndex; index < this.chunks.length; index += 1) {
      const chunk = this.chunks[index];
      if (!chunk) {
        continue;
      }
      if (remaining < chunk.length) {
        return chunk[remaining] ?? 0;
      }
      remaining -= chunk.length;
    }
    throw new RangeError("Chunk queue offset is outside the buffered data.");
  }

  read(size: number): Uint8Array<ArrayBuffer> {
    if (size > this.length) {
      throw new RangeError("Cannot read beyond the buffered data.");
    }

    const output = new Uint8Array(size);
    let written = 0;
    while (written < size) {
      const head = this.chunks[this.headIndex];
      if (!head) {
        break;
      }
      const available = head.length - this.headOffset;
      const take = Math.min(size - written, available);
      output.set(head.subarray(this.headOffset, this.headOffset + take), written);
      written += take;
      this.headOffset += take;
      this.length -= take;
      if (this.headOffset === head.length) {
        this.headIndex += 1;
        this.headOffset = 0;
      }
    }
    if (this.headIndex >= 1024 && this.headIndex * 2 >= this.chunks.length) {
      this.chunks.splice(0, this.headIndex);
      this.headIndex = 0;
    }
    return output;
  }
}

/** Parses arbitrarily fragmented five-byte-header response frames in linear time. */
export class StreamFrameParser {
  private readonly queue = new ChunkQueue();

  /** Adds one network chunk and returns every complete protocol frame. */
  push(chunk: Uint8Array): StreamFrame[] {
    this.queue.append(chunk);
    const frames: StreamFrame[] = [];

    while (this.queue.length >= 5) {
      const code = this.queue.peekUint8(0);
      const size =
        this.queue.peekUint8(1) * 0x1000000 +
        this.queue.peekUint8(2) * 0x10000 +
        this.queue.peekUint8(3) * 0x100 +
        this.queue.peekUint8(4);
      if (this.queue.length < 5 + size) {
        break;
      }

      this.queue.read(5);
      frames.push({
        code,
        data: this.queue.read(size)
      });
    }
    return frames;
  }
}

/** Decode a UTF-8 progress or error frame. */
export function decodeFrameText(data: Uint8Array): string {
  return new TextDecoder("utf-8").decode(data);
}

/** Consume a byte stream with AbortSignal support for legacy callers. */
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
