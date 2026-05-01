import { isRasterImageUrl, resolveDefaultImageSource } from "../utils/image";
import type { LocationLike, SiteAdapterDefinition } from "./types";

const SUPPORTED_HOSTS = new Set(["manga18.club", "www.manga18.club"]);
const CHAPTER_PATH_PATTERN = /^\/(?:manhwa|comic)\/[^/]+\/chapter-[^/]+\/?$/;
const SLIDES_SOURCE_MARKER = "slides_p_path";
const SLIDES_SOURCE_ARRAY_PATTERN = /slides_p_path\s*[:=]\s*\[([\s\S]*?)\]/g;
const BASE64_TOKEN_PATTERN = /["']([A-Za-z0-9+/=]{8,})["']/g;
const PLACEHOLDER_IMAGE_PATTERN = /(?:blank|default|lazy|loader|loading|placeholder|spacer|transparent)\.(?:gif|jpe?g|png|webp)$/i;
const DIRECT_SOURCE_ATTRIBUTES = [
  "data-src",
  "data-original",
  "data-lazy-src",
  "data-url",
  "src"
] as const;
const CHAPTER_IMAGE_ROOT_SELECTORS = [
  "#chapter-content",
  ".chapter-content",
  ".chapter_detail",
  ".chapter-detail",
  ".chapter_content",
  ".read-content",
  ".reader-content",
  ".reading-content",
  ".manga-reader",
  ".manga-reading",
  ".slideshow-container",
  ".swiper-wrapper"
] as const;
const ROOT_SELECTORS = [...CHAPTER_IMAGE_ROOT_SELECTORS, "body"];

function isChapterPage(location: LocationLike): boolean {
  return SUPPORTED_HOSTS.has(location.hostname) && CHAPTER_PATH_PATTERN.test(location.pathname);
}

function normalizeImageUrl(value: string): string | null {
  const trimmedValue = value.trim();
  if (!trimmedValue || !isRasterImageUrl(trimmedValue)) {
    return null;
  }

  try {
    const url = new URL(trimmedValue, window.location.href);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.toString();
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      return null;
    }
    throw error;
  }
}

function decodeBase64ImageUrl(value: string): string | null {
  try {
    return normalizeImageUrl(window.atob(value));
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "InvalidCharacterError") {
      return null;
    }
    throw error;
  }
}

function readSlideImageSources(document: Document): string[] {
  const sources = new Set<string>();

  for (const script of Array.from(document.scripts)) {
    const scriptText = script.textContent ?? "";
    if (!scriptText.includes(SLIDES_SOURCE_MARKER)) {
      continue;
    }

    // Manga18 把正文图片 URL 以 base64 存在 slides_p_path 里；只解析该数组，避免误读同脚本里的其他编码数据。
    for (const arrayMatch of scriptText.matchAll(SLIDES_SOURCE_ARRAY_PATTERN)) {
      for (const sourceMatch of arrayMatch[1].matchAll(BASE64_TOKEN_PATTERN)) {
        const source = decodeBase64ImageUrl(sourceMatch[1]);
        if (source) {
          sources.add(source);
        }
      }
    }
  }

  return Array.from(sources);
}

function resolveDirectImageSource(image: HTMLImageElement): string | null {
  const sourceCandidates = [
    resolveDefaultImageSource(image),
    ...DIRECT_SOURCE_ATTRIBUTES.map((attributeName) => image.getAttribute(attributeName))
  ];

  for (const candidate of sourceCandidates) {
    if (!candidate) {
      continue;
    }

    const source = normalizeImageUrl(candidate);
    if (source) {
      return source;
    }
  }

  return null;
}

function isPlaceholderImageSource(sourceUrl: string): boolean {
  try {
    const url = new URL(sourceUrl, window.location.href);
    if (url.protocol === "blob:" || url.protocol === "data:") {
      return true;
    }
    return PLACEHOLDER_IMAGE_PATTERN.test(url.pathname);
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      return false;
    }
    throw error;
  }
}

function collectIndexedChapterImages(document: Document): HTMLImageElement[] {
  const roots = new Set<Element>();

  for (const selector of CHAPTER_IMAGE_ROOT_SELECTORS) {
    for (const element of document.querySelectorAll(selector)) {
      roots.add(element);
    }
  }

  return Array.from(roots).flatMap((root) =>
    Array.from(root.querySelectorAll<HTMLImageElement>("img"))
  );
}

function resolveIndexedSlideSource(
  image: HTMLImageElement,
  slideSources: ReadonlyArray<string>
): string | null {
  const indexedImages = collectIndexedChapterImages(document);
  const imageIndex = indexedImages.indexOf(image);
  if (imageIndex < 0) {
    return null;
  }

  // 部分模板会先插入占位图再由脚本延迟换源；按阅读容器顺序回填，仍然受 slides_p_path 数量约束。
  return slideSources[imageIndex] ?? null;
}

function resolveChapterImageSource(image: HTMLImageElement): string | null {
  const slideSources = readSlideImageSources(document);
  if (slideSources.length === 0) {
    return null;
  }

  const directSource = resolveDirectImageSource(image);
  if (directSource && slideSources.includes(directSource)) {
    return directSource;
  }

  if (directSource && !isPlaceholderImageSource(directSource)) {
    return null;
  }

  return resolveIndexedSlideSource(image, slideSources);
}

export const manga18SiteAdapter: SiteAdapterDefinition = {
  id: "manga18",
  label: "Manga18",
  description: "章节脚本 slides_p_path 中声明的漫画图片，排除同页广告与封面素材。",
  domainLabel: "manga18.club",
  defaultEnabled: true,
  matches: isChapterPage,
  getRootSelectors: () => ROOT_SELECTORS,
  isImageCandidate: (image) => resolveChapterImageSource(image) !== null,
  resolveImageSource: resolveChapterImageSource
};
