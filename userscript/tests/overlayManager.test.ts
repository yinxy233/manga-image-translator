import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "../src/config";
import { type SiteAdapterState } from "../src/adapters/types";
import { type OverlayManagerCallbacks, OverlayManager } from "../src/core/overlayManager";

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

const TEST_ADAPTER_STATES: SiteAdapterState[] = [
  {
    id: "mamekichimameko",
    label: "まめきちまめこ",
    description: "文章正文容器内的漫画图与文末告知图。",
    domainLabel: "mamekichimameko.blog.jp",
    defaultEnabled: true,
    enabled: true,
    matched: true,
    active: true
  },
  {
    id: "generic",
    label: "通用兜底",
    description: "未知站点或未覆盖模板时，按全站可见图片规则兜底处理。",
    domainLabel: "*://*/*",
    defaultEnabled: true,
    enabled: true,
    matched: false,
    active: false
  }
];

function createOverlay(
  callbackOverrides: Partial<OverlayManagerCallbacks> = {},
  adapterStates: SiteAdapterState[] = TEST_ADAPTER_STATES
): OverlayManager {
  return new OverlayManager(DEFAULT_SETTINGS, adapterStates, {
    onTranslateNow: vi.fn(),
    onLauncherPositionChange: vi.fn(),
    onToggleSession: vi.fn(),
    onToggleGlobalOriginal: vi.fn(),
    onTestConnection: vi.fn(),
    onClearCache: vi.fn(),
    onSaveSettings: vi.fn(),
    onToggleImageOriginal: vi.fn(),
    onRetryImage: vi.fn(),
    onCancelImage: vi.fn(),
    onIgnoreImage: vi.fn(),
    ...callbackOverrides
  });
}

