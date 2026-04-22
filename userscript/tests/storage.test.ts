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

  it("keeps a valid launcher position", () => {
    const settings = sanitizeSettings({
      launcherPosition: {
        x: 120.4,
        y: 248.8
      }
    });

    expect(settings.launcherPosition).toEqual({
      x: 120,
      y: 249
    });
  });

  it("falls back to the default launcher position for invalid values", () => {
    const settings = sanitizeSettings({
      launcherPosition: {
        x: Number.NaN,
        y: 180
      }
    });

    expect(settings.launcherPosition).toBe(DEFAULT_SETTINGS.launcherPosition);
  });
});
