import { LANGUAGE_OPTIONS, TRANSLATOR_OPTIONS, TRANSPORT_OPTIONS } from "../config";
import type {
  ConnectionState,
  LauncherPosition,
  OverlayViewModel,
  QueueStats,
  UserscriptSettings
} from "../types";

interface OverlayManagerState {
  enabled: boolean;
  globalShowOriginal: boolean;
  queueStats: QueueStats;
  connection: ConnectionState;
}

export interface OverlayManagerCallbacks {
  onTranslateNow: () => void;
  onLauncherPositionChange: (position: LauncherPosition) => void;
  onToggleSession: () => void;
  onToggleGlobalOriginal: () => void;
  onTestConnection: () => void;
  onSaveSettings: (settings: UserscriptSettings) => void;
  onToggleImageOriginal: (id: string) => void;
  onRetryImage: (id: string) => void;
  onCancelImage: (id: string) => void;
  onIgnoreImage: (id: string) => void;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

interface OverlayItemRefs {
  container: HTMLDivElement;
  result: HTMLImageElement;
  badge: HTMLDivElement;
  compactToggle: HTMLButtonElement;
  details: HTMLDivElement;
  status: HTMLSpanElement;
  queue: HTMLSpanElement;
  toggle: HTMLButtonElement;
  retry: HTMLButtonElement;
  cancel: HTMLButtonElement;
  ignore: HTMLButtonElement;
}

interface LauncherDragState {
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  moved: boolean;
}

const STYLE_TEXT = `
  :host {
    all: initial;
  }

  .mit-root,
  .mit-root * {
    box-sizing: border-box;
    font-family: "Avenir Next", "Segoe UI Variable", "PingFang SC", "Hiragino Sans GB", sans-serif;
  }

  .mit-root {
    position: fixed;
    inset: 0;
    z-index: 2147483646;
    pointer-events: none;
    color: #131313;
  }

  .mit-overlay-layer {
    position: fixed;
    inset: 0;
    pointer-events: none;
  }

  .mit-overlay-item {
    position: fixed;
    inset: auto auto auto auto;
    pointer-events: none;
  }

  .mit-overlay-image {
    width: 100%;
    height: 100%;
    object-fit: fill;
    display: block;
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
    transition: opacity 160ms ease;
  }

  .mit-status-card {
    position: absolute;
    top: 10px;
    left: 10px;
    max-width: min(220px, calc(100% - 20px));
    padding: 8px 10px;
    border-radius: 8px;
    background: rgba(17, 24, 39, 0.56);
    border: 1px solid rgba(255, 255, 255, 0.14);
    color: rgba(249, 250, 251, 0.96);
    box-shadow: 0 6px 14px rgba(0, 0, 0, 0.14);
    pointer-events: auto;
    backdrop-filter: blur(10px) saturate(1.15);
  }

  .mit-status-card[data-compact="true"] {
    max-width: none;
    padding: 0;
    background: transparent;
    border: 0;
    box-shadow: none;
    backdrop-filter: none;
  }

  .mit-status-card[data-status="error"] {
    background: rgba(127, 29, 29, 0.58);
    border-color: rgba(254, 202, 202, 0.18);
    color: rgba(254, 242, 242, 0.98);
  }

  .mit-status-card[data-status="complete"] {
    background: rgba(22, 101, 52, 0.58);
    border-color: rgba(220, 252, 231, 0.18);
    color: rgba(240, 253, 244, 0.98);
  }

  .mit-status-head {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .mit-status-text {
    font-size: 12px;
    line-height: 1.3;
    font-weight: 700;
  }

  .mit-status-queue {
    margin-top: 4px;
    font-size: 10px;
    opacity: 0.84;
  }

  .mit-status-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 8px;
  }

  .mit-compact-toggle {
    display: none;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 999px;
    background: rgba(17, 24, 39, 0.62);
    color: #ffffff;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.16);
    backdrop-filter: blur(10px) saturate(1.15);
    font-size: 12px;
    font-weight: 800;
    line-height: 1;
    position: relative;
    overflow: hidden;
    transition: opacity 180ms ease, transform 180ms ease, background 160ms ease;
  }

  .mit-compact-toggle[data-status="complete"] {
    background: rgba(22, 101, 52, 0.76);
  }

  .mit-compact-toggle[data-status="error"] {
    background: rgba(153, 27, 27, 0.78);
  }

  .mit-compact-toggle::after {
    content: "";
    position: absolute;
    inset: 1px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.16);
    opacity: 0;
  }

  .mit-compact-toggle[data-status="processing"]::after,
  .mit-compact-toggle[data-status="queued"]::after,
  .mit-compact-toggle[data-status="pending"]::after {
    opacity: 1;
    border-top-color: rgba(255, 255, 255, 0.9);
    border-right-color: rgba(255, 255, 255, 0.4);
    border-bottom-color: rgba(255, 255, 255, 0.16);
    border-left-color: rgba(255, 255, 255, 0.16);
    animation: mit-spin 1.1s linear infinite;
  }

  .mit-status-card[data-status="complete"]:not([data-expanded="true"]) .mit-compact-toggle {
    opacity: 0;
    transform: scale(0.92);
    pointer-events: none;
  }

  .mit-status-details {
    display: block;
  }

  .mit-status-card[data-compact="true"] .mit-compact-toggle {
    display: inline-flex;
  }

  .mit-status-card[data-compact="true"] .mit-status-details {
    display: none;
    margin-top: 6px;
    max-width: min(220px, calc(100vw - 32px));
    padding: 8px 10px;
    border-radius: 8px;
    background: rgba(17, 24, 39, 0.58);
    border: 1px solid rgba(255, 255, 255, 0.14);
    box-shadow: 0 6px 14px rgba(0, 0, 0, 0.14);
    color: rgba(249, 250, 251, 0.96);
    backdrop-filter: blur(10px) saturate(1.15);
  }

  .mit-status-card[data-compact="true"][data-status="complete"],
  .mit-status-card[data-compact="true"][data-status="error"] {
    background: transparent;
    border: 0;
    box-shadow: none;
    backdrop-filter: none;
  }

  .mit-status-card[data-compact="true"][data-status="complete"] .mit-status-details {
    background: rgba(22, 101, 52, 0.6);
    color: rgba(240, 253, 244, 0.98);
  }

  .mit-status-card[data-compact="true"][data-status="error"] .mit-status-details {
    background: rgba(127, 29, 29, 0.62);
    color: rgba(254, 242, 242, 0.98);
  }

  .mit-status-card[data-compact="true"][data-expanded="true"] .mit-status-details {
    display: block;
  }

  @keyframes mit-spin {
    from {
      transform: rotate(0deg);
    }

    to {
      transform: rotate(360deg);
    }
  }

  .mit-btn {
    appearance: none;
    border: 1px solid #d1d5db;
    border-radius: 8px;
    background: #ffffff;
    color: #111827;
    cursor: pointer;
    transition: background 140ms ease, border-color 140ms ease, color 140ms ease;
  }

  .mit-btn:hover {
    background: #f3f4f6;
  }

  .mit-btn {
    min-height: 36px;
    padding: 8px 12px;
    font-size: 12px;
    font-weight: 700;
    line-height: 1;
  }

  .mit-btn[data-tone="ghost"] {
    background: #ffffff;
    color: #111827;
  }

  .mit-btn[data-tone="danger"] {
    border-color: #fca5a5;
    background: #fef2f2;
    color: #b91c1c;
  }

  .mit-btn[data-utility="true"] {
    min-width: 40px;
    padding: 8px 10px;
  }

  .mit-status-card .mit-btn {
    min-height: 26px;
    padding: 5px 8px;
    font-size: 10px;
    border-radius: 999px;
    border-color: rgba(255, 255, 255, 0.12);
    background: rgba(255, 255, 255, 0.12);
    color: inherit;
    backdrop-filter: blur(8px);
  }

  .mit-status-card .mit-btn:hover {
    background: rgba(255, 255, 255, 0.18);
  }

  .mit-status-card .mit-btn[data-tone="danger"] {
    border-color: rgba(254, 202, 202, 0.18);
    background: rgba(185, 28, 28, 0.24);
    color: inherit;
  }

  .mit-btn:not([data-tone]),
  .mit-settings-actions .mit-btn {
    border-color: #2563eb;
    background: #2563eb;
    color: #ffffff;
  }

  .mit-dock {
    position: fixed;
    right: max(12px, env(safe-area-inset-right));
    bottom: max(12px, env(safe-area-inset-bottom));
    width: 328px;
    pointer-events: auto;
    padding: 16px;
    border-radius: 14px;
    background: rgba(255, 255, 255, 0.98);
    color: #111827;
    box-shadow: 0 14px 36px rgba(0, 0, 0, 0.16);
    border: 1px solid #e5e7eb;
    transition: opacity 160ms ease, transform 160ms ease;
  }

  .mit-dock[data-collapsed="true"] {
    opacity: 0;
    transform: translateY(10px) scale(0.98);
    pointer-events: none;
  }

  .mit-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .mit-title h1 {
    margin: 0;
    font-size: 16px;
    font-weight: 800;
  }

  .mit-title-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .mit-subtitle {
    margin: 4px 0 0;
    font-size: 12px;
    line-height: 1.45;
    color: #4b5563;
  }

  .mit-controls,
  .mit-stats {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    margin-top: 12px;
  }

  .mit-stat-card {
    padding: 10px 12px;
    border-radius: 10px;
    background: #f9fafb;
    border: 1px solid #e5e7eb;
  }

  .mit-stat-label {
    display: block;
    font-size: 11px;
    color: #6b7280;
  }

  .mit-stat-value {
    display: block;
    margin-top: 4px;
    font-size: 16px;
    font-weight: 800;
  }

  .mit-status-pill {
    display: flex;
    align-items: center;
    justify-content: center;
    margin-top: 12px;
    padding: 10px 12px;
    border-radius: 10px;
    font-size: 12px;
    font-weight: 700;
    background: #f3f4f6;
    color: #1f2937;
    border: 1px solid #e5e7eb;
  }

  .mit-status-pill[data-tone="success"] {
    background: #ecfdf5;
    color: #166534;
    border-color: #bbf7d0;
  }

  .mit-status-pill[data-tone="error"] {
    background: #fef2f2;
    color: #b91c1c;
    border-color: #fecaca;
  }

  .mit-launcher-group {
    position: fixed;
    right: max(12px, env(safe-area-inset-right));
    bottom: max(12px, env(safe-area-inset-bottom));
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    pointer-events: auto;
    cursor: grab;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
    transition: opacity 180ms ease, transform 180ms ease;
  }

  .mit-launcher-group[data-dragging="true"] {
    cursor: grabbing;
    transition: none;
  }

  .mit-launcher-group[data-open="true"] {
    opacity: 0;
    transform: translateY(10px) scale(0.96);
    pointer-events: none;
  }

  .mit-launcher-button {
    appearance: none;
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    color: #ffffff;
    cursor: pointer;
    border: 1px solid rgba(255, 255, 255, 0.2);
    box-shadow: 0 18px 42px rgba(15, 23, 42, 0.24);
    backdrop-filter: blur(16px) saturate(1.18);
    overflow: hidden;
    transition:
      transform 180ms ease,
      box-shadow 180ms ease,
      border-color 180ms ease,
      background 180ms ease;
  }

  .mit-launcher-button::before {
    content: "";
    position: absolute;
    inset: 1px;
    border-radius: inherit;
    background: linear-gradient(135deg, rgba(255, 255, 255, 0.24), rgba(255, 255, 255, 0.04) 52%, transparent 70%);
    opacity: 0.72;
    pointer-events: none;
  }

  .mit-launcher-button:hover {
    transform: translateY(-2px);
    box-shadow: 0 22px 44px rgba(15, 23, 42, 0.28);
  }

  .mit-launcher-button:active {
    transform: translateY(0) scale(0.97);
  }

  .mit-launcher-button:focus-visible {
    outline: none;
    box-shadow:
      0 0 0 4px rgba(96, 165, 250, 0.26),
      0 18px 42px rgba(15, 23, 42, 0.24);
  }

  .mit-launcher-button[data-kind="translate"] {
    width: 58px;
    height: 58px;
    border-radius: 20px;
    border-color: rgba(147, 197, 253, 0.48);
    background: linear-gradient(145deg, rgba(29, 78, 216, 0.98), rgba(37, 99, 235, 0.94) 48%, rgba(14, 165, 233, 0.9));
  }

  .mit-launcher-button[data-kind="translate"][data-active="true"] {
    border-color: rgba(191, 219, 254, 0.72);
    box-shadow:
      0 0 0 1px rgba(191, 219, 254, 0.18),
      0 18px 42px rgba(15, 23, 42, 0.24);
  }

  .mit-launcher-button[data-kind="translate"][data-active="true"]::after {
    content: "";
    position: absolute;
    inset: -6px;
    border-radius: 24px;
    border: 1px solid rgba(147, 197, 253, 0.42);
    animation: mit-launcher-pulse 1.8s ease-out infinite;
    pointer-events: none;
  }

  .mit-launcher-button[data-kind="settings"] {
    width: 48px;
    height: 48px;
    border-radius: 16px;
    background: rgba(17, 24, 39, 0.9);
  }

  .mit-launcher-button[data-kind="settings"]:hover .mit-launcher-icon {
    transform: rotate(18deg);
  }

  .mit-launcher-label,
  .mit-launcher-icon,
  .mit-inline-icon {
    position: relative;
    z-index: 1;
  }

  .mit-launcher-label {
    font-size: 24px;
    font-weight: 900;
    line-height: 1;
    letter-spacing: 0.08em;
    transform: translateX(1px);
  }

  .mit-launcher-icon,
  .mit-inline-icon {
    width: 20px;
    height: 20px;
    transition: transform 180ms ease;
  }

  .mit-settings-btn:hover .mit-inline-icon,
  .mit-settings-btn[aria-pressed="true"] .mit-inline-icon {
    transform: rotate(18deg);
  }

  @keyframes mit-launcher-pulse {
    0% {
      transform: scale(0.94);
      opacity: 0;
    }

    25% {
      opacity: 0.56;
    }

    100% {
      transform: scale(1.12);
      opacity: 0;
    }
  }

  .mit-settings {
    margin-top: 12px;
    padding: 14px;
    border-radius: 10px;
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    display: none;
  }

  .mit-settings[data-open="true"] {
    display: block;
  }

  .mit-settings-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  .mit-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .mit-field[data-full="true"] {
    grid-column: 1 / -1;
  }

  .mit-field label {
    font-size: 11px;
    color: #4b5563;
  }

  .mit-input,
  .mit-select {
    width: 100%;
    min-height: 38px;
    padding: 10px 12px;
    border-radius: 8px;
    border: 1px solid #d1d5db;
    background: #ffffff;
    color: #111827;
    font-size: 13px;
  }

  .mit-input::placeholder {
    color: #9ca3af;
  }

  .mit-switch {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 38px;
    padding: 10px 12px;
    border-radius: 8px;
    background: #ffffff;
    border: 1px solid #d1d5db;
    color: #111827;
  }

  .mit-switch input {
    width: 18px;
    height: 18px;
  }

  .mit-settings-actions {
    display: flex;
    gap: 10px;
    margin-top: 14px;
  }

  .mit-toast-layer {
    position: fixed;
    right: 20px;
    top: 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    pointer-events: none;
  }

  .mit-toast {
    min-width: 260px;
    max-width: 360px;
    padding: 12px 14px;
    border-radius: 10px;
    color: #111827;
    background: rgba(255, 255, 255, 0.98);
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.14);
    border: 1px solid #e5e7eb;
    font-size: 12px;
    line-height: 1.5;
  }

  .mit-toast[data-tone="error"] {
    border-color: #fecaca;
    background: #fef2f2;
    color: #991b1b;
  }

  .mit-icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  }

  @media (pointer: coarse), (max-width: 720px) {
    .mit-btn {
      min-height: 42px;
      font-size: 13px;
    }

    .mit-launcher-group {
      gap: 12px;
    }

    .mit-launcher-button[data-kind="translate"] {
      width: 62px;
      height: 62px;
      border-radius: 22px;
    }

    .mit-launcher-button[data-kind="settings"] {
      width: 52px;
      height: 52px;
      border-radius: 18px;
    }

    .mit-launcher-label {
      font-size: 25px;
    }

    .mit-launcher-icon,
    .mit-inline-icon {
      width: 22px;
      height: 22px;
    }

    .mit-compact-toggle {
      width: 30px;
      height: 30px;
      font-size: 13px;
    }

    .mit-dock {
      left: 12px;
      right: 12px;
      bottom: max(12px, env(safe-area-inset-bottom));
      width: auto;
    }

    .mit-controls {
      grid-template-columns: 1fr;
    }

    .mit-settings-grid {
      grid-template-columns: 1fr;
    }

    .mit-status-card {
      left: 8px;
      right: 8px;
      top: auto;
      bottom: 8px;
      max-width: none;
      padding: 8px 9px;
    }

    .mit-status-card[data-compact="true"] {
      left: 8px;
      right: auto;
      top: 8px;
      bottom: auto;
    }
  }
`;

export class OverlayManager {
  readonly shadowRoot: ShadowRoot;

