export function isRasterImageUrl(imageUrl: string): boolean {
  const normalized = imageUrl.toLowerCase();
  return !normalized.endsWith(".svg") && !normalized.startsWith("data:image/svg");
}

export function resolveDefaultImageSource(image: HTMLImageElement): string | null {
  return image.currentSrc || image.src || null;
}

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

async function readBlobBuffer(blob: Blob): Promise<ArrayBuffer> {
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

async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  const buffer = await readBlobBuffer(blob);
  return new Uint8Array(buffer);
}

export async function normalizeRenderedImageBlob(blob: Blob): Promise<Blob | null> {
  if (blob.size < PNG_SIGNATURE.length) {
    return null;
  }

  const header = await readBlobBytes(blob.slice(0, PNG_SIGNATURE.length));
  const isPng = PNG_SIGNATURE.every((byte, index) => header[index] === byte);
  if (!isPng) {
    return null;
  }

  if (blob.type === "image/png") {
    return blob;
  }

  const buffer = await readBlobBuffer(blob);
  return new Blob([buffer], { type: "image/png" });
}
