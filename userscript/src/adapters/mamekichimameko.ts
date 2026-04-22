import { isRasterImageUrl, resolveDefaultImageSource } from "../utils/image";
import type { LocationLike, SiteAdapterDefinition } from "./types";

const ARTICLE_PATH_PATTERN = /^\/archives\/\d+\.html$/;
const ROOT_SELECTORS = [
  ".article-body .article-body-inner",
  "#article-contents.article-body",
  "#article-contents > div:nth-child(1)"
];
const ORIGINAL_IMAGE_HOST = "livedoor.blogimg.jp";
const DOM_TWEAK_STYLE_ATTR = "data-mit-site-adapter";
const AD_SELECTORS = [
  ".google-user-ad-top",
  "#top_ad",
  "#article_head_v2",
  "#article_top",
  "#article_bottom_v2",
  ".blog_ad2",
  ".ad2",
  "#recommend_by_genre",
  ".footer-blog-banner",
  "#app-follow-banner",
  "#ldapp-remind-banner",
  "#geniee_overlay_outer",
  "[data-cptid]",
  "[id^=\"div-gpt-ad-\"]",
  "ins.adsbygoogle",
  "[class*=\"fluct-unit-\"]",
  "iframe[id^=\"yads_\"]",
  "iframe[id^=\"google_ads_iframe\"]",
  "iframe[src*=\"doubleclick.net\"]",
  "iframe[src*=\"googlesyndication.com\"]",
  "iframe[src*=\"ad-stir.com\"]",
  "iframe[src*=\"adingo.jp\"]"
];
const AD_HIDE_STYLE_TEXT = `${AD_SELECTORS.join(",\n")} {\n  display: none !important;\n}\n`;

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

function installAdCleanupStyle(document: Document): () => void {
  const existingStyle = document.head?.querySelector<HTMLStyleElement>(
    `style[${DOM_TWEAK_STYLE_ATTR}="mamekichimameko"]`
  );
  if (existingStyle) {
    return () => {
      existingStyle.remove();
    };
  }

  const style = document.createElement("style");
  style.setAttribute(DOM_TWEAK_STYLE_ATTR, "mamekichimameko");
  // 这里只隐藏站点广告与拉活浮层，避免把正文里的告知图误判成广告。
  style.textContent = AD_HIDE_STYLE_TEXT;
  (document.head ?? document.documentElement).appendChild(style);

  return () => {
    style.remove();
  };
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
  },
  installDomTweaks: installAdCleanupStyle
};