  private readonly callbacks: OverlayManagerCallbacks;

  private readonly host: HTMLDivElement;

  private readonly overlayLayer: HTMLDivElement;

  private readonly dock: HTMLDivElement;

  private readonly toastLayer: HTMLDivElement;

  private readonly settingsPanel: HTMLDivElement;

  private readonly launcherGroup: HTMLDivElement;

  private readonly translateLauncher: HTMLButtonElement;

  private readonly settingsLauncher: HTMLButtonElement;

  private readonly startPauseButton: HTMLButtonElement;

  private readonly globalToggleButton: HTMLButtonElement;

  private readonly testButton: HTMLButtonElement;

  private readonly settingsButton: HTMLButtonElement;

  private readonly collapseButton: HTMLButtonElement;

  private readonly queueValue: HTMLSpanElement;

  private readonly runningValue: HTMLSpanElement;

  private readonly doneValue: HTMLSpanElement;

  private readonly errorValue: HTMLSpanElement;

  private readonly connectionPill: HTMLDivElement;

  private readonly serverInput: HTMLInputElement;

  private readonly apiKeyInput: HTMLInputElement;

  private readonly translatorSelect: HTMLSelectElement;

  private readonly languageSelect: HTMLSelectElement;

  private readonly transportSelect: HTMLSelectElement;

