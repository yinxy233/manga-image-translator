import { describe, expect, it, vi } from "vitest";

import { ImageDiscovery } from "../src/core/imageDiscovery";

class FakeIntersectionObserver {
  static instance: FakeIntersectionObserver | null = null;

  private readonly callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeIntersectionObserver.instance = this;
  }

  observe(_target: Element): void {}

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
  it("ignores small images and emits visible manga pages", () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const eligible = vi.fn();

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

    document.body.append(largeImage, smallImage);

    const discovery = new ImageDiscovery({ onImageEligible: eligible });
    discovery.start();
    FakeIntersectionObserver.instance?.trigger(largeImage);
    FakeIntersectionObserver.instance?.trigger(smallImage);

    expect(eligible).toHaveBeenCalledTimes(1);
    expect(eligible).toHaveBeenCalledWith(largeImage);
  });
});
