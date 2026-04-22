import { describe, expect, it } from "vitest";

import {
  createImagePresentationState,
  releaseImagePresentation,
  syncImagePresentation
} from "../src/core/imagePresentation";
import { getManagedImageSourceUrl } from "../src/utils/image";

function createManagedImage(src: string): HTMLImageElement {
  const image = document.createElement("img");
  image.setAttribute("src", src);
  Object.defineProperty(image, "currentSrc", {
    configurable: true,
    get: () => image.getAttribute("src") ?? ""
  });
  return image;
}

describe("image presentation", () => {
  it("switches a plain image between original and translated sources", () => {
    const image = createManagedImage("https://example.com/original.png");
    const presentation = createImagePresentationState(image, "https://example.com/original.png");

    syncImagePresentation(image, presentation, {
      sourceUrl: "https://example.com/original.png",
      resultUrl: "blob:https://example.com/translated",
      showOriginal: false
    });

    expect(image.getAttribute("src")).toBe("blob:https://example.com/translated");
    expect(presentation.appliedMode).toBe("translated");
    expect(presentation.appliedResultUrl).toBe("blob:https://example.com/translated");

    syncImagePresentation(image, presentation, {
      sourceUrl: "https://example.com/original.png",
      resultUrl: "blob:https://example.com/translated",
      showOriginal: true
    });

    expect(image.getAttribute("src")).toBe("https://example.com/original.png");
    expect(presentation.appliedMode).toBe("original");
    expect(presentation.appliedResultUrl).toBeNull();

    releaseImagePresentation(image, presentation);
    expect(getManagedImageSourceUrl(image)).toBeNull();
  });

  it("restores srcset and sizes on a plain img element", () => {
    const image = createManagedImage("https://example.com/original.png");
    image.setAttribute("srcset", "https://example.com/original.png 1x, https://example.com/original@2x.png 2x");
    image.setAttribute("sizes", "80vw");

    const presentation = createImagePresentationState(image, "https://example.com/original.png");

    syncImagePresentation(image, presentation, {
      sourceUrl: "https://example.com/original.png",
      resultUrl: "blob:https://example.com/translated",
      showOriginal: false
    });

    expect(image.getAttribute("src")).toBe("blob:https://example.com/translated");
    expect(image.getAttribute("srcset")).toBeNull();
    expect(image.getAttribute("sizes")).toBeNull();

    syncImagePresentation(image, presentation, {
      sourceUrl: "https://example.com/original.png",
      resultUrl: "blob:https://example.com/translated",
      showOriginal: true
    });

    expect(image.getAttribute("src")).toBe("https://example.com/original.png");
    expect(image.getAttribute("srcset")).toBe(
      "https://example.com/original.png 1x, https://example.com/original@2x.png 2x"
    );
    expect(image.getAttribute("sizes")).toBe("80vw");
  });

  it("restores picture source candidates after hiding the translated result", () => {
    const picture = document.createElement("picture");
    const source = document.createElement("source");
    source.setAttribute("srcset", "https://example.com/original.webp");
    source.setAttribute("sizes", "100vw");
    const image = createManagedImage("https://example.com/original.png");

    picture.append(source, image);
    document.body.appendChild(picture);

    const presentation = createImagePresentationState(image, "https://example.com/original.png");

    syncImagePresentation(image, presentation, {
      sourceUrl: "https://example.com/original.png",
      resultUrl: "blob:https://example.com/translated",
      showOriginal: false
    });

    expect(source.getAttribute("srcset")).toBeNull();
    expect(source.getAttribute("sizes")).toBeNull();
    expect(image.getAttribute("src")).toBe("blob:https://example.com/translated");

    syncImagePresentation(image, presentation, {
      sourceUrl: "https://example.com/original.png",
      resultUrl: "blob:https://example.com/translated",
      showOriginal: true
    });

    expect(source.getAttribute("srcset")).toBe("https://example.com/original.webp");
    expect(source.getAttribute("sizes")).toBe("100vw");
    expect(image.getAttribute("src")).toBe("https://example.com/original.png");
  });

  it("does not reapply an old translation after the site swaps the image source", () => {
    const image = createManagedImage("https://example.com/original.png");
    const presentation = createImagePresentationState(image, "https://example.com/original.png");

    syncImagePresentation(image, presentation, {
      sourceUrl: "https://example.com/original.png",
      resultUrl: "blob:https://example.com/translated",
      showOriginal: false
    });

    image.setAttribute("src", "https://example.com/new-page.png");

    syncImagePresentation(image, presentation, {
      sourceUrl: "https://example.com/original.png",
      resultUrl: "blob:https://example.com/translated",
      showOriginal: false
    });

    expect(image.getAttribute("src")).toBe("https://example.com/new-page.png");

    releaseImagePresentation(image, presentation);
    expect(image.getAttribute("src")).toBe("https://example.com/new-page.png");
    expect(getManagedImageSourceUrl(image)).toBeNull();
  });
});
