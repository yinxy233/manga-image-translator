import { beforeEach, describe, expect, it, vi } from "vitest";

import { manga18SiteAdapter } from "../src/adapters/manga18";
import { manhwaRawSiteAdapter } from "../src/adapters/manhwaRaw";
import type { SiteAdapterDefinition } from "../src/adapters/types";
import { ImageDiscovery } from "../src/core/imageDiscovery";
import { resolveDefaultImageSource } from "../src/utils/image";

class FakeIntersectionObserver {
  static instance: FakeIntersectionObserver | null = null;

  private readonly callback: IntersectionObserverCallback;

  observe = vi.fn((_target: Element) => undefined);

  unobserve = vi.fn((_target: Element) => undefined);

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeIntersectionObserver.instance = this;
  }

  disconnect(): void {}

  trigger(target: Element): void {
    this.callback(
      [
        {
          target,
          isIntersecting: true,
          intersectionRatio: 1
        } as IntersectionObserverEntry
      ],
      this as unknown as IntersectionObserver
    );
  }
}

describe("ImageDiscovery", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    FakeIntersectionObserver.instance = null;
  });

  it("only emits images inside active adapter roots", () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const eligible = vi.fn();
    const root = document.createElement("div");
    root.id = "reader";

    const largeImage = document.createElement("img");
    Object.defineProperty(largeImage, "complete", { value: true });
    Object.defineProperty(largeImage, "naturalWidth", { value: 1600 });
    Object.defineProperty(largeImage, "naturalHeight", { value: 2400 });
    Object.defineProperty(largeImage, "currentSrc", { value: "https://example.com/page-1.jpg" });
    largeImage.getBoundingClientRect = () =>
      ({
        width: 600,
        height: 900
      }) as DOMRect;

    const smallImage = document.createElement("img");
    Object.defineProperty(smallImage, "complete", { value: true });
    Object.defineProperty(smallImage, "naturalWidth", { value: 80 });
    Object.defineProperty(smallImage, "naturalHeight", { value: 80 });
    Object.defineProperty(smallImage, "currentSrc", { value: "https://example.com/icon.png" });
    smallImage.getBoundingClientRect = () =>
      ({
        width: 40,
        height: 40
      }) as DOMRect;

    root.append(largeImage);
    document.body.append(root, smallImage);

    const discovery = new ImageDiscovery({
      adapters: [createAdapter({ id: "reader", label: "Reader", getRootSelectors: () => ["#reader"] })],
      onImageEligible: eligible
    });
    discovery.start();
    FakeIntersectionObserver.instance?.trigger(largeImage);
    FakeIntersectionObserver.instance?.trigger(smallImage);

    expect(eligible).toHaveBeenCalledTimes(1);
    expect(eligible).toHaveBeenCalledWith({
      image: largeImage,
      sourceUrl: "https://example.com/page-1.jpg",
      adapterId: "reader"
    });
    discovery.stop();
  });

  it("prefers the first matching adapter when roots overlap", () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const eligible = vi.fn();
    const root = document.createElement("div");
    root.id = "reader";

    const image = document.createElement("img");
    Object.defineProperty(image, "complete", { value: true });
    Object.defineProperty(image, "naturalWidth", { value: 1600 });
    Object.defineProperty(image, "naturalHeight", { value: 2400 });
    Object.defineProperty(image, "currentSrc", { value: "https://example.com/page-1.jpg" });
    image.getBoundingClientRect = () =>
      ({
        width: 600,
        height: 900
      }) as DOMRect;

    root.append(image);
    document.body.append(root);

    const discovery = new ImageDiscovery({
      adapters: [
        createAdapter({ id: "reader", label: "Reader", getRootSelectors: () => ["#reader"] }),
        createAdapter({ id: "generic", label: "Generic", getRootSelectors: () => ["body"] })
      ],
      onImageEligible: eligible
    });
    discovery.start();
    FakeIntersectionObserver.instance?.trigger(image);

    expect(eligible).toHaveBeenCalledTimes(1);
    expect(eligible).toHaveBeenCalledWith({
      image,
      sourceUrl: "https://example.com/page-1.jpg",
      adapterId: "reader"
    });
    discovery.stop();
  });

  it("re-observes known images after reset and rescan", () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const eligible = vi.fn();

    const image = document.createElement("img");
    Object.defineProperty(image, "complete", { value: true });
    Object.defineProperty(image, "naturalWidth", { value: 1200 });
    Object.defineProperty(image, "naturalHeight", { value: 1800 });
    Object.defineProperty(image, "currentSrc", { value: "https://example.com/page-2.jpg" });
    image.getBoundingClientRect = () =>
      ({
        width: 480,
        height: 720
      }) as DOMRect;

    document.body.append(image);

    const discovery = new ImageDiscovery({
      adapters: [createAdapter({ id: "reader", label: "Reader", getRootSelectors: () => ["body"] })],
      onImageEligible: eligible
    });
    discovery.start();
    FakeIntersectionObserver.instance?.trigger(image);

    eligible.mockClear();
    FakeIntersectionObserver.instance?.observe.mockClear();
    FakeIntersectionObserver.instance?.unobserve.mockClear();

    discovery.reset();
    discovery.rescan();

    expect(FakeIntersectionObserver.instance?.unobserve).toHaveBeenCalledWith(image);
    expect(FakeIntersectionObserver.instance?.observe).toHaveBeenCalledWith(image);
    discovery.stop();
  });

  it("can emit all eligible images immediately when full-page scanning is enabled", () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const eligible = vi.fn();

    const image = document.createElement("img");
    Object.defineProperty(image, "complete", { value: true });
    Object.defineProperty(image, "naturalWidth", { value: 1200 });
    Object.defineProperty(image, "naturalHeight", { value: 1800 });
    Object.defineProperty(image, "currentSrc", { value: "https://example.com/page-3.jpg" });
    image.getBoundingClientRect = () =>
      ({
        width: 480,
        height: 720
      }) as DOMRect;

    document.body.append(image);

    const discovery = new ImageDiscovery({
      adapters: [createAdapter({ id: "reader", label: "Reader", getRootSelectors: () => ["body"] })],
      eagerScanEnabled: true,
      onImageEligible: eligible
    });
    discovery.start();

    expect(eligible).toHaveBeenCalledTimes(1);
    expect(eligible).toHaveBeenCalledWith({
      image,
      sourceUrl: "https://example.com/page-3.jpg",
      adapterId: "reader"
    });
    expect(FakeIntersectionObserver.instance?.observe).not.toHaveBeenCalled();
    discovery.stop();
  });

  it("ignores non-chapter images inside the manhwa-raw reading container", () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const eligible = vi.fn();

    const root = document.createElement("div");
    root.className = "reading-content";

    const chapterImage = document.createElement("img");
    chapterImage.className = "wp-manga-chapter-img img-responsive";
    Object.defineProperty(chapterImage, "complete", { value: true });
    Object.defineProperty(chapterImage, "naturalWidth", { value: 1600 });
    Object.defineProperty(chapterImage, "naturalHeight", { value: 2400 });
    Object.defineProperty(chapterImage, "currentSrc", {
      value: "https://zek6.mrawx.cyou/manga/example/01.webp"
    });
    chapterImage.getBoundingClientRect = () =>
      ({
        width: 600,
        height: 900
      }) as DOMRect;

    const bannerImage = document.createElement("img");
    Object.defineProperty(bannerImage, "complete", { value: true });
    Object.defineProperty(bannerImage, "naturalWidth", { value: 1600 });
    Object.defineProperty(bannerImage, "naturalHeight", { value: 400 });
    Object.defineProperty(bannerImage, "currentSrc", {
      value: "https://awi.manhwa-raw.com/wp-content/uploads/banner-raw.jpg"
    });
    bannerImage.getBoundingClientRect = () =>
      ({
        width: 600,
        height: 150
      }) as DOMRect;

    root.append(chapterImage, bannerImage);
    document.body.append(root);

    const discovery = new ImageDiscovery({
      adapters: [manhwaRawSiteAdapter],
      onImageEligible: eligible
    });
    discovery.start();
    FakeIntersectionObserver.instance?.trigger(chapterImage);
    FakeIntersectionObserver.instance?.trigger(bannerImage);

    expect(eligible).toHaveBeenCalledTimes(1);
    expect(eligible).toHaveBeenCalledWith({
      image: chapterImage,
      sourceUrl: "https://zek6.mrawx.cyou/manga/example/01.webp",
      adapterId: "manhwaRaw"
    });
    discovery.stop();
  });

  it("only emits manga18 images declared by slides_p_path", () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const eligible = vi.fn();

    document.body.innerHTML = `
      <script>
        window.slides_p_path = ["${window.btoa("https://img.manga18.club/wireless/059/001.webp")}"];
      </script>
      <section class="chapter-content"></section>
    `;

    const root = document.querySelector(".chapter-content");
    const chapterImage = createLoadedImage("https://img.manga18.club/wireless/059/001.webp");
    const bannerImage = createLoadedImage("https://ads.manga18.club/banner.jpg");
    root?.append(chapterImage, bannerImage);

    const discovery = new ImageDiscovery({
      adapters: [manga18SiteAdapter],
      onImageEligible: eligible
    });
    discovery.start();
    FakeIntersectionObserver.instance?.trigger(chapterImage);
    FakeIntersectionObserver.instance?.trigger(bannerImage);

    expect(eligible).toHaveBeenCalledTimes(1);
    expect(eligible).toHaveBeenCalledWith({
      image: chapterImage,
      sourceUrl: "https://img.manga18.club/wireless/059/001.webp",
      adapterId: "manga18"
    });
    discovery.stop();
  });
});

function createLoadedImage(sourceUrl: string): HTMLImageElement {
  const image = document.createElement("img");
  Object.defineProperty(image, "complete", { value: true });
  Object.defineProperty(image, "naturalWidth", { value: 1200 });
  Object.defineProperty(image, "naturalHeight", { value: 1800 });
  Object.defineProperty(image, "currentSrc", { value: sourceUrl });
  image.getBoundingClientRect = () =>
    ({
      width: 480,
      height: 720
    }) as DOMRect;
  return image;
}

function createAdapter(
  overrides: Partial<SiteAdapterDefinition> & Pick<SiteAdapterDefinition, "id" | "label">
): SiteAdapterDefinition {
  return {
    description: "test adapter",
    domainLabel: "example.com",
    defaultEnabled: true,
    matches: () => true,
    getRootSelectors: () => ["body"],
    isImageCandidate: () => true,
    resolveImageSource: resolveDefaultImageSource,
    ...overrides
  };
}
