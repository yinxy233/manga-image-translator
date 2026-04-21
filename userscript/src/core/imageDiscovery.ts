import {
  MIN_NATURAL_HEIGHT,
  MIN_NATURAL_WIDTH,
  MIN_RENDER_HEIGHT,
  MIN_RENDER_WIDTH
} from "../config";

export interface ImageDiscoveryOptions {
  onImageEligible: (image: HTMLImageElement) => void;
}

function isSourceRasterImage(imageUrl: string): boolean {
  const normalized = imageUrl.toLowerCase();
  return !normalized.endsWith(".svg") && !normalized.startsWith("data:image/svg");
}

export function getImageSource(image: HTMLImageElement): string | null {
  return image.currentSrc || image.src || null;
}

export function isEligibleRasterImage(image: HTMLImageElement): boolean {
  const source = getImageSource(image);
  if (!source || !isSourceRasterImage(source)) {
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
  private readonly observedImages = new WeakSet<HTMLImageElement>();

  private processedSources = new WeakMap<HTMLImageElement, string>();

  private readonly intersectionObserver: IntersectionObserver;

  private readonly mutationObserver: MutationObserver;

  private readonly onImageEligible: (image: HTMLImageElement) => void;

  constructor(options: ImageDiscoveryOptions) {
    this.onImageEligible = options.onImageEligible;

    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const image = entry.target;
          if (!(image instanceof HTMLImageElement) || !entry.isIntersecting) {
            continue;
          }

          const source = getImageSource(image);
          if (!source || this.processedSources.get(image) === source) {
            continue;
          }

          if (!isEligibleRasterImage(image)) {
            continue;
          }

          this.processedSources.set(image, source);
          this.onImageEligible(image);
        }
      },
      {
        rootMargin: "600px 0px"
      }
    );

    this.mutationObserver = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes" && record.target instanceof HTMLImageElement) {
          this.intersectionObserver.observe(record.target);
          continue;
        }

        for (const node of record.addedNodes) {
          this.scanNode(node);
        }
      }
    });
  }

  start(): void {
    this.scanNode(document.body);
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
    this.scanNode(document.body);
  }

  stop(): void {
    this.intersectionObserver.disconnect();
    this.mutationObserver.disconnect();
  }

  private scanNode(node: Node | null): void {
    if (!node) {
      return;
    }

    if (node instanceof HTMLImageElement) {
      this.observeImage(node);
      return;
    }

    if (node instanceof Element) {
      for (const image of node.querySelectorAll("img")) {
        this.observeImage(image);
      }
    }
  }

  private observeImage(image: HTMLImageElement): void {
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
}
