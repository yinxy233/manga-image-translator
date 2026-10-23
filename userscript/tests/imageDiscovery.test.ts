import { beforeEach, describe, expect, it, vi } from "vitest";

import { manga18SiteAdapter } from "../src/adapters/manga18";
import { manhwaRawSiteAdapter } from "../src/adapters/manhwaRaw";
import { mamekichimamekoSiteAdapter } from "../src/adapters/mamekichimameko";
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

  it.each([
    ["livedoor.sp.blogimg.jp", "1066297c.png", "1066297c.png"],
    ["livedoor.blogimg.jp", "1066297c.png", "1066297c.png"],
    ["livedoor.sp.blogimg.jp", "8b7ceef5.png", "8b7ceef5-s.png"]
  ])("prepares a loaded mameko preview from %s (%s → %s)", (host, previewName, originalName) => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    // Reduced from the live iPhone article: the preview and original are on
    // different hosts, so currentSrc can never equal the translation URL.
    document.body.innerHTML = `
      <div id="article-contents" class="article-body">
        <a href="https://livedoor.blogimg.jp/mamekichimameko/imgs/1/0/${originalName}"></a>
      </div>
    `;
    const image = createLoadedImage(`https://${host}/mamekichimameko/imgs/1/0/${previewName}`);
    document.querySelector("a")?.append(image);
    const eligible = vi.fn();
    const discovery = new ImageDiscovery({
      adapters: [mamekichimamekoSiteAdapter],
      eagerScanEnabled: true,
      onImageEligible: eligible
    });

    const report = discovery.start();
    discovery.rescan();
    image.dispatchEvent(new Event("load"));
    discovery.stop();

    expect(report.waitingForLoad).toBe(0);
    expect(eligible).toHaveBeenCalledOnce();
    expect(eligible).toHaveBeenCalledWith(expect.objectContaining({
      sourceUrl: `https://livedoor.blogimg.jp/mamekichimameko/imgs/1/0/${originalName}`,
      readyForPreparation: true
    }));
  });

  it("waits for a lazy mobile preview, then advances it on load", () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const original = "https://livedoor.blogimg.jp/mamekichimameko/imgs/1/0/1066297c.png";
    const preview = original.replace("livedoor.blogimg.jp", "livedoor.sp.blogimg.jp");
    document.body.innerHTML = `<div id="article-contents" class="article-body"><a href="${original}"></a></div>`;
    const image = createLoadedImage("https://example.com/loading.png");
    image.setAttribute("data-src", preview);
    document.querySelector("a")?.append(image);
    const eligible = vi.fn();
    const discovery = new ImageDiscovery({
      adapters: [mamekichimamekoSiteAdapter], eagerScanEnabled: true, onImageEligible: eligible
    });
    expect(discovery.start().waitingForLoad).toBe(1);
    expect(eligible).toHaveBeenLastCalledWith(expect.objectContaining({ readyForPreparation: false }));

    Object.defineProperty(image, "currentSrc", { configurable: true, value: preview });
    image.dispatchEvent(new Event("load"));
    expect(eligible).toHaveBeenLastCalledWith(expect.objectContaining({
      sourceUrl: original, readyForPreparation: true
    }));
    discovery.stop();
  });

  it.each([
    "https://livedoor.sp.blogimg.jp/mamekichimameko/imgs/1/0/another-image.png",
    "https://other.example/mamekichimameko/imgs/1/0/1066297c.png"
  ])("does not accept an unrelated loaded preview: %s", (preview) => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    document.body.innerHTML = `<div id="article-contents" class="article-body">
      <a href="https://livedoor.blogimg.jp/mamekichimameko/imgs/1/0/1066297c.png"></a></div>`;
    document.querySelector("a")?.append(createLoadedImage(preview));
    const discovery = new ImageDiscovery({
      adapters: [mamekichimamekoSiteAdapter], eagerScanEnabled: true, onImageEligible: vi.fn()
    });
    expect(discovery.start().waitingForLoad).toBe(1);
    discovery.stop();
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
    expect(eligible).toHaveBeenCalledWith(expect.objectContaining({
      image: largeImage,
      sourceUrl: "https://example.com/page-1.jpg",
      adapterId: "reader"
    }));
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
    expect(eligible).toHaveBeenCalledWith(expect.objectContaining({
      image,
      sourceUrl: "https://example.com/page-1.jpg",
      adapterId: "reader"
    }));
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
    expect(eligible).toHaveBeenCalledWith(expect.objectContaining({
      image,
      sourceUrl: "https://example.com/page-3.jpg",
      adapterId: "reader"
    }));
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
    expect(eligible).toHaveBeenCalledWith(expect.objectContaining({
      image: chapterImage,
      sourceUrl: "https://zek6.mrawx.cyou/manga/example/01.webp",
      adapterId: "manhwaRaw"
    }));
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
    expect(eligible).toHaveBeenCalledWith(expect.objectContaining({
      image: chapterImage,
      sourceUrl: "https://img.manga18.club/wireless/059/001.webp",
      adapterId: "manga18"
    }));
    discovery.stop();
  });

  it("reports a lazy image immediately and advances it after the real load", () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const eligible = vi.fn();
    const image = document.createElement("img");
    let complete = false;
    let naturalWidth = 0;
    let naturalHeight = 0;
    image.src = "/loading.gif";
    image.setAttribute("data-src", "https://example.com/chapter-1.webp");
    Object.defineProperty(image, "complete", { configurable: true, get: () => complete });
    Object.defineProperty(image, "naturalWidth", { configurable: true, get: () => naturalWidth });
    Object.defineProperty(image, "naturalHeight", { configurable: true, get: () => naturalHeight });
    Object.defineProperty(image, "currentSrc", { configurable: true, get: () => image.src });
    image.getBoundingClientRect = () => ({
      top: 20,
      bottom: 740,
      width: 480,
      height: 720
    }) as DOMRect;
    document.body.append(image);

    const discovery = new ImageDiscovery({
      adapters: [createAdapter({ id: "reader", label: "Reader" })],
      onImageEligible: eligible
    });
    const report = discovery.start();

    expect(report).toMatchObject({ candidates: 1, added: 1, waitingForLoad: 1 });
    expect(eligible).toHaveBeenLastCalledWith(expect.objectContaining({
      sourceUrl: "https://example.com/chapter-1.webp",
      readyForPreparation: false,
      priority: 0
    }));

    complete = true;
    naturalWidth = 1200;
    naturalHeight = 1800;
    image.src = "https://example.com/chapter-1.webp";
    image.dispatchEvent(new Event("load"));

    expect(eligible).toHaveBeenCalledTimes(2);
    expect(eligible).toHaveBeenLastCalledWith(expect.objectContaining({
      readyForPreparation: true
    }));
    discovery.stop();
  });

  it("emits the latest source revision after a lazy attribute changes", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const eligible = vi.fn();
    const image = createLoadedImage("https://example.com/first.webp");
    image.setAttribute("data-src", "https://example.com/first.webp");
    image.getBoundingClientRect = () => ({
      top: 10,
      bottom: 730,
      width: 480,
      height: 720
    }) as DOMRect;
    document.body.append(image);

    const discovery = new ImageDiscovery({
      adapters: [createAdapter({ id: "reader", label: "Reader" })],
      onImageEligible: eligible
    });
    discovery.start();
    image.setAttribute("data-src", "https://example.com/second.webp");
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(eligible).toHaveBeenLastCalledWith(expect.objectContaining({
      sourceUrl: "https://example.com/second.webp"
    }));
    discovery.stop();
  });

  it("tracks picture source updates and reports removal", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const eligible = vi.fn();
    const removed = vi.fn();
    const picture = document.createElement("picture");
    const source = document.createElement("source");
    source.srcset = "https://example.com/first.webp";
    const image = createLoadedImage("https://example.com/first.webp");
    Object.defineProperty(image, "currentSrc", {
      configurable: true,
      get: () => source.srcset
    });
    image.getBoundingClientRect = () => ({
      top: 10,
      bottom: 730,
      width: 480,
      height: 720
    }) as DOMRect;
    picture.append(source, image);
    document.body.append(picture);

    const discovery = new ImageDiscovery({
      adapters: [createAdapter({ id: "reader", label: "Reader" })],
      onImageEligible: eligible,
      onImageRemoved: removed
    });
    discovery.start();
    source.srcset = "https://example.com/second.webp";
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(eligible).toHaveBeenLastCalledWith(expect.objectContaining({
      sourceUrl: "https://example.com/second.webp"
    }));
    picture.remove();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(removed).toHaveBeenCalledWith(image);
    discovery.stop();
  });

  it("invalidates an active task as soon as its source becomes unavailable", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const eligible = vi.fn();
    const removed = vi.fn();
    const image = createLoadedImage("https://example.com/first.webp");
    image.setAttribute("data-page-source", "https://example.com/first.webp");
    document.body.append(image);
    const discovery = new ImageDiscovery({
      adapters: [createAdapter({
        id: "reader",
        label: "Reader",
        isImageCandidate: (candidate) => Boolean(candidate.getAttribute("data-page-source")),
        resolveImageSource: (candidate) => candidate.getAttribute("data-page-source")
      })],
      eagerScanEnabled: true,
      onImageEligible: eligible,
      onImageRemoved: removed
    });
    discovery.start();

    image.removeAttribute("data-page-source");
    image.setAttribute("src", "");
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(eligible).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledOnce();
    expect(removed).toHaveBeenCalledWith(image);
    discovery.stop();
  });

  it("returns idempotent scan counts for an already reported source", () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const image = createLoadedImage("https://example.com/page.webp");
    document.body.append(image);
    const discovery = new ImageDiscovery({
      adapters: [createAdapter({ id: "reader", label: "Reader" })],
      eagerScanEnabled: true,
      onImageEligible: vi.fn()
    });

    const firstReport = discovery.start();
    const repeatedReport = discovery.rescan();

    expect(firstReport).toMatchObject({ inspected: 1, candidates: 1, added: 1 });
    expect(repeatedReport).toMatchObject({ inspected: 1, candidates: 1, added: 0 });
    discovery.stop();
  });

  it("prepares adapter-wide indexes once per scan instead of once per image", () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const prepareScan = vi.fn();
    document.body.append(
      createLoadedImage("https://example.com/1.webp"),
      createLoadedImage("https://example.com/2.webp"),
      createLoadedImage("https://example.com/3.webp")
    );
    const discovery = new ImageDiscovery({
      adapters: [createAdapter({
        id: "reader",
        label: "Reader",
        prepareScan
      })],
      eagerScanEnabled: true,
      onImageEligible: vi.fn()
    });

    discovery.start();
    expect(prepareScan).toHaveBeenCalledTimes(1);
    discovery.rescan();
    expect(prepareScan).toHaveBeenCalledTimes(2);
    discovery.stop();
  });
});

function createLoadedImage(sourceUrl: string): HTMLImageElement {
  const image = document.createElement("img");
  Object.defineProperty(image, "complete", { value: true });
  Object.defineProperty(image, "naturalWidth", { value: 1200 });
  Object.defineProperty(image, "naturalHeight", { value: 1800 });
  Object.defineProperty(image, "currentSrc", { configurable: true, value: sourceUrl });
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
