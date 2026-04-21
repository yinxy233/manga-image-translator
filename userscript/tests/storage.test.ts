import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "../src/config";
import { sanitizeSettings } from "../src/storage";

describe("sanitizeSettings", () => {
  it("keeps a valid upload transport mode", () => {
    const settings = sanitizeSettings({
      uploadTransport: "base64-json",
      maxConcurrency: 3
    });

    expect(settings.uploadTransport).toBe("base64-json");
    expect(settings.maxConcurrency).toBe(3);
  });

  it("falls back to the default upload transport for invalid values", () => {
    const settings = sanitizeSettings({
      uploadTransport: "invalid-mode" as never
    });

    expect(settings.uploadTransport).toBe(DEFAULT_SETTINGS.uploadTransport);
  });
});
