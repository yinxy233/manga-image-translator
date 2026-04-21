import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "../src/config";
import { OverlayManager } from "../src/core/overlayManager";

describe("OverlayManager", () => {
  it("syncs overlay position with image bounds", () => {
    const image = document.createElement("img");
    image.getBoundingClientRect = () =>
      ({
        left: 24,
        top: 48,
        width: 360,
        height: 520
      }) as DOMRect;
    document.body.appendChild(image);

    const overlay = new OverlayManager(DEFAULT_SETTINGS, {
      onToggleSession: vi.fn(),
      onToggleGlobalOriginal: vi.fn(),
      onTestConnection: vi.fn(),
      onSaveSettings: vi.fn(),
      onToggleImageOriginal: vi.fn(),
      onRetryImage: vi.fn(),
      onCancelImage: vi.fn(),
      onIgnoreImage: vi.fn()
    });

    overlay.renderImages([
      {
        id: "image-1",
        image,
        status: "complete",
        message: "翻译完成",
        resultUrl: "blob:test",
        showOriginal: false,
        queuePosition: null,
        canRetry: false,
        canCancel: false,
        canIgnore: false
      }
    ]);

    const overlayItem = overlay.shadowRoot.querySelector(".mit-overlay-item") as HTMLDivElement;
    expect(overlayItem.style.left).toBe("24px");
    expect(overlayItem.style.top).toBe("48px");
    expect(overlayItem.style.width).toBe("360px");
    expect(overlayItem.style.height).toBe("520px");

    overlay.destroy();
  });

  it("starts collapsed on touch layouts and can reopen from launcher", () => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockReturnValue({
        matches: true,
        media: "(pointer: coarse), (max-width: 720px)",
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn()
      })
    });

    const overlay = new OverlayManager(DEFAULT_SETTINGS, {
      onToggleSession: vi.fn(),
      onToggleGlobalOriginal: vi.fn(),
      onTestConnection: vi.fn(),
      onSaveSettings: vi.fn(),
      onToggleImageOriginal: vi.fn(),
      onRetryImage: vi.fn(),
      onCancelImage: vi.fn(),
      onIgnoreImage: vi.fn()
    });

    const dock = overlay.shadowRoot.querySelector(".mit-dock") as HTMLDivElement;
    const launcher = overlay.shadowRoot.querySelector(".mit-launcher") as HTMLButtonElement;

    expect(dock.dataset.collapsed).toBe("true");
    launcher.click();
    expect(dock.dataset.collapsed).toBe("false");

    overlay.destroy();
  });
});
