import {
  clearManagedImageSourceUrl,
  setManagedImageSourceUrl
} from "../utils/image";

type NullableAttributeValue = string | null;

interface ImageAttributeSnapshot {
  src: NullableAttributeValue;
  srcset: NullableAttributeValue;
  sizes: NullableAttributeValue;
}

interface PictureSourceSnapshot {
  element: HTMLSourceElement;
  srcset: NullableAttributeValue;
  sizes: NullableAttributeValue;
}

export interface ImageSourceSnapshot {
  image: ImageAttributeSnapshot;
  pictureSources: PictureSourceSnapshot[];
}

export type ImagePresentationMode = "original" | "translated";

export interface ImagePresentationState {
  sourceUrl: string;
  sourceSnapshot: ImageSourceSnapshot;
  appliedMode: ImagePresentationMode;
  appliedResultUrl: string | null;
}

export interface SyncImagePresentationOptions {
  sourceUrl: string;
  resultUrl: string | null;
  showOriginal: boolean;
}

function applyAttribute(
  element: HTMLImageElement | HTMLSourceElement,
  name: "src" | "srcset" | "sizes",
  value: NullableAttributeValue
): void {
  if (value === null) {
    element.removeAttribute(name);
    return;
  }
  element.setAttribute(name, value);
}

function getPictureSources(image: HTMLImageElement): HTMLSourceElement[] {
  const picture = image.parentElement;
  if (!(picture instanceof HTMLPictureElement)) {
    return [];
  }

  return Array.from(picture.children).filter(
    (child): child is HTMLSourceElement => child instanceof HTMLSourceElement
  );
}

function captureSourceSnapshot(image: HTMLImageElement): ImageSourceSnapshot {
  return {
    image: {
      src: image.getAttribute("src"),
      srcset: image.getAttribute("srcset"),
      sizes: image.getAttribute("sizes")
    },
    pictureSources: getPictureSources(image).map((source) => ({
      element: source,
      srcset: source.getAttribute("srcset"),
      sizes: source.getAttribute("sizes")
    }))
  };
}

function matchesSourceSnapshot(
  image: HTMLImageElement,
  sourceSnapshot: ImageSourceSnapshot
): boolean {
  if (
    image.getAttribute("src") !== sourceSnapshot.image.src ||
    image.getAttribute("srcset") !== sourceSnapshot.image.srcset ||
    image.getAttribute("sizes") !== sourceSnapshot.image.sizes
  ) {
    return false;
  }

  const currentSources = getPictureSources(image);
  if (currentSources.length !== sourceSnapshot.pictureSources.length) {
    return false;
  }

  return sourceSnapshot.pictureSources.every((snapshot, index) => {
    const source = currentSources[index];
    return (
      source === snapshot.element &&
      source.getAttribute("srcset") === snapshot.srcset &&
      source.getAttribute("sizes") === snapshot.sizes
    );
  });
}

function isDisplayingTranslatedResult(
  image: HTMLImageElement,
  presentation: ImagePresentationState
): boolean {
  if (!presentation.appliedResultUrl) {
    return false;
  }

  return (
    image.getAttribute("src") === presentation.appliedResultUrl ||
    image.currentSrc === presentation.appliedResultUrl
  );
}

function restoreOriginalSource(
  image: HTMLImageElement,
  presentation: ImagePresentationState
): void {
  for (const sourceSnapshot of presentation.sourceSnapshot.pictureSources) {
    if (!sourceSnapshot.element.isConnected) {
      continue;
    }
    applyAttribute(sourceSnapshot.element, "srcset", sourceSnapshot.srcset);
    applyAttribute(sourceSnapshot.element, "sizes", sourceSnapshot.sizes);
  }

  applyAttribute(image, "src", presentation.sourceSnapshot.image.src);
  applyAttribute(image, "srcset", presentation.sourceSnapshot.image.srcset);
  applyAttribute(image, "sizes", presentation.sourceSnapshot.image.sizes);

  presentation.appliedMode = "original";
  presentation.appliedResultUrl = null;
}

function applyTranslatedSource(
  image: HTMLImageElement,
  presentation: ImagePresentationState,
  resultUrl: string
): void {
  for (const sourceSnapshot of presentation.sourceSnapshot.pictureSources) {
    if (!sourceSnapshot.element.isConnected) {
      continue;
    }
    sourceSnapshot.element.removeAttribute("srcset");
    sourceSnapshot.element.removeAttribute("sizes");
  }

  image.removeAttribute("srcset");
  image.removeAttribute("sizes");
  image.setAttribute("src", resultUrl);

  presentation.appliedMode = "translated";
  presentation.appliedResultUrl = resultUrl;
}

export function createImagePresentationState(
  image: HTMLImageElement,
  sourceUrl: string
): ImagePresentationState {
  setManagedImageSourceUrl(image, sourceUrl);
  return {
    sourceUrl,
    sourceSnapshot: captureSourceSnapshot(image),
    appliedMode: "original",
    appliedResultUrl: null
  };
}

export function refreshImagePresentationState(
  image: HTMLImageElement,
  presentation: ImagePresentationState,
  sourceUrl: string
): void {
  presentation.sourceUrl = sourceUrl;
  setManagedImageSourceUrl(image, sourceUrl);

  if (isDisplayingTranslatedResult(image, presentation)) {
    return;
  }

  presentation.sourceSnapshot = captureSourceSnapshot(image);
  presentation.appliedMode = "original";
  presentation.appliedResultUrl = null;
}

export function syncImagePresentation(
  image: HTMLImageElement,
  presentation: ImagePresentationState,
  options: SyncImagePresentationOptions
): void {
  presentation.sourceUrl = options.sourceUrl;
  setManagedImageSourceUrl(image, options.sourceUrl);

  if (!options.resultUrl || options.showOriginal) {
    if (isDisplayingTranslatedResult(image, presentation)) {
      restoreOriginalSource(image, presentation);
    } else if (!matchesSourceSnapshot(image, presentation.sourceSnapshot)) {
      // 原图模式下同步最新 DOM，避免站点在响应式切图后切回译图时仍使用旧快照。
      presentation.sourceSnapshot = captureSourceSnapshot(image);
    }

    presentation.appliedMode = "original";
    presentation.appliedResultUrl = null;
    return;
  }

  if (
    isDisplayingTranslatedResult(image, presentation) &&
    presentation.appliedResultUrl === options.resultUrl
  ) {
    presentation.appliedMode = "translated";
    return;
  }

  // 只在图片仍处于我们记录的原图状态时重新套用译图，避免站点复用了同一个 <img> 后把旧译图盖到新图上。
  if (
    !matchesSourceSnapshot(image, presentation.sourceSnapshot) &&
    !isDisplayingTranslatedResult(image, presentation)
  ) {
    return;
  }

  applyTranslatedSource(image, presentation, options.resultUrl);
}

export function releaseImagePresentation(
  image: HTMLImageElement,
  presentation: ImagePresentationState
): void {
  if (isDisplayingTranslatedResult(image, presentation)) {
    restoreOriginalSource(image, presentation);
  }

  clearManagedImageSourceUrl(image);
  presentation.appliedMode = "original";
  presentation.appliedResultUrl = null;
}
