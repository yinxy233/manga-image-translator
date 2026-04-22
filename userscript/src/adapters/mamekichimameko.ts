import { isRasterImageUrl, resolveDefaultImageSource } from "../utils/image";
import type { LocationLike, SiteAdapterDefinition } from "./types";

const ARTICLE_PATH_PATTERN = /^\/archives\/\d+\.html$/;
const ROOT_SELECTORS = [
  ".article-body .article-body-inner",
  "#article-contents.article-body",
  "#article-contents > div:nth-child(1)"
];
const ORIGINAL_IMAGE_HOST = "livedoor.blogimg.jp";

function isArticlePage(location: LocationLike): boolean {
  return location.hostname === "mamekichimameko.blog.jp" && ARTICLE_PATH_PATTERN.test(location.pathname);
}

function resolveOriginalAnchorSource(image: HTMLImageElement): string | null {
  const anchor = image.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) {
    return null;
  }

  try {
    const href = new URL(anchor.href, window.location.href);
    if (href.hostname !== ORIGINAL_IMAGE_HOST || !isRasterImageUrl(href.toString())) {
      return null;
    }
    return href.toString();
  } catch {
    return null;
  }
}

export const mamekichimamekoSiteAdapter: SiteAdapterDefinition = {
  id: "mamekichimameko",
  label: "まめきちまめこ",
  description: "文章正文容器内的漫画图与文末告知图。",
  domainLabel: "mamekichimameko.blog.jp",
  defaultEnabled: true,
  matches: isArticlePage,
  getRootSelectors: () => ROOT_SELECTORS,
  isImageCandidate: () => true,
  resolveImageSource: (image) => {
    // 移动模板会把缩略图包在原图链接里，优先回退到原图地址以避免翻译低清版本。
    return resolveOriginalAnchorSource(image) ?? resolveDefaultImageSource(image);
  }
};