  private readonly autoCheckbox: HTMLInputElement;

  private readonly concurrencyInput: HTMLInputElement;

  private readonly itemRefs = new Map<string, OverlayItemRefs>();

  private viewModels = new Map<string, OverlayViewModel>();

  private readonly expandedCompactItems = new Set<string>();

  private settingsOpen = false;

  private collapsed = true;

  private launcherPosition: LauncherPosition | null = null;

  private launcherDragState: LauncherDragState | null = null;

  private suppressLauncherClick = false;

  constructor(settings: UserscriptSettings, callbacks: OverlayManagerCallbacks) {
    this.callbacks = callbacks;

    this.host = document.createElement("div");
    this.host.id = "mit-userscript-host";
    this.shadowRoot = this.host.attachShadow({ mode: "open" });
    document.documentElement.appendChild(this.host);

    const style = document.createElement("style");
    style.textContent = STYLE_TEXT;

    const root = document.createElement("div");
    root.className = "mit-root";

    this.overlayLayer = document.createElement("div");
    this.overlayLayer.className = "mit-overlay-layer";

    this.toastLayer = document.createElement("div");
    this.toastLayer.className = "mit-toast-layer";

    this.dock = document.createElement("div");
    this.dock.className = "mit-dock";

    this.launcherGroup = document.createElement("div");
    this.launcherGroup.className = "mit-launcher-group";
    this.translateLauncher = this.createLauncherButton("translate", "译", "一键翻译当前页");
    this.settingsLauncher = this.createLauncherButton("settings", "", "打开设置", createGearIcon("mit-launcher-icon"));
    this.launcherGroup.append(this.settingsLauncher, this.translateLauncher);

    this.startPauseButton = this.createButton("启动本页", "primary");
    this.globalToggleButton = this.createButton("显示原图", "ghost");
    this.testButton = this.createButton("连接测试", "ghost");
    this.settingsButton = this.createButton("", "ghost");
    this.settingsButton.dataset.utility = "true";
    this.settingsButton.classList.add("mit-settings-btn");
    this.settingsButton.classList.add("mit-icon-btn");
    this.settingsButton.replaceChildren(createGearIcon("mit-inline-icon"));
    this.settingsButton.title = "展开设置";
    this.settingsButton.setAttribute("aria-label", "展开设置");
    this.collapseButton = this.createButton("收起", "ghost");
    this.collapseButton.dataset.utility = "true";
    this.collapseButton.classList.add("mit-collapse-btn");
    this.queueValue = document.createElement("span");
    this.runningValue = document.createElement("span");
    this.doneValue = document.createElement("span");
    this.errorValue = document.createElement("span");
    this.connectionPill = document.createElement("div");
    this.connectionPill.className = "mit-status-pill";

    this.serverInput = document.createElement("input");
    this.apiKeyInput = document.createElement("input");
    this.translatorSelect = document.createElement("select");
    this.languageSelect = document.createElement("select");
    this.transportSelect = document.createElement("select");
    this.autoCheckbox = document.createElement("input");
    this.concurrencyInput = document.createElement("input");

    this.settingsPanel = this.buildSettingsPanel(settings);
    this.dock.append(...this.buildDockContent());

    root.append(this.overlayLayer, this.dock, this.launcherGroup, this.toastLayer);
    this.shadowRoot.append(style, root);

    window.addEventListener("scroll", this.handleViewportChange, { passive: true });
    window.addEventListener("resize", this.handleViewportChange, { passive: true });

    this.bindControls();
    this.syncDockVisibility();
    this.updateSettings(settings);
  }

