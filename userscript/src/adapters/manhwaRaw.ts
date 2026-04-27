import { resolveDefaultImageSource } from "../utils/image";
import type { LocationLike, SiteAdapterDefinition } from "./types";

const SUPPORTED_HOSTS = new Set(["manhwa-raw.com", "www.manhwa-raw.com"]);
const CHAPTER_PATH_PATTERN = /^\/manga\/[^/]+\/chapter-[^/]+\/?$/;
const ROOT_SELECTORS = [".reading-content"];

function isChapterPage(location: LocationLike): boolean {
  return SUPPORTED_HOSTS.has(location.hostname) && CHAPTER_PATH_PATTERN.test(location.pathname);
}

function isChapterImage(image: HTMLImageElement): boolean {
  // 站点会把横幅图插进同一个阅读容器，必须只放行章节长图，避免把广告与导航图送去翻译。
  return image.classList.contains("wp-manga-chapter-img");
}

function resolveChapterImageSource(image: HTMLImageElement): string | null {
  const sourceUrl = resolveDefaultImageSource(image)?.trim();
  return sourceUrl || null;
}

export const manhwaRawSiteAdapter: SiteAdapterDefinition = {
  id: "manhwaRaw",
  label: "Manhwa Raw",
  description: "章节阅读容器内的漫画长图，排除正文横幅与导航素材。",
  domainLabel: "manhwa-raw.com",
  defaultEnabled: true,
  matches: isChapterPage,
  getRootSelectors: () => ROOT_SELECTORS,
  isImageCandidate: isChapterImage,
  resolveImageSource: resolveChapterImageSource
};
