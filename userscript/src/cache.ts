import type { UserscriptSettings } from "./types";
import { buildConfigSignature } from "./utils/signature";

const CACHE_DB_NAME = "mit-userscript-cache";
const CACHE_STORE_NAME = "translation-results";
const CACHE_DB_VERSION = 1;
const DEFAULT_MAX_CACHE_ENTRIES = 120;

type DigestFn = (algorithm: AlgorithmIdentifier, data: BufferSource) => Promise<ArrayBuffer>;
type IndexedDbFactory = Pick<IDBFactory, "open">;

export interface TranslationCacheRecord {
  key: string;
  blob: Blob;
  createdAt: number;
  lastAccessedAt: number;
  byteSize: number;
}

export interface TranslationCacheStore {
  delete(key: string): Promise<void>;
  get(key: string): Promise<TranslationCacheRecord | null>;
  list(): Promise<TranslationCacheRecord[]>;
  put(record: TranslationCacheRecord): Promise<void>;
}

interface TranslationResultCacheOptions {
  digest?: DigestFn | null;
  indexedDbFactory?: IndexedDbFactory | null;
  maxEntries?: number;
  now?: () => number;
  store?: TranslationCacheStore | null;
}

function createDigest(): DigestFn | null {
  if (typeof crypto === "undefined" || typeof crypto.subtle?.digest !== "function") {
    return null;
  }

  return (algorithm, data) => crypto.subtle.digest(algorithm, data);
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
  });
}

function byteLengthOfBlob(blob: Blob): number {
  return Number.isFinite(blob.size) ? blob.size : 0;
}

async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") {
    return blob.arrayBuffer();
  }

  if (typeof FileReader !== "undefined") {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error ?? new Error("Failed to read the blob."));
      reader.readAsArrayBuffer(blob);
    });
  }

  return new Response(blob).arrayBuffer();
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

class IndexedDbTranslationCacheStore implements TranslationCacheStore {
  private readonly indexedDbFactory: IndexedDbFactory | null;

  private dbPromise: Promise<IDBDatabase | null> | null = null;

  constructor(indexedDbFactory: IndexedDbFactory | null) {
    this.indexedDbFactory = indexedDbFactory;
  }

  async delete(key: string): Promise<void> {
    const database = await this.openDatabase();
    if (!database) {
      return;
    }

    const transaction = database.transaction(CACHE_STORE_NAME, "readwrite");
    transaction.objectStore(CACHE_STORE_NAME).delete(key);
    await transactionToPromise(transaction);
  }

  async get(key: string): Promise<TranslationCacheRecord | null> {
    const database = await this.openDatabase();
    if (!database) {
      return null;
    }

    const transaction = database.transaction(CACHE_STORE_NAME, "readonly");
    const result = (await requestToPromise(
      transaction.objectStore(CACHE_STORE_NAME).get(key) as IDBRequest<TranslationCacheRecord | undefined>
    )) ?? null;
    await transactionToPromise(transaction);
    return result;
  }

  async list(): Promise<TranslationCacheRecord[]> {
    const database = await this.openDatabase();
    if (!database) {
      return [];
    }

    const transaction = database.transaction(CACHE_STORE_NAME, "readonly");
    const records = await requestToPromise(
      transaction.objectStore(CACHE_STORE_NAME).getAll() as IDBRequest<TranslationCacheRecord[]>
    );
    await transactionToPromise(transaction);
    return records;
  }

  async put(record: TranslationCacheRecord): Promise<void> {
    const database = await this.openDatabase();
    if (!database) {
      return;
    }

    const transaction = database.transaction(CACHE_STORE_NAME, "readwrite");
    transaction.objectStore(CACHE_STORE_NAME).put(record);
    await transactionToPromise(transaction);
  }

  private async openDatabase(): Promise<IDBDatabase | null> {
    const indexedDbFactory = this.indexedDbFactory;
    if (!indexedDbFactory) {
      return null;
    }

    if (!this.dbPromise) {
      this.dbPromise = new Promise<IDBDatabase | null>((resolve) => {
        const request = indexedDbFactory.open(CACHE_DB_NAME, CACHE_DB_VERSION);

        request.onupgradeneeded = () => {
          const database = request.result;
          const store = database.objectStoreNames.contains(CACHE_STORE_NAME)
            ? request.transaction?.objectStore(CACHE_STORE_NAME)
            : database.createObjectStore(CACHE_STORE_NAME, { keyPath: "key" });

          if (store && !store.indexNames.contains("lastAccessedAt")) {
            store.createIndex("lastAccessedAt", "lastAccessedAt");
          }
        };

        request.onsuccess = () => {
          const database = request.result;
          database.onversionchange = () => {
            database.close();
          };
          resolve(database);
        };

        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      });
    }

    const database = await this.dbPromise;
    if (!database) {
      this.dbPromise = null;
    }
    return database;
  }
}

export class TranslationResultCache {
  private readonly digest: DigestFn | null;

  private readonly maxEntries: number;

  private readonly now: () => number;

  private readonly store: TranslationCacheStore | null;

  constructor(options: TranslationResultCacheOptions = {}) {
    const indexedDbFactory =
      options.indexedDbFactory ?? (typeof indexedDB === "undefined" ? null : indexedDB);

    this.digest = options.digest ?? createDigest();
    this.maxEntries = Math.max(1, Math.trunc(options.maxEntries ?? DEFAULT_MAX_CACHE_ENTRIES));
    this.now = options.now ?? (() => Date.now());
    this.store =
      options.store ??
      new IndexedDbTranslationCacheStore(indexedDbFactory);
  }

  async buildKey(imageBlob: Blob, settings: UserscriptSettings): Promise<string | null> {
    if (!this.digest) {
      return null;
    }

    try {
      const imageBytes = await blobToArrayBuffer(imageBlob);
      const imageHash = toHex(await this.digest("SHA-256", imageBytes));
      return `${imageHash}|${buildConfigSignature(settings)}`;
    } catch (error) {
      console.warn("[mit-userscript] Failed to build the translation cache key.", error);
      return null;
    }
  }

  async get(key: string): Promise<Blob | null> {
    if (!this.store) {
      return null;
    }

    try {
      const record = await this.store.get(key);
      if (!record) {
        return null;
      }

      await this.store.put({
        ...record,
        lastAccessedAt: this.now()
      });
      return record.blob;
    } catch (error) {
      console.warn("[mit-userscript] Failed to read the translation cache.", error);
      return null;
    }
  }

  async set(key: string, blob: Blob): Promise<void> {
    if (!this.store) {
      return;
    }

    const timestamp = this.now();

    try {
      await this.store.put({
        key,
        blob,
        createdAt: timestamp,
        lastAccessedAt: timestamp,
        byteSize: byteLengthOfBlob(blob)
      });
      await this.prune();
    } catch (error) {
      console.warn("[mit-userscript] Failed to write the translation cache.", error);
    }
  }

  private async prune(): Promise<void> {
    if (!this.store) {
      return;
    }

    const store = this.store;
    const records = await this.store.list();
    const overflow = records.length - this.maxEntries;

    if (overflow <= 0) {
      return;
    }

    const expiredRecords = [...records]
      .sort((left, right) => {
        if (left.lastAccessedAt !== right.lastAccessedAt) {
          return left.lastAccessedAt - right.lastAccessedAt;
        }
        return left.createdAt - right.createdAt;
      })
      .slice(0, overflow);

    await Promise.all(expiredRecords.map((record) => store.delete(record.key)));
  }
}
