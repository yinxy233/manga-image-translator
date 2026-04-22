import { describe, expect, it } from "vitest";

import {
  clearManagedImageSourceUrl,
  getManagedImageSourceUrl,
  normalizeRenderedImageBlob,
  resolveDefaultImageSource,
  setManagedImageSourceUrl
} from "../src/utils/image";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+g5XsAAAAASUVORK5CYII=";
const PNG_BYTES = Uint8Array.from(Buffer.from(PNG_BASE64, "base64"));

function createPngBlob(type = "image/png"): Blob {
  return new Blob([PNG_BYTES], { type });
}

describe("normalizeRenderedImageBlob", () => {
  it("keeps valid PNG blobs renderable", async () => {
    const normalizedBlob = await normalizeRenderedImageBlob(createPngBlob());

    expect(normalizedBlob).toBeInstanceOf(Blob);
    expect((normalizedBlob as Blob).type).toBe("image/png");
  });

  it("converts legacy PNG MIME types into image/png", async () => {
    const normalizedBlob = await normalizeRenderedImageBlob(
      createPngBlob("application/octet-stream")
    );

    expect(normalizedBlob).toBeInstanceOf(Blob);
    expect((normalizedBlob as Blob).type).toBe("image/png");
  });

  it("rejects non-PNG blobs", async () => {
    const normalizedBlob = await normalizeRenderedImageBlob(
      new Blob(["not-a-png"], { type: "application/octet-stream" })
    );

    expect(normalizedBlob).toBeNull();
  });
});

describe("resolveDefaultImageSource", () => {
  it("returns the managed source when the image is displaying a blob result", () => {
    const image = document.createElement("img");
    Object.defineProperty(image, "currentSrc", {
      configurable: true,
      value: "blob:https://example.com/translated"
    });

    setManagedImageSourceUrl(image, "https://example.com/original.png");

    expect(resolveDefaultImageSource(image)).toBe("https://example.com/original.png");
    expect(getManagedImageSourceUrl(image)).toBe("https://example.com/original.png");
  });

  it("prefers the current non-blob source even when a managed source marker exists", () => {
    const image = document.createElement("img");
    Object.defineProperty(image, "currentSrc", {
      configurable: true,
      value: "https://example.com/current.png"
    });

    setManagedImageSourceUrl(image, "https://example.com/original.png");

    expect(resolveDefaultImageSource(image)).toBe("https://example.com/current.png");

    clearManagedImageSourceUrl(image);
    expect(getManagedImageSourceUrl(image)).toBeNull();
  });
});
