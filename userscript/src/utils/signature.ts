import type { UserscriptSettings } from "../types";

export type DigestFn = (algorithm: AlgorithmIdentifier, data: BufferSource) => Promise<ArrayBuffer>;

function createDigest(): DigestFn | null {
  if (typeof crypto === "undefined" || typeof crypto.subtle?.digest !== "function") {
    return null;
  }

  return (algorithm, data) => crypto.subtle.digest(algorithm, data);
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

function toFallbackContentHash(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let left = 0x811c9dc5;
  let right = 0x01000193;

  for (const byte of bytes) {
    left ^= byte;
    left = Math.imul(left, 0x01000193) >>> 0;
    right ^= byte + ((left >>> 16) & 0xff);
    right = Math.imul(right, 0x811c9dc5) >>> 0;
  }

  const leftHex = left.toString(16).padStart(8, "0");
  const rightHex = right.toString(16).padStart(8, "0");
  return `fnv64:${bytes.byteLength}:${leftHex}${rightHex}`;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export function normalizeImageUrl(imageUrl: string): string {
  try {
    const url = new URL(imageUrl, window.location.href);
    url.hash = "";
    return url.toString();
  } catch {
    return imageUrl;
  }
}

export function buildConfigSignature(settings: UserscriptSettings): string {
  return JSON.stringify({
    serverBaseUrl: normalizeBaseUrl(settings.serverBaseUrl),
    targetLanguage: settings.targetLanguage,
    translator: settings.translator,
    detector: settings.detector,
    detectionSize: settings.detectionSize,
    boxThreshold: settings.boxThreshold,
    unclipRatio: settings.unclipRatio,
    renderDirection: settings.renderDirection,
    inpainter: settings.inpainter,
    inpaintingSize: settings.inpaintingSize,
    maskDilationOffset: settings.maskDilationOffset
  });
}

export async function buildImageContentHash(
  imageBlob: Blob,
  digest: DigestFn | null = createDigest()
): Promise<string> {
  const imageBytes = await blobToArrayBuffer(imageBlob);
  if (!digest) {
    // 非安全上下文里 Web Crypto 可能不可用；共享任务只需要稳定区分内容，使用本地哈希兜底。
    return toFallbackContentHash(imageBytes);
  }

  return `sha256:${toHex(await digest("SHA-256", imageBytes))}`;
}

export function buildImageContentSignature(imageHash: string, settings: UserscriptSettings): string {
  return `${imageHash}|${buildConfigSignature(settings)}`;
}
