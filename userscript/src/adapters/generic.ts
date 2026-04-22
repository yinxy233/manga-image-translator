import { resolveDefaultImageSource } from "../utils/image";
import type { SiteAdapterDefinition } from "./types";

export const genericSiteAdapter: SiteAdapterDefinition = {
  id: "generic",
  label: "通用兜底",
  description: "未知站点或未覆盖模板时，按全站可见图片规则兜底处理。",
  domainLabel: "*://*/*",
  defaultEnabled: true,
  matches: () => true,
  getRootSelectors: () => ["body"],
  isImageCandidate: () => true,
  resolveImageSource: resolveDefaultImageSource
};
