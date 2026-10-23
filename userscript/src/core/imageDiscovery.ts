import type { SiteAdapterDefinition } from "../adapters/types";
import {
  MIN_NATURAL_HEIGHT,
  MIN_NATURAL_WIDTH,
  MIN_RENDER_HEIGHT,
  MIN_RENDER_WIDTH
} from "../config";
import type { ImageScanReport } from "../types";
import { isImageDisplayingSource, isRasterImageUrl } from "../utils/image";

const OBSERVED_IMAGE_ATTRIBUTES = [
  "src",
  "srcset",
  "sizes",
  "data-src",
  "data-original",
  "data-lazy-src",
  "data-url"
] as const;

const OBSERVED_SOURCE_ATTRIBUTES = ["srcset", "sizes", "media", "type"] as const;

/** One adapter-resolved image revision reported to the controller. */
export interface DiscoveredImageCandidate {
  image: HTMLImageElement;
  sourceUrl: string;
  adapterId: string;
  readyForPreparation: boolean;
  priority: 0 | 1 | 2;
}

/** Configuration for continuously observing ordinary image and picture elements. */
export interface ImageDiscoveryOptions {
  adapters: ReadonlyArray<SiteAdapterDefinition>;
  onImageEligible: (candidate: DiscoveredImageCandidate) => void;
  onImageRemoved?: (image: HTMLImageElement) => void;
  eagerScanEnabled?: boolean;
}

interface ProcessResult {
  candidate: boolean;
  added: boolean;
  waitingForLoad: boolean;
}

interface ProcessedSourceState {
  key: string;
  ready: boolean;
  priority: 0 | 1 | 2;
}

function createEmptyScanReport(): ImageScanReport {
  return {
    inspected: 0,
    candidates: 0,
    added: 0,
    waitingForLoad: 0
  };
}

