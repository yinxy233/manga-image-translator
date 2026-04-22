import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "../src/config";
import type { TranslationCacheRecord, TranslationCacheStore } from "../src/cache";
import { TranslationResultCache } from "../src/cache";

class MemoryTranslationCacheStore implements TranslationCacheStore {
  private readonly records = new Map<string, TranslationCacheRecord>();

  async delete(key: string): Promise<void> {
    this.records.delete(key);
  }

  async get(key: string): Promise<TranslationCacheRecord | null> {
    return this.records.get(key) ?? null;
  }

  async list(): Promise<TranslationCacheRecord[]> {
    return Array.from(this.records.values());
  }

  async put(record: TranslationCacheRecord): Promise<void> {
    this.records.set(record.key, record);
  }
}

function createDigestMock(): (algorithm: AlgorithmIdentifier, data: BufferSource) => Promise<ArrayBuffer> {
  return vi.fn(async (_algorithm, data) => {
    const bytes =
      data instanceof Uint8Array
        ? data
        : data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

    const digest = new Uint8Array(32);
    let rolling = 0;
    for (const byte of bytes) {
      rolling = (rolling * 33 + byte) % 251;
    }
    digest.fill(rolling);
    digest[digest.length - 1] = bytes.length % 251;
    return digest.buffer;
  });
}

function readBlobText(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read the blob text."));
    reader.readAsText(blob);
  });
}

describe("TranslationResultCache", () => {
  it("builds a stable key from image bytes and translation config", async () => {
    const cache = new TranslationResultCache({
      digest: createDigestMock(),
      store: new MemoryTranslationCacheStore()
    });

    const baseSettings = DEFAULT_SETTINGS;
    const baseKey = await cache.buildKey(new Blob(["page-a"]), baseSettings);
    const sameKey = await cache.buildKey(new Blob(["page-a"]), baseSettings);
    const otherImageKey = await cache.buildKey(new Blob(["page-bb"]), baseSettings);
    const otherConfigKey = await cache.buildKey(new Blob(["page-a"]), {
      ...baseSettings,
      targetLanguage: "ENG"
    });

    expect(baseKey).toBe(sameKey);
    expect(baseKey).not.toBe(otherImageKey);
    expect(baseKey).not.toBe(otherConfigKey);
  });

  it("returns cached blobs and prunes the least recently used entries", async () => {
    let now = 100;
    const store = new MemoryTranslationCacheStore();
    const cache = new TranslationResultCache({
      digest: createDigestMock(),
      maxEntries: 2,
      now: () => now,
      store
    });

    await cache.set("first", new Blob(["first-result"], { type: "image/png" }));
    now += 10;
    await cache.set("second", new Blob(["second-result"], { type: "image/png" }));

    now += 10;
    const cachedFirst = await cache.get("first");
    expect(cachedFirst).toBeInstanceOf(Blob);
    expect(await readBlobText(cachedFirst as Blob)).toBe("first-result");

    now += 10;
    await cache.set("third", new Blob(["third-result"], { type: "image/png" }));

    expect(await cache.get("first")).toBeInstanceOf(Blob);
    expect(await cache.get("second")).toBeNull();
    expect(await cache.get("third")).toBeInstanceOf(Blob);
  });
});
