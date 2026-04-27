import type { SiteAdapterDefinition } from "../adapters/types";
import {
  MIN_NATURAL_HEIGHT,
  MIN_NATURAL_WIDTH,
  MIN_RENDER_HEIGHT,
  MIN_RENDER_WIDTH
} from "../config";
import { isRasterImageUrl } from "../utils/image";

export interface DiscoveredImageCandidate {
  image: HTMLImageElement;
  sourceUrl: string;
  adapterId: string;
}

export interface ImageDiscoveryOptions {
  adapters: ReadonlyArray<SiteAdapterDefinition>;
  onImageEligible: (candidate: DiscoveredImageCandidate) => void;
  eagerScanEnabled?: boolean;
}

export function isEligibleRasterImage(image: HTMLImageElement, sourceUrl: string): boolean {
  if (!isRasterImageUrl(sourceUrl)) {
    return false;
  }

  if (!image.isConnected) {
    return false;
  }

  const style = window.getComputedStyle(image);
  const opacity = style.opacity || "1";
  if (style.display === "none" || style.visibility === "hidden" || Number(opacity) === 0) {
    return false;
  }

  const rect = image.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }

  const smallRenderedImage =
    Math.max(rect.width, rect.height) < MIN_RENDER_WIDTH &&
    Math.min(rect.width, rect.height) < MIN_RENDER_HEIGHT;

  const smallNaturalImage =
    Math.max(image.naturalWidth, image.naturalHeight) < MIN_NATURAL_WIDTH &&
    Math.min(image.naturalWidth, image.naturalHeight) < MIN_NATURAL_HEIGHT;

  if (smallRenderedImage || smallNaturalImage) {
    return false;
  }

  return true;
}

export class ImageDiscovery {
  private readonly adapters: ReadonlyArray<SiteAdapterDefinition>;

  private readonly observedImages = new WeakSet<HTMLImageElement>();

  private processedSources = new WeakMap<HTMLImageElement, string>();

  private readonly intersectionObserver: IntersectionObserver;

  private readonly mutationObserver: MutationObserver;

  private readonly onImageEligible: (candidate: DiscoveredImageCandidate) => void;

  private readonly eagerScanEnabled: boolean;

  private adapterRoots = new Map<string, Element[]>();

  constructor(options: ImageDiscoveryOptions) {
    this.adapters = options.adapters;
    this.onImageEligible = options.onImageEligible;
    this.eagerScanEnabled = Boolean(options.eagerScanEnabled);

    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const image = entry.target;
          if (!(image instanceof HTMLImageElement) || !entry.isIntersecting) {
            continue;
          }
          this.processEligibleImage(image);
        }
      },
      {
        rootMargin: "600px 0px"
      }
    );

    this.mutationObserver = new MutationObserver((records) => {
      this.refreshAdapterRoots();

      for (const record of records) {
        if (record.type === "attributes" && record.target instanceof HTMLImageElement) {
          this.maybeObserveImage(record.target);
          continue;
        }

        if (record.target instanceof Element && this.isAdapterRoot(record.target)) {
          this.scanNode(record.target);
        }

        for (const node of record.addedNodes) {
          this.scanNode(node);
        }
      }
    });
  }

  start(): void {
    this.refreshAdapterRoots();
    this.scanActiveRoots();

    this.mutationObserver.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["src", "srcset"]
    });
  }

  reset(): void {
    this.processedSources = new WeakMap<HTMLImageElement, string>();
  }

  rescan(): void {
    this.refreshAdapterRoots();
    this.scanActiveRoots();
  }

  stop(): void {
    this.intersectionObserver.disconnect();
    this.mutationObserver.disconnect();
  }

  private scanActiveRoots(): void {
    for (const root of this.collectActiveRoots()) {
      this.scanNode(root);
    }
  }

  private scanNode(node: Node | null): void {
    if (!node) {
      return;
    }

    if (node instanceof HTMLImageElement) {
      this.maybeObserveImage(node);
      return;
    }

    if (node instanceof Element) {
      for (const image of node.querySelectorAll("img")) {
        this.maybeObserveImage(image);
      }
    }
  }

  private maybeObserveImage(image: HTMLImageElement): void {
    const adapter = this.resolveAdapterForImage(image);
    if (!adapter) {
      return;
    }

    if (this.eagerScanEnabled) {
      if (!image.complete) {
        // 整页模式要求在图片一加载完成就立即入队，避免用户必须滚动到目标区域才触发翻译。
        image.addEventListener("load", () => this.processEligibleImage(image), {
          once: true
        });
        return;
      }

      this.processEligibleImage(image, adapter);
      return;
    }

    if (this.observedImages.has(image)) {
      this.intersectionObserver.unobserve(image);
      this.intersectionObserver.observe(image);
      return;
    }

    this.observedImages.add(image);
    if (!image.complete) {
      image.addEventListener("load", () => this.intersectionObserver.observe(image), {
        once: true
      });
    }
    this.intersectionObserver.observe(image);
  }

  private processEligibleImage(
    image: HTMLImageElement,
    adapterOverride?: SiteAdapterDefinition
  ): void {
    const adapter = adapterOverride ?? this.resolveAdapterForImage(image);
    if (!adapter) {
      return;
    }

    const sourceUrl = adapter.resolveImageSource(image);
    if (!sourceUrl) {
      return;
    }

    const processedKey = `${adapter.id}|${sourceUrl}`;
    if (this.processedSources.get(image) === processedKey) {
      return;
    }

    if (!isEligibleRasterImage(image, sourceUrl)) {
      return;
    }

    this.processedSources.set(image, processedKey);
    this.onImageEligible({
      image,
      sourceUrl,
      adapterId: adapter.id
    });
  }

  private resolveAdapterForImage(image: HTMLImageElement): SiteAdapterDefinition | null {
    for (const adapter of this.adapters) {
      if (!adapter.isImageCandidate(image)) {
        continue;
      }

      const roots = this.adapterRoots.get(adapter.id) ?? [];
      if (roots.some((root) => root === image || root.contains(image))) {
        return adapter;
      }
    }

    return null;
  }

  private refreshAdapterRoots(): void {
    const nextRoots = new Map<string, Element[]>();

    for (const adapter of this.adapters) {
      const roots = new Set<Element>();
      for (const selector of adapter.getRootSelectors()) {
        for (const element of document.querySelectorAll(selector)) {
          roots.add(element);
        }
      }
      nextRoots.set(adapter.id, Array.from(roots));
    }

    this.adapterRoots = nextRoots;
  }

  private collectActiveRoots(): Element[] {
    const roots = new Set<Element>();
    for (const adapterRoots of this.adapterRoots.values()) {
      for (const root of adapterRoots) {
        roots.add(root);
      }
    }
    return Array.from(roots);
  }

  private isAdapterRoot(element: Element): boolean {
    for (const adapterRoots of this.adapterRoots.values()) {
      if (adapterRoots.includes(element)) {
        return true;
      }
    }
    return false;
  }
}
