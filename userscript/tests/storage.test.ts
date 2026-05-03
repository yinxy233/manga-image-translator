import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "../src/config";
import { sanitizeSettings } from "../src/storage";

describe("sanitizeSettings", () => {
  it("keeps a valid upload transport mode", () => {
    const settings = sanitizeSettings({
      uploadTransport: "base64-json",
      streamEndpoint: "web-fast",
      fullPageTranslateEnabled: true,
      maxConcurrency: 3,
      cacheEnabled: false,
      adapterOverrides: {
        generic: true,
        mamekichimameko: false
      }
    });

    expect(settings.uploadTransport).toBe("base64-json");
    expect(settings.streamEndpoint).toBe("web-fast");
    expect(settings.fullPageTranslateEnabled).toBe(true);
    expect(settings.maxConcurrency).toBe(3);
    expect(settings.cacheEnabled).toBe(false);
    expect(settings.adapterOverrides).toEqual({
      ...DEFAULT_SETTINGS.adapterOverrides,
      generic: true,
      mamekichimameko: false
    });
  });

  it("falls back to the default upload transport for invalid values", () => {
    const settings = sanitizeSettings({
      uploadTransport: "invalid-mode" as never,
      streamEndpoint: "invalid-endpoint" as never
    });

    expect(settings.uploadTransport).toBe(DEFAULT_SETTINGS.uploadTransport);
    expect(settings.streamEndpoint).toBe(DEFAULT_SETTINGS.streamEndpoint);
  });

  it("keeps valid pipeline and translator settings", () => {
    const settings = sanitizeSettings({
      translator: "chatgpt_2stage",
      targetLanguage: "rus",
      detector: "ctd",
      detectionSize: 1792,
      boxThreshold: 0.35,
      unclipRatio: 2.8,
      renderDirection: "vertical",
      inpainter: "lama_mpe",
      inpaintingSize: 1024,
      maskDilationOffset: 12
    });

    expect(settings.translator).toBe("chatgpt_2stage");
    expect(settings.targetLanguage).toBe("RUS");
    expect(settings.detector).toBe("ctd");
    expect(settings.detectionSize).toBe(1792);
    expect(settings.boxThreshold).toBe(0.35);
    expect(settings.unclipRatio).toBe(2.8);
    expect(settings.renderDirection).toBe("vertical");
    expect(settings.inpainter).toBe("lama_mpe");
    expect(settings.inpaintingSize).toBe(1024);
    expect(settings.maskDilationOffset).toBe(12);
  });

  it("falls back and clamps invalid pipeline settings", () => {
    const settings = sanitizeSettings({
      translator: "invalid-translator" as never,
      targetLanguage: "invalid-lang",
      detector: "invalid-detector" as never,
      detectionSize: 999999,
      boxThreshold: -1,
      unclipRatio: Number.NaN,
      renderDirection: "invalid-direction" as never,
      inpainter: "invalid-inpainter" as never,
      inpaintingSize: -100,
      maskDilationOffset: 999
    });

    expect(settings.translator).toBe(DEFAULT_SETTINGS.translator);
    expect(settings.targetLanguage).toBe(DEFAULT_SETTINGS.targetLanguage);
    expect(settings.detector).toBe(DEFAULT_SETTINGS.detector);
    expect(settings.detectionSize).toBe(4096);
    expect(settings.boxThreshold).toBe(0);
    expect(settings.unclipRatio).toBe(DEFAULT_SETTINGS.unclipRatio);
    expect(settings.renderDirection).toBe(DEFAULT_SETTINGS.renderDirection);
    expect(settings.inpainter).toBe(DEFAULT_SETTINGS.inpainter);
    expect(settings.inpaintingSize).toBe(256);
    expect(settings.maskDilationOffset).toBe(80);
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

  it("defaults cacheEnabled to the project default when omitted", () => {
    const settings = sanitizeSettings({});

    expect(settings.streamEndpoint).toBe(DEFAULT_SETTINGS.streamEndpoint);
    expect(settings.fullPageTranslateEnabled).toBe(DEFAULT_SETTINGS.fullPageTranslateEnabled);
    expect(settings.cacheEnabled).toBe(DEFAULT_SETTINGS.cacheEnabled);
    expect(settings.adapterOverrides).toEqual(DEFAULT_SETTINGS.adapterOverrides);
  });

  it("drops unknown adapter overrides and keeps registered adapter ids", () => {
    const settings = sanitizeSettings({
      adapterOverrides: {
        generic: false,
        mamekichimameko: true,
        unknown: true
      } as Record<string, boolean>
    });

    expect(settings.adapterOverrides).toEqual({
      ...DEFAULT_SETTINGS.adapterOverrides,
      generic: false,
      mamekichimameko: true
    });
  });
});