describe("OverlayManager", () => {
  it("mounts image status inside the image container and toggles compact details", () => {
    const container = document.createElement("div");
    container.getBoundingClientRect = () =>
      ({
        left: 20,
        top: 40,
        width: 400,
        height: 560
      }) as DOMRect;

    const image = document.createElement("img");
    image.getBoundingClientRect = () =>
      ({
        left: 24,
        top: 48,
        width: 360,
        height: 520
      }) as DOMRect;
    container.appendChild(image);
    document.body.appendChild(container);

    const overlay = createOverlay();

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

    const overlayHost = container.querySelector('[data-mit-inline-status="image-1"]') as HTMLDivElement;
    const badge = overlayHost.shadowRoot?.querySelector(".mit-status-card") as HTMLDivElement;
    const compactToggle = overlayHost.shadowRoot?.querySelector(
      ".mit-compact-toggle"
    ) as HTMLButtonElement;
    const overlayItemInDock = overlay.shadowRoot.querySelector(".mit-overlay-item");
    expect(overlayHost.parentElement).toBe(container);
    expect(container.style.position).toBe("relative");
    expect(overlayHost.style.left).toBe("4px");
    expect(overlayHost.style.top).toBe("8px");
    expect(overlayHost.style.width).toBe("360px");
    expect(overlayHost.style.height).toBe("520px");
    expect(badge.dataset.compact).toBe("true");
    expect(badge.dataset.expanded).toBe("false");
    expect(compactToggle.dataset.status).toBe("complete");
    expect(overlayItemInDock).toBeNull();

    compactToggle.click();
    expect(badge.dataset.expanded).toBe("true");

    overlay.destroy();
    expect(container.querySelector('[data-mit-inline-status="image-1"]')).toBeNull();
    expect(container.style.position).toBe("");
  });

  it("starts collapsed and only opens the panel from settings", () => {
    const onTranslateNow = vi.fn();
    const overlay = createOverlay({ onTranslateNow });

    const dock = overlay.shadowRoot.querySelector(".mit-dock") as HTMLDivElement;
    const settingsPanel = overlay.shadowRoot.querySelector(".mit-settings") as HTMLDivElement;
    const settingsFooter = overlay.shadowRoot.querySelector(".mit-settings-actions") as HTMLDivElement;
    const launcherGroup = overlay.shadowRoot.querySelector(".mit-launcher-group") as HTMLDivElement;
    const translateLauncher = overlay.shadowRoot.querySelector(
      '.mit-launcher-button[data-kind="translate"]'
    ) as HTMLButtonElement;
    const settingsLauncher = overlay.shadowRoot.querySelector(
      '.mit-launcher-button[data-kind="settings"]'
    ) as HTMLButtonElement;
    const settingsButton = overlay.shadowRoot.querySelector(".mit-settings-btn") as HTMLButtonElement;

    expect(dock.dataset.collapsed).toBe("true");
    expect(launcherGroup.dataset.open).toBe("false");
    expect(settingsFooter.dataset.visible).toBe("false");
    expect(translateLauncher.textContent).toBe("译");
    expect(settingsLauncher.querySelector("svg")).not.toBeNull();

    translateLauncher.click();
    expect(onTranslateNow).toHaveBeenCalledTimes(1);
    expect(dock.dataset.collapsed).toBe("true");

    settingsLauncher.click();
    expect(dock.dataset.collapsed).toBe("false");
    expect(settingsPanel.dataset.open).toBe("false");
    expect(settingsFooter.dataset.visible).toBe("false");
    expect(launcherGroup.dataset.open).toBe("true");

    settingsButton.click();
    expect(settingsPanel.dataset.open).toBe("true");
    expect(settingsFooter.dataset.visible).toBe("true");

    overlay.destroy();
  });

  it("groups settings into collapsible sections and keeps save actions outside the scroll body", () => {
    const onSaveSettings = vi.fn();
    const onClearCache = vi.fn();
    const overlay = createOverlay({ onSaveSettings, onClearCache });

    const settingsLauncher = overlay.shadowRoot.querySelector(
      '.mit-launcher-button[data-kind="settings"]'
    ) as HTMLButtonElement;
    const settingsButton = overlay.shadowRoot.querySelector(".mit-settings-btn") as HTMLButtonElement;
    settingsLauncher.click();
    settingsButton.click();

    const dock = overlay.shadowRoot.querySelector(".mit-dock") as HTMLDivElement;
    const dockBody = overlay.shadowRoot.querySelector(".mit-dock-body") as HTMLDivElement;
    const settingsPanel = overlay.shadowRoot.querySelector(".mit-settings") as HTMLDivElement;
    const settingsFooter = overlay.shadowRoot.querySelector(".mit-settings-actions") as HTMLDivElement;
    const sectionLabels = Array.from(
      overlay.shadowRoot.querySelectorAll(".mit-section-label"),
      (node) => node.textContent
    );
    const fieldLabels = Array.from(
      overlay.shadowRoot.querySelectorAll(".mit-field label"),
      (node) => node.textContent
    );
    const sections = overlay.shadowRoot.querySelectorAll(".mit-settings-section");
    const advancedSection = sections[3] as HTMLDivElement;
    const advancedToggle = advancedSection.querySelector(".mit-section-toggle") as HTMLButtonElement;
    const adapterSection = sections[4] as HTMLDivElement;
    const adapterToggle = adapterSection.querySelector(".mit-section-toggle") as HTMLButtonElement;

    expect(dock.contains(dockBody)).toBe(true);
    expect(dock.contains(settingsFooter)).toBe(true);
    expect(settingsPanel.contains(settingsFooter)).toBe(false);
    expect(sectionLabels).toEqual(["连接", "翻译", "处理流程", "高级", "站点适配器"]);
    expect(fieldLabels).toEqual(
      expect.arrayContaining([
        "服务地址",
        "接口密钥",
        "翻译引擎",
        "目标语言",
        "检测器",
        "检测尺寸",
        "框阈值",
        "轮廓扩张",
        "排版方向",
        "修复器",
        "修复尺寸",
        "遮罩膨胀",
        "上传方式",
        "自动启动",
        "整页翻译",
        "启用缓存",
        "并发上限"
      ])
    );
    expect((sections[0] as HTMLDivElement).dataset.open).toBe("false");
    expect((sections[1] as HTMLDivElement).dataset.open).toBe("false");
    expect((sections[2] as HTMLDivElement).dataset.open).toBe("false");
    expect(advancedSection.dataset.open).toBe("false");
    expect(adapterSection.dataset.open).toBe("false");

    advancedToggle.click();
    expect(advancedSection.dataset.open).toBe("true");
    expect(advancedToggle.getAttribute("aria-expanded")).toBe("true");
    adapterToggle.click();
    expect(adapterSection.dataset.open).toBe("true");
    expect(adapterToggle.getAttribute("aria-expanded")).toBe("true");

    const serverInput = overlay.shadowRoot.querySelector('input[placeholder="https://translator.example.com"]') as HTMLInputElement;
    const apiKeyInput = overlay.shadowRoot.querySelector('input[placeholder="可选接口密钥"]') as HTMLInputElement;
    const fullPageCheckbox = Array.from(
      overlay.shadowRoot.querySelectorAll('.mit-switch input[type="checkbox"]')
    )[1] as HTMLInputElement;
    const cacheCheckbox = Array.from(
      overlay.shadowRoot.querySelectorAll('.mit-switch input[type="checkbox"]')
    )[2] as HTMLInputElement;
    const concurrencyInput = overlay.shadowRoot.querySelector(
      'input[type="number"][min="1"][max="6"]'
    ) as HTMLInputElement;
    const adapterCheckboxes = Array.from(
      overlay.shadowRoot.querySelectorAll('.mit-adapter-toggle input[type="checkbox"]')
    ) as HTMLInputElement[];
    const adapterStatuses = Array.from(
      overlay.shadowRoot.querySelectorAll(".mit-adapter-status"),
      (node) => node.textContent
    );
    const visibleAdapterTitles = Array.from(
      overlay.shadowRoot.querySelectorAll(".mit-adapter-card"),
      (node) => node as HTMLDivElement
    )
      .filter((node) => !node.hidden)
      .map((node) => node.querySelector(".mit-adapter-title")?.textContent);
    const footerButtons = Array.from(settingsFooter.querySelectorAll(".mit-btn")) as HTMLButtonElement[];
    const clearButton = footerButtons.find((button) => button.textContent === "清理缓存") as HTMLButtonElement;
    const saveButton = footerButtons.find((button) => button.textContent === "保存设置") as HTMLButtonElement;

    expect(serverInput.autocomplete).toBe("off");
    expect(serverInput.getAttribute("autocapitalize")).toBe("off");
    expect(apiKeyInput.type).toBe("text");
    expect(apiKeyInput.autocomplete).toBe("off");
    expect(apiKeyInput.getAttribute("data-lpignore")).toBe("true");
    expect(fullPageCheckbox.checked).toBe(false);
    expect(cacheCheckbox.checked).toBe(true);
    expect(adapterStatuses).toEqual(["当前页生效", "已启用"]);
    expect(visibleAdapterTitles).toEqual(["まめきちまめこ"]);
    expect(
      Array.from(overlay.shadowRoot.querySelectorAll(".mit-adapter-card"))
        .filter((node) => (node as HTMLDivElement).hidden)
        .every((node) => (node as HTMLDivElement).style.display === "none")
    ).toBe(true);

    serverInput.value = " https://translator.internal ";
    fullPageCheckbox.checked = true;
    cacheCheckbox.checked = false;
    concurrencyInput.value = "4";
    adapterCheckboxes[0]!.checked = false;
    clearButton.click();
    saveButton.click();

    expect(onClearCache).toHaveBeenCalledTimes(1);
    expect(onSaveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        serverBaseUrl: "https://translator.internal",
        fullPageTranslateEnabled: true,
        cacheEnabled: false,
        maxConcurrency: 4,
        adapterOverrides: {
          mamekichimameko: false,
          generic: true
        }
      })
    );

    overlay.destroy();
  });

  it("keeps the mobile dock narrower instead of stretching edge to edge", () => {
    const overlay = createOverlay();
    const styleText = overlay.shadowRoot.querySelector("style")?.textContent ?? "";

    expect(styleText).toContain("@media (max-width: 720px)");
    expect(styleText).toContain(
      "width: min(312px, calc(100vw - 24px - env(safe-area-inset-left) - env(safe-area-inset-right)));"
    );

    overlay.destroy();
  });

  it("hides the adapter section when the page only uses the generic fallback", () => {
    const overlay = createOverlay(
      {},
      [
        {
          id: "mamekichimameko",
          label: "まめきちまめこ",
          description: "文章正文容器内的漫画图与文末告知图。",
          domainLabel: "mamekichimameko.blog.jp",
          defaultEnabled: true,
          enabled: true,
          matched: false,
          active: false
        },
        {
          id: "generic",
          label: "通用兜底",
          description: "未知站点或未覆盖模板时，按全站可见图片规则兜底处理。",
          domainLabel: "*://*/*",
          defaultEnabled: true,
          enabled: true,
          matched: true,
          active: true
        }
      ]
    );

    const adapterSections = Array.from(
      overlay.shadowRoot.querySelectorAll(".mit-settings-section")
    ) as HTMLDivElement[];
    const adapterSection = adapterSections[4];

    expect(adapterSection?.hidden).toBe(true);
    expect(adapterSection?.style.display).toBe("none");

    overlay.destroy();
  });

  it("allows dragging the floating launcher and persists the new position", () => {
    const onLauncherPositionChange = vi.fn();
    const overlay = createOverlay({ onLauncherPositionChange });

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
    const overlay = createOverlay({ onLauncherPositionChange });

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
