import { describe, expect, it } from "vitest";

import { normalizeRenderedImageBlob } from "../src/utils/image";

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
