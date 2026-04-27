import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "../src/config";
import type { TranslationCacheRecord, TranslationCacheStore } from "../src/cache";
import { TranslationResultCache } from "../src/cache";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+g5XsAAAAASUVORK5CYII=";
const PNG_BYTES = Uint8Array.from(Buffer.from(PNG_BASE64, "base64"));

function createPngBlob(type = "image/png"): Blob {
  return new Blob([PNG_BYTES], { type });
}

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

async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read the blob."));
    reader.readAsArrayBuffer(blob);
  });
}

describe("TranslationResultCache", () => {
  it("builds a stable key from source URL, image bytes and translation config", async () => {
    const cache = new TranslationResultCache({
      digest: createDigestMock(),
      store: new MemoryTranslationCacheStore()
    });

    const baseSettings = DEFAULT_SETTINGS;
    const baseKey = await cache.buildKey(
      new Blob(["page-a"]),
      "https://cdn.example.com/manga/page-1.png#viewer",
      baseSettings
    );
    const sameKey = await cache.buildKey(
      new Blob(["page-a"]),
      "https://cdn.example.com/manga/page-1.png",
      baseSettings
    );
    const otherImageKey = await cache.buildKey(
      new Blob(["page-bb"]),
      "https://cdn.example.com/manga/page-1.png",
      baseSettings
    );
    const otherSourceKey = await cache.buildKey(
      new Blob(["page-a"]),
      "https://cdn.example.com/manga/page-2.png",
      baseSettings
    );
    const otherConfigKey = await cache.buildKey(new Blob(["page-a"]), "https://cdn.example.com/manga/page-1.png", {
      ...baseSettings,
      targetLanguage: "ENG"
    });

    expect(baseKey).toBe(sameKey);
    expect(baseKey).not.toBe(otherImageKey);
    expect(baseKey).not.toBe(otherSourceKey);
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

    await cache.set("first", createPngBlob());
    now += 10;
    await cache.set("second", createPngBlob());

    now += 10;
    const cachedFirst = await cache.get("first");
    expect(cachedFirst).toBeInstanceOf(Blob);
    expect(await readBlobBytes(cachedFirst as Blob)).toEqual(await readBlobBytes(createPngBlob()));

    now += 10;
    await cache.set("third", createPngBlob());

    expect(await cache.get("first")).toBeInstanceOf(Blob);
    expect(await cache.get("second")).toBeNull();
    expect(await cache.get("third")).toBeInstanceOf(Blob);
  });

  it("repairs cached PNG blobs with a legacy MIME type", async () => {
    const store = new MemoryTranslationCacheStore();
    const cache = new TranslationResultCache({
      digest: createDigestMock(),
      store
    });

    await store.put({
      key: "legacy",
      blob: createPngBlob("application/octet-stream"),
      createdAt: 1,
      lastAccessedAt: 1,
      byteSize: createPngBlob("application/octet-stream").size
    });

    const cachedBlob = await cache.get("legacy");

    expect(cachedBlob).toBeInstanceOf(Blob);
    expect((cachedBlob as Blob).type).toBe("image/png");
    expect((await store.get("legacy"))?.blob.type).toBe("image/png");
  });

  it("drops invalid cached blobs instead of reusing them", async () => {
    const store = new MemoryTranslationCacheStore();
    const cache = new TranslationResultCache({
      digest: createDigestMock(),
      store
    });

    await store.put({
      key: "broken",
      blob: new Blob(["not-a-png"], { type: "application/octet-stream" }),
      createdAt: 1,
      lastAccessedAt: 1,
      byteSize: "not-a-png".length
    });

    expect(await cache.get("broken")).toBeNull();
    expect(await store.get("broken")).toBeNull();
  });

  it("clears all cached entries", async () => {
    const store = new MemoryTranslationCacheStore();
    const cache = new TranslationResultCache({
      digest: createDigestMock(),
      store
    });

    await cache.set("first", createPngBlob());
    await cache.set("second", createPngBlob());

    expect(await cache.clear()).toBe(true);
    expect(await store.list()).toEqual([]);
  });
});