  updateChrome(state: OverlayManagerState): void {
    this.startPauseButton.textContent = state.enabled ? "暂停排队" : "启动本页";
    this.globalToggleButton.textContent = state.globalShowOriginal ? "显示译图" : "显示原图";
    this.queueValue.textContent = String(state.queueStats.queued);
    this.runningValue.textContent = String(state.queueStats.running);
    this.doneValue.textContent = String(state.queueStats.completed);
    this.errorValue.textContent = String(state.queueStats.errors);
    this.connectionPill.dataset.tone = state.connection.tone;
    this.connectionPill.textContent = state.connection.label;
    this.translateLauncher.dataset.active = String(state.enabled);
    const translateLabel = state.enabled ? "重新扫描当前页" : "一键翻译当前页";
    this.translateLauncher.title = translateLabel;
    this.translateLauncher.setAttribute("aria-label", translateLabel);
  }

  updateSettings(settings: UserscriptSettings): void {
    this.serverInput.value = settings.serverBaseUrl;
    this.apiKeyInput.value = settings.apiKey;
    this.translatorSelect.value = settings.translator;
    this.languageSelect.value = settings.targetLanguage;
    this.transportSelect.value = settings.uploadTransport;
    this.autoCheckbox.checked = settings.autoTranslateEnabled;
    this.concurrencyInput.value = String(settings.maxConcurrency);
    this.launcherPosition = settings.launcherPosition;
    this.syncLauncherPosition();
  }

