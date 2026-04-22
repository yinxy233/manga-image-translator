import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "../src/config";
import { OverlayManager } from "../src/core/overlayManager";

function createTouchLikeEvent(
  type: string,
  point: { clientX: number; clientY: number },
  touchesCount: 0 | 1
): Event {
  const event = new Event(type, {
    bubbles: true,
    cancelable: true
  });
  const touches = touchesCount === 1 ? [point] : [];
  Object.defineProperty(event, "touches", {
    value: touches
  });
  Object.defineProperty(event, "changedTouches", {
    value: [point]
  });
  return event;
}

describe("OverlayManager", () => {
  it("syncs overlay position with image bounds and toggles compact details", () => {
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
      onTranslateNow: vi.fn(),
      onLauncherPositionChange: vi.fn(),
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
    const badge = overlay.shadowRoot.querySelector(".mit-status-card") as HTMLDivElement;
    const compactToggle = overlay.shadowRoot.querySelector(".mit-compact-toggle") as HTMLButtonElement;
    expect(overlayItem.style.left).toBe("24px");
    expect(overlayItem.style.top).toBe("48px");
    expect(overlayItem.style.width).toBe("360px");
    expect(overlayItem.style.height).toBe("520px");
    expect(badge.dataset.compact).toBe("true");
    expect(badge.dataset.expanded).toBe("false");
    expect(compactToggle.dataset.status).toBe("complete");

    compactToggle.click();
    expect(badge.dataset.expanded).toBe("true");

    overlay.destroy();
  });

  it("starts collapsed and only opens the panel from settings", () => {
    const onTranslateNow = vi.fn();
    const overlay = new OverlayManager(DEFAULT_SETTINGS, {
      onTranslateNow,
      onLauncherPositionChange: vi.fn(),
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
    const settingsPanel = overlay.shadowRoot.querySelector(".mit-settings") as HTMLDivElement;
    const launcherGroup = overlay.shadowRoot.querySelector(".mit-launcher-group") as HTMLDivElement;
    const translateLauncher = overlay.shadowRoot.querySelector(
      '.mit-launcher-button[data-kind="translate"]'
    ) as HTMLButtonElement;
    const settingsLauncher = overlay.shadowRoot.querySelector(
      '.mit-launcher-button[data-kind="settings"]'
    ) as HTMLButtonElement;

    expect(dock.dataset.collapsed).toBe("true");
    expect(launcherGroup.dataset.open).toBe("false");
    expect(translateLauncher.textContent).toBe("译");
    expect(settingsLauncher.querySelector("svg")).not.toBeNull();

    translateLauncher.click();
    expect(onTranslateNow).toHaveBeenCalledTimes(1);
    expect(dock.dataset.collapsed).toBe("true");

    settingsLauncher.click();
    expect(dock.dataset.collapsed).toBe("false");
    expect(settingsPanel.dataset.open).toBe("true");
    expect(launcherGroup.dataset.open).toBe("true");

    overlay.destroy();
  });

  it("allows dragging the floating launcher and persists the new position", () => {
    const onLauncherPositionChange = vi.fn();
    const overlay = new OverlayManager(DEFAULT_SETTINGS, {
      onTranslateNow: vi.fn(),
      onLauncherPositionChange,
      onToggleSession: vi.fn(),
      onToggleGlobalOriginal: vi.fn(),
      onTestConnection: vi.fn(),
      onSaveSettings: vi.fn(),
      onToggleImageOriginal: vi.fn(),
      onRetryImage: vi.fn(),
      onCancelImage: vi.fn(),
      onIgnoreImage: vi.fn()
    });

    const launcherGroup = overlay.shadowRoot.querySelector(".mit-launcher-group") as HTMLDivElement;
    const translateLauncher = overlay.shadowRoot.querySelector(
      '.mit-launcher-button[data-kind="translate"]'
    ) as HTMLButtonElement;

    launcherGroup.getBoundingClientRect = () =>
      ({
        left: 20,
        top: 28,
        width: 122,
        height: 58,
        right: 142,
        bottom: 86,
        x: 20,
        y: 28
      }) as DOMRect;

    translateLauncher.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        button: 0,
        clientX: 34,
        clientY: 40
      })
    );
    window.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        clientX: 104,
        clientY: 116
      })
    );
    window.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        clientX: 104,
        clientY: 116
      })
    );

    expect(launcherGroup.style.left).toBe("90px");
    expect(launcherGroup.style.top).toBe("104px");
    expect(onLauncherPositionChange).toHaveBeenCalledWith({
      x: 90,
      y: 104
    });

    overlay.destroy();
  });

  it("allows dragging the floating launcher with touch events", () => {
    const onLauncherPositionChange = vi.fn();
    const overlay = new OverlayManager(DEFAULT_SETTINGS, {
      onTranslateNow: vi.fn(),
      onLauncherPositionChange,
      onToggleSession: vi.fn(),
      onToggleGlobalOriginal: vi.fn(),
      onTestConnection: vi.fn(),
      onSaveSettings: vi.fn(),
      onToggleImageOriginal: vi.fn(),
      onRetryImage: vi.fn(),
      onCancelImage: vi.fn(),
      onIgnoreImage: vi.fn()
    });

    const launcherGroup = overlay.shadowRoot.querySelector(".mit-launcher-group") as HTMLDivElement;
    const settingsLauncher = overlay.shadowRoot.querySelector(
      '.mit-launcher-button[data-kind="settings"]'
    ) as HTMLButtonElement;

    launcherGroup.getBoundingClientRect = () =>
      ({
        left: 18,
        top: 24,
        width: 122,
        height: 118,
        right: 140,
        bottom: 142,
        x: 18,
        y: 24
      }) as DOMRect;

    settingsLauncher.dispatchEvent(
      createTouchLikeEvent(
        "touchstart",
        {
          clientX: 28,
          clientY: 34
        },
        1
      )
    );
    window.dispatchEvent(
      createTouchLikeEvent(
        "touchmove",
        {
          clientX: 96,
          clientY: 112
        },
        1
      )
    );
    window.dispatchEvent(
      createTouchLikeEvent(
        "touchend",
        {
          clientX: 96,
          clientY: 112
        },
        0
      )
    );

    expect(launcherGroup.style.left).toBe("86px");
    expect(launcherGroup.style.top).toBe("102px");
    expect(onLauncherPositionChange).toHaveBeenCalledWith({
      x: 86,
      y: 102
    });

    overlay.destroy();
  });
});