function isVisibleCandidate(image: HTMLImageElement, sourceUrl: string): boolean {
  if (!isRasterImageUrl(sourceUrl) || !image.isConnected) {
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

  return !(
    Math.max(rect.width, rect.height) < MIN_RENDER_WIDTH &&
    Math.min(rect.width, rect.height) < MIN_RENDER_HEIGHT
  );
}

/** Return whether a loaded image is large enough for manga translation. */
export function isEligibleRasterImage(image: HTMLImageElement, sourceUrl: string): boolean {
  if (!isVisibleCandidate(image, sourceUrl)) {
    return false;
  }

  return !(
    Math.max(image.naturalWidth, image.naturalHeight) < MIN_NATURAL_WIDTH &&
    Math.min(image.naturalWidth, image.naturalHeight) < MIN_NATURAL_HEIGHT
  );
}

function getViewportPriority(image: HTMLImageElement): 0 | 1 | 2 {
  const rect = image.getBoundingClientRect();
  if (rect.bottom >= 0 && rect.top <= window.innerHeight) {
    return 0;
  }
  if (rect.bottom >= -window.innerHeight && rect.top <= window.innerHeight * 2) {
    return 1;
  }
  return 2;
}

function containsDiscoveryMedia(node: Node): boolean {
  if (
    node instanceof HTMLImageElement ||
    node instanceof HTMLSourceElement ||
    node instanceof HTMLScriptElement
  ) {
    return true;
  }
  return node instanceof Element && Boolean(node.querySelector("img, picture > source, script"));
}

/** Continuously discovers adapter-approved images and reports source revisions once. */
export class ImageDiscovery {
  private readonly adapters: ReadonlyArray<SiteAdapterDefinition>;

  private readonly wiredImages = new WeakSet<HTMLImageElement>();

  private readonly intersectionObservedImages = new WeakSet<HTMLImageElement>();

  private processedSources = new WeakMap<HTMLImageElement, ProcessedSourceState>();

  private readonly intersectionObserver: IntersectionObserver;

  private readonly mutationObserver: MutationObserver;

  private readonly onImageEligible: (candidate: DiscoveredImageCandidate) => void;

  private readonly onImageRemoved?: (image: HTMLImageElement) => void;

  private readonly eagerScanEnabled: boolean;

  private adapterRoots = new Map<string, Element[]>();

  constructor(options: ImageDiscoveryOptions) {
    this.adapters = options.adapters;
    this.onImageEligible = options.onImageEligible;
    this.onImageRemoved = options.onImageRemoved;
    this.eagerScanEnabled = Boolean(options.eagerScanEnabled);

    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const image = entry.target;
          if (!(image instanceof HTMLImageElement) || !entry.isIntersecting) {
            continue;
          }
          this.processCandidate(image, true);
        }
      },
      {
        rootMargin: `${Math.max(1, window.innerHeight)}px 0px`
      }
    );

    this.mutationObserver = new MutationObserver((records) => {
      const hasTreeChanges = records.some(
        (record) => record.type === "childList" &&
          [...record.addedNodes, ...record.removedNodes].some(containsDiscoveryMedia)
      );
      if (hasTreeChanges) {
        this.prepareAdapters();
        this.refreshAdapterRoots();
      }

      for (const record of records) {
        if (record.type === "attributes") {
          this.handleAttributeMutation(record.target);
          continue;
        }

        for (const node of record.removedNodes) {
          this.handleRemovedNode(node);
        }
        for (const node of record.addedNodes) {
          this.scanNode(node);
        }
      }
    });
  }

  /** Start the initial scan and install continuous DOM observers. */
  start(): ImageScanReport {
    const report = this.rescan();
    const observationRoot = document.body ?? document.documentElement;
    this.mutationObserver.observe(observationRoot, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        ...OBSERVED_IMAGE_ATTRIBUTES,
        ...OBSERVED_SOURCE_ATTRIBUTES
      ]
    });
    return report;
  }

  /** Forget emission keys so a previously disabled controller can receive the current page. */
  reset(): void {
    this.processedSources = new WeakMap<HTMLImageElement, ProcessedSourceState>();
  }

  /** Inspect every active root once and return a synchronous, user-facing summary. */
  rescan(): ImageScanReport {
    this.prepareAdapters();
    this.refreshAdapterRoots();
    const report = createEmptyScanReport();
    const images = new Set<HTMLImageElement>();

    for (const root of this.collectActiveRoots()) {
      if (root instanceof HTMLImageElement) {
        images.add(root);
      }
      for (const image of root.querySelectorAll<HTMLImageElement>("img")) {
        images.add(image);
      }
    }

    for (const image of images) {
      report.inspected += 1;
      const result = this.maybeObserveImage(image);
      report.candidates += Number(result.candidate);
      report.added += Number(result.added);
      report.waitingForLoad += Number(result.waitingForLoad);
    }
    return report;
  }

  /** Disconnect all observers without changing the page's image elements. */
  stop(): void {
    this.intersectionObserver.disconnect();
    this.mutationObserver.disconnect();
  }

  private prepareAdapters(): void {
    for (const adapter of this.adapters) {
      adapter.prepareScan?.(document);
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
    if (node instanceof HTMLSourceElement) {
      this.handlePictureSource(node);
      return;
    }
    if (node instanceof Element) {
      for (const image of node.querySelectorAll<HTMLImageElement>("img")) {
        this.maybeObserveImage(image);
      }
      for (const source of node.querySelectorAll<HTMLSourceElement>("picture > source")) {
        this.handlePictureSource(source);
      }
    }
  }

  private handleAttributeMutation(target: Node): void {
    if (target instanceof HTMLImageElement) {
      this.maybeObserveImage(target);
      return;
    }
    if (target instanceof HTMLSourceElement) {
      this.handlePictureSource(target);
    }
  }

  private handlePictureSource(source: HTMLSourceElement): void {
    const picture = source.closest("picture");
    const image = picture?.querySelector<HTMLImageElement>("img") ?? null;
    if (!image) {
      return;
    }
    // currentSrc may settle after the source attribute mutation microtask.
    queueMicrotask(() => this.maybeObserveImage(image));
  }

  private handleRemovedNode(node: Node): void {
    const images: HTMLImageElement[] = [];
    if (node instanceof HTMLImageElement) {
      images.push(node);
    } else if (node instanceof Element) {
      images.push(...node.querySelectorAll<HTMLImageElement>("img"));
    }

    for (const image of images) {
      this.intersectionObserver.unobserve(image);
      this.intersectionObservedImages.delete(image);
      this.processedSources.delete(image);
      this.onImageRemoved?.(image);
    }
  }

  private maybeObserveImage(image: HTMLImageElement): ProcessResult {
    if (!this.wiredImages.has(image)) {
      this.wiredImages.add(image);
      image.addEventListener("load", () => this.processCandidate(image, true));
    }

    const priority = getViewportPriority(image);
    const processNow = this.eagerScanEnabled || priority <= 1;
    const result = this.processCandidate(image, processNow);

    if (!this.eagerScanEnabled && !this.intersectionObservedImages.has(image)) {
      this.intersectionObservedImages.add(image);
      this.intersectionObserver.observe(image);
    } else if (!this.eagerScanEnabled) {
      this.intersectionObserver.unobserve(image);
      this.intersectionObserver.observe(image);
    }
    return result;
  }

  private processCandidate(image: HTMLImageElement, allowEmission: boolean): ProcessResult {
    const previous = this.processedSources.get(image);
    const adapter = this.resolveAdapterForImage(image);
    if (!adapter) {
      this.invalidatePreviousCandidate(image, previous);
      return { candidate: false, added: false, waitingForLoad: false };
    }

    const sourceUrl = adapter.resolveImageSource(image);
    if (!sourceUrl) {
      this.invalidatePreviousCandidate(image, previous);
      return { candidate: false, added: false, waitingForLoad: false };
    }

    const key = `${adapter.id}|${sourceUrl}`;
    if (!isVisibleCandidate(image, sourceUrl)) {
      if (previous?.key !== key) {
        this.invalidatePreviousCandidate(image, previous);
      }
      return { candidate: false, added: false, waitingForLoad: false };
    }

    const readyForPreparation = Boolean(
      image.complete &&
      image.naturalWidth > 0 &&
      image.naturalHeight > 0 &&
      // Some sites display a mobile preview while the adapter intentionally
      // downloads its linked original. Waiting for currentSrc to become that
      // original would never finish; only the site adapter may confirm a pair.
      (isImageDisplayingSource(image, sourceUrl) || adapter.isLoadedPreviewForSource?.(image, sourceUrl))
    );
    if (readyForPreparation && !isEligibleRasterImage(image, sourceUrl)) {
      if (previous?.key !== key) {
        this.invalidatePreviousCandidate(image, previous);
      }
      return { candidate: false, added: false, waitingForLoad: false };
    }

    const added = previous?.key !== key;
    const priority = getViewportPriority(image);
    if (
      allowEmission &&
      (added || previous?.ready !== readyForPreparation || priority < (previous?.priority ?? 3))
    ) {
      this.processedSources.set(image, { key, ready: readyForPreparation, priority });
      this.onImageEligible({
        image,
        sourceUrl,
        adapterId: adapter.id,
        readyForPreparation,
        priority
      });
    }

    return {
      candidate: true,
      added: allowEmission && added,
      waitingForLoad: !readyForPreparation
    };
  }

  private invalidatePreviousCandidate(
    image: HTMLImageElement,
    previous: ProcessedSourceState | undefined
  ): void {
    if (!previous) {
      return;
    }
    this.processedSources.delete(image);
    this.onImageRemoved?.(image);
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
}