  renderImages(viewModels: OverlayViewModel[]): void {
    this.viewModels = new Map(viewModels.map((viewModel) => [viewModel.id, viewModel]));

    const nextIds = new Set(this.viewModels.keys());
    for (const [id, refs] of this.itemRefs.entries()) {
      if (!nextIds.has(id)) {
        refs.container.remove();
        this.itemRefs.delete(id);
        this.expandedCompactItems.delete(id);
      }
    }

    for (const viewModel of viewModels) {
      const refs = this.itemRefs.get(viewModel.id) ?? this.createOverlayItem(viewModel.id);
      refs.badge.dataset.status = viewModel.status;
      refs.badge.dataset.compact = "true";
      refs.badge.dataset.expanded = String(this.expandedCompactItems.has(viewModel.id));
      refs.status.textContent = viewModel.message;
      refs.queue.textContent = viewModel.queuePosition ? `队列位置 #${viewModel.queuePosition}` : "";
      refs.queue.style.display = viewModel.queuePosition ? "block" : "none";
      refs.result.src = viewModel.resultUrl ?? "";
      refs.result.style.opacity = viewModel.showOriginal || !viewModel.resultUrl ? "0" : "1";
      refs.compactToggle.dataset.status = viewModel.status;
      refs.compactToggle.title = viewModel.message;
      refs.compactToggle.setAttribute("aria-label", viewModel.message);
      refs.toggle.textContent = viewModel.showOriginal ? "显示译图" : "显示原图";
      refs.toggle.hidden = !viewModel.resultUrl;
      refs.retry.hidden = !viewModel.canRetry;
      refs.cancel.hidden = !viewModel.canCancel;
      refs.ignore.hidden = !viewModel.canIgnore;
    }

    this.syncPositions();
  }

  syncPositions(): void {
    for (const [id, viewModel] of this.viewModels.entries()) {
      const refs = this.itemRefs.get(id);
      if (!refs) {
        continue;
      }

      const rect = viewModel.image.getBoundingClientRect();
      if (!viewModel.image.isConnected || rect.width <= 0 || rect.height <= 0) {
        refs.container.style.display = "none";
        continue;
      }

      refs.container.style.display = "block";
      refs.container.style.left = `${rect.left}px`;
      refs.container.style.top = `${rect.top}px`;
      refs.container.style.width = `${rect.width}px`;
      refs.container.style.height = `${rect.height}px`;
    }
  }

  toast(message: string, tone: "neutral" | "error" = "neutral"): void {
    const toast = document.createElement("div");
    toast.className = "mit-toast";
    toast.dataset.tone = tone;
    toast.textContent = message;
    this.toastLayer.appendChild(toast);
    window.setTimeout(() => toast.remove(), 3600);
  }

  destroy(): void {
    window.removeEventListener("scroll", this.handleViewportChange);
    window.removeEventListener("resize", this.handleViewportChange);
    this.stopLauncherDrag();
    this.host.remove();
  }

  private buildDockContent(): HTMLElement[] {
    const title = document.createElement("div");
    title.className = "mit-title";

    const titleBlock = document.createElement("div");
    const heading = document.createElement("h1");
    heading.textContent = "漫画翻译";
    const subtitle = document.createElement("p");
    subtitle.className = "mit-subtitle";
    subtitle.textContent = "点击开始后，当前页和后续图片会自动加入翻译队列。";
    titleBlock.append(heading, subtitle);

    const titleActions = document.createElement("div");
    titleActions.className = "mit-title-actions";
    titleActions.append(this.settingsButton, this.collapseButton);

    title.append(titleBlock, titleActions);

    const controls = document.createElement("div");
    controls.className = "mit-controls";
    controls.append(this.startPauseButton, this.globalToggleButton, this.testButton);

    const stats = document.createElement("div");
    stats.className = "mit-stats";
    stats.append(
      this.createStatCard("排队", this.queueValue),
      this.createStatCard("处理中", this.runningValue),
      this.createStatCard("完成", this.doneValue),
      this.createStatCard("错误", this.errorValue)
    );

    return [title, controls, stats, this.connectionPill, this.settingsPanel];
  }

  private bindControls(): void {
    this.launcherGroup.addEventListener("mousedown", this.handleLauncherMouseDown);
    this.launcherGroup.addEventListener("touchstart", this.handleLauncherTouchStart, {
      passive: true
    });
    this.launcherGroup.addEventListener("click", this.handleLauncherClickCapture, true);
    this.translateLauncher.addEventListener("click", () => this.callbacks.onTranslateNow());
    this.settingsLauncher.addEventListener("click", () => {
      this.setSettingsOpen(true);
      this.collapsed = false;
      this.syncDockVisibility();
    });
    this.startPauseButton.addEventListener("click", () => this.callbacks.onToggleSession());
    this.globalToggleButton.addEventListener("click", () => this.callbacks.onToggleGlobalOriginal());
    this.testButton.addEventListener("click", () => this.callbacks.onTestConnection());
    this.settingsButton.addEventListener("click", () => {
      this.setSettingsOpen(!this.settingsOpen);
    });
    this.collapseButton.addEventListener("click", () => {
      this.setSettingsOpen(false);
      this.collapsed = true;
      this.syncDockVisibility();
    });
  }

  private createButton(text: string, tone: "primary" | "ghost" | "danger"): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mit-btn";
    if (tone !== "primary") {
      button.dataset.tone = tone;
    }
    button.textContent = text;
    return button;
  }

  private createLauncherButton(
    kind: "translate" | "settings",
    text: string,
    ariaLabel: string,
    icon?: SVGSVGElement
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mit-launcher-button";
    button.dataset.kind = kind;
    button.title = ariaLabel;
    button.setAttribute("aria-label", ariaLabel);
    if (icon) {
      button.append(icon);
    } else {
      const label = document.createElement("span");
      label.className = "mit-launcher-label";
      label.textContent = text;
      button.append(label);
    }
    return button;
  }

  private setSettingsOpen(open: boolean): void {
    this.settingsOpen = open;
    this.settingsPanel.dataset.open = String(open);
    const settingsLabel = open ? "收起设置" : "展开设置";
    this.settingsButton.title = settingsLabel;
    this.settingsButton.setAttribute("aria-label", settingsLabel);
    this.settingsButton.setAttribute("aria-pressed", String(open));
  }

  private syncDockVisibility(): void {
    this.dock.dataset.collapsed = String(this.collapsed);
    this.launcherGroup.dataset.open = String(!this.collapsed);
  }

  private syncLauncherPosition(): void {
    if (!this.launcherPosition) {
      this.launcherGroup.style.left = "";
      this.launcherGroup.style.top = "";
      this.launcherGroup.style.right = "";
      this.launcherGroup.style.bottom = "";
      return;
    }

    const clamped = this.clampLauncherPosition(this.launcherPosition);
    this.launcherPosition = clamped;
    this.launcherGroup.style.left = `${clamped.x}px`;
    this.launcherGroup.style.top = `${clamped.y}px`;
    this.launcherGroup.style.right = "auto";
    this.launcherGroup.style.bottom = "auto";
  }

  private createStatCard(label: string, valueNode: HTMLSpanElement): HTMLDivElement {
    const container = document.createElement("div");
    container.className = "mit-stat-card";

    const labelNode = document.createElement("span");
    labelNode.className = "mit-stat-label";
    labelNode.textContent = label;

    valueNode.className = "mit-stat-value";
    valueNode.textContent = "0";

    container.append(labelNode, valueNode);
    return container;
  }

  private buildSettingsPanel(settings: UserscriptSettings): HTMLDivElement {
    const panel = document.createElement("div");
    panel.className = "mit-settings";
    panel.dataset.open = "false";

    const grid = document.createElement("div");
    grid.className = "mit-settings-grid";

    this.serverInput.className = "mit-input";
    this.serverInput.placeholder = "https://translator.example.com";

    this.apiKeyInput.className = "mit-input";
    this.apiKeyInput.placeholder = "可选 API Key";
    this.apiKeyInput.type = "password";

    this.translatorSelect.className = "mit-select";
    for (const option of TRANSLATOR_OPTIONS) {
      const element = document.createElement("option");
      element.value = option.value;
      element.textContent = option.label;
      this.translatorSelect.appendChild(element);
    }

    this.languageSelect.className = "mit-select";
    for (const option of LANGUAGE_OPTIONS) {
      const element = document.createElement("option");
      element.value = option.value;
      element.textContent = option.label;
      this.languageSelect.appendChild(element);
    }

    this.transportSelect.className = "mit-select";
    for (const option of TRANSPORT_OPTIONS) {
      const element = document.createElement("option");
      element.value = option.value;
      element.textContent = option.label;
      this.transportSelect.appendChild(element);
    }

    this.autoCheckbox.type = "checkbox";
    this.concurrencyInput.type = "number";
    this.concurrencyInput.min = "1";
    this.concurrencyInput.max = "6";
    this.concurrencyInput.className = "mit-input";

    grid.append(
      this.createField("Server URL", this.serverInput, true),
      this.createField("API Key", this.apiKeyInput, true),
      this.createField("Translator", this.translatorSelect),
      this.createField("Target", this.languageSelect),
      this.createField("Upload", this.transportSelect),
      this.createSwitchField("Auto Start", this.autoCheckbox),
      this.createField("Concurrency", this.concurrencyInput)
    );

    const actions = document.createElement("div");
    actions.className = "mit-settings-actions";

    const saveButton = this.createButton("保存设置", "primary");
    saveButton.addEventListener("click", () => {
      this.callbacks.onSaveSettings({
        serverBaseUrl: this.serverInput.value.trim(),
        apiKey: this.apiKeyInput.value,
        translator: this.translatorSelect.value as UserscriptSettings["translator"],
        targetLanguage: this.languageSelect.value,
        uploadTransport: this.transportSelect.value as UserscriptSettings["uploadTransport"],
        autoTranslateEnabled: this.autoCheckbox.checked,
        maxConcurrency: Number(this.concurrencyInput.value),
        launcherPosition: this.launcherPosition
      });
    });

    actions.append(saveButton);
    panel.append(grid, actions);

    this.updateSettings(settings);
    return panel;
  }

  private createField(
    label: string,
    control: HTMLInputElement | HTMLSelectElement,
    fullWidth = false
  ): HTMLDivElement {
    const field = document.createElement("div");
    field.className = "mit-field";
    if (fullWidth) {
      field.dataset.full = "true";
    }

    const labelNode = document.createElement("label");
    labelNode.textContent = label;
    field.append(labelNode, control);
    return field;
  }

  private createSwitchField(label: string, checkbox: HTMLInputElement): HTMLDivElement {
    const field = document.createElement("div");
    field.className = "mit-field";

    const labelNode = document.createElement("label");
    labelNode.textContent = label;

    const switchContainer = document.createElement("div");
    switchContainer.className = "mit-switch";

    const caption = document.createElement("span");
    caption.textContent = "加载页面后自动开始扫描";

    switchContainer.append(caption, checkbox);
    field.append(labelNode, switchContainer);
    return field;
  }

  private createOverlayItem(id: string): OverlayItemRefs {
    const container = document.createElement("div");
    container.className = "mit-overlay-item";

    const result = document.createElement("img");
    result.className = "mit-overlay-image";
    result.alt = "Translated manga overlay";

    const badge = document.createElement("div");
    badge.className = "mit-status-card";

    const compactToggle = document.createElement("button");
    compactToggle.type = "button";
    compactToggle.className = "mit-compact-toggle";
    compactToggle.textContent = "翻";

    const details = document.createElement("div");
    details.className = "mit-status-details";

    const head = document.createElement("div");
    head.className = "mit-status-head";

    const status = document.createElement("span");
    status.className = "mit-status-text";

    head.append(status);

    const queue = document.createElement("span");
    queue.className = "mit-status-queue";

    const actions = document.createElement("div");
    actions.className = "mit-status-actions";

    const toggle = this.createButton("显示原图", "ghost");
    const retry = this.createButton("重试", "ghost");
    const cancel = this.createButton("取消", "danger");
    cancel.dataset.tone = "danger";
    const ignore = this.createButton("忽略", "ghost");

    toggle.addEventListener("click", () => this.callbacks.onToggleImageOriginal(id));
    retry.addEventListener("click", () => this.callbacks.onRetryImage(id));
    cancel.addEventListener("click", () => this.callbacks.onCancelImage(id));
    ignore.addEventListener("click", () => this.callbacks.onIgnoreImage(id));
    compactToggle.addEventListener("click", () => {
      if (this.expandedCompactItems.has(id)) {
        this.expandedCompactItems.delete(id);
      } else {
        this.expandedCompactItems.clear();
        this.expandedCompactItems.add(id);
      }
      this.renderImages(Array.from(this.viewModels.values()));
    });

    actions.append(toggle, retry, cancel, ignore);
    details.append(head, queue, actions);
    badge.append(compactToggle, details);
    container.append(result, badge);
    this.overlayLayer.appendChild(container);

    const refs: OverlayItemRefs = {
      container,
      result,
      badge,
      compactToggle,
      details,
      status,
      queue,
      toggle,
      retry,
      cancel,
      ignore
    };
    this.itemRefs.set(id, refs);
    return refs;
  }

  private readonly handleViewportChange = (): void => {
    this.syncPositions();
    this.syncLauncherPosition();
  };

  private readonly handleLauncherMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) {
      return;
    }

    this.startLauncherDrag(event.clientX, event.clientY);
    window.addEventListener("mousemove", this.handleLauncherMouseMove);
    window.addEventListener("mouseup", this.handleLauncherMouseUp);
    window.addEventListener("blur", this.handleLauncherMouseUp);
  };

  private readonly handleLauncherTouchStart = (event: TouchEvent): void => {
    const touch = getTouchPoint(event);
    if (!touch) {
      return;
    }

    this.startLauncherDrag(touch.clientX, touch.clientY);
    window.addEventListener("touchmove", this.handleLauncherTouchMove, {
      passive: false
    });
    window.addEventListener("touchend", this.handleLauncherTouchEnd);
    window.addEventListener("touchcancel", this.handleLauncherTouchEnd);
    window.addEventListener("blur", this.handleLauncherTouchEnd);
  };

  private readonly handleLauncherMouseMove = (event: MouseEvent): void => {
    this.updateLauncherDrag(event.clientX, event.clientY, () => event.preventDefault());
  };

  private readonly handleLauncherMouseUp = (): void => {
    this.finishLauncherDrag();
  };

  private readonly handleLauncherTouchMove = (event: TouchEvent): void => {
    const touch = getTouchPoint(event);
    if (!touch) {
      return;
    }

    this.updateLauncherDrag(touch.clientX, touch.clientY, () => event.preventDefault());
  };

  private readonly handleLauncherTouchEnd = (): void => {
    this.finishLauncherDrag();
  };

  private readonly handleLauncherClickCapture = (event: Event): void => {
    if (!this.suppressLauncherClick) {
      return;
    }

    this.suppressLauncherClick = false;
    event.preventDefault();
    event.stopPropagation();
  };

  private stopLauncherDrag(): void {
    this.launcherGroup.dataset.dragging = "false";
    this.launcherDragState = null;
    window.removeEventListener("mousemove", this.handleLauncherMouseMove);
    window.removeEventListener("mouseup", this.handleLauncherMouseUp);
    window.removeEventListener("touchmove", this.handleLauncherTouchMove);
    window.removeEventListener("touchend", this.handleLauncherTouchEnd);
    window.removeEventListener("touchcancel", this.handleLauncherTouchEnd);
    window.removeEventListener("blur", this.handleLauncherMouseUp);
    window.removeEventListener("blur", this.handleLauncherTouchEnd);
  }

  private clampLauncherPosition(position: LauncherPosition): LauncherPosition {
    const margin = 12;
    const rect = this.launcherGroup.getBoundingClientRect();
    const width = rect.width || 120;
    const height = rect.height || 64;
    const maxX = Math.max(margin, window.innerWidth - width - margin);
    const maxY = Math.max(margin, window.innerHeight - height - margin);

    return {
      x: Math.round(Math.min(Math.max(position.x, margin), maxX)),
      y: Math.round(Math.min(Math.max(position.y, margin), maxY))
    };
  }

  private startLauncherDrag(clientX: number, clientY: number): void {
    const rect = this.launcherGroup.getBoundingClientRect();
    this.launcherDragState = {
      startX: clientX,
      startY: clientY,
      originX: rect.left,
      originY: rect.top,
      moved: false
    };
  }

  private updateLauncherDrag(
    clientX: number,
    clientY: number,
    preventDefault: () => void
  ): void {
    if (!this.launcherDragState) {
      return;
    }

    const deltaX = clientX - this.launcherDragState.startX;
    const deltaY = clientY - this.launcherDragState.startY;
    if (!this.launcherDragState.moved && Math.hypot(deltaX, deltaY) < 4) {
      return;
    }

    preventDefault();
    this.launcherDragState.moved = true;
    this.launcherGroup.dataset.dragging = "true";

    const nextPosition = this.clampLauncherPosition({
      x: this.launcherDragState.originX + deltaX,
      y: this.launcherDragState.originY + deltaY
    });
    this.launcherPosition = nextPosition;
    this.syncLauncherPosition();
  }

  private finishLauncherDrag(): void {
    if (!this.launcherDragState) {
      return;
    }

    const moved = this.launcherDragState.moved;
    this.stopLauncherDrag();
    if (!moved || !this.launcherPosition) {
      return;
    }

    this.suppressLauncherClick = true;
    this.callbacks.onLauncherPositionChange(this.launcherPosition);
  }
}

function createGearIcon(className: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", className);

  const outer = document.createElementNS(SVG_NAMESPACE, "path");
  outer.setAttribute(
    "d",
    "M10.4 2.8h3.2l.5 2.3a7.9 7.9 0 0 1 1.8.7L18 4.4l2.2 2.2-1.4 2.1c.3.6.5 1.2.7 1.8l2.3.5v3.2l-2.3.5a7.9 7.9 0 0 1-.7 1.8l1.4 2.1-2.2 2.2-2.1-1.4c-.6.3-1.2.5-1.8.7l-.5 2.3h-3.2l-.5-2.3a7.9 7.9 0 0 1-1.8-.7L6 20.6l-2.2-2.2 1.4-2.1a7.9 7.9 0 0 1-.7-1.8l-2.3-.5v-3.2l2.3-.5c.1-.6.4-1.3.7-1.8L3.8 6.6 6 4.4l2.1 1.4c.6-.3 1.2-.5 1.8-.7z"
  );

  const inner = document.createElementNS(SVG_NAMESPACE, "circle");
  inner.setAttribute("cx", "12");
  inner.setAttribute("cy", "12");
  inner.setAttribute("r", "3.1");

  svg.append(outer, inner);
  return svg;
}

function getTouchPoint(event: TouchEvent): Pick<Touch, "clientX" | "clientY"> | null {
  const activeTouch = event.touches[0];
  if (activeTouch) {
    return activeTouch;
  }

  const changedTouch = event.changedTouches[0];
  if (changedTouch) {
    return changedTouch;
  }

  return null;
}
