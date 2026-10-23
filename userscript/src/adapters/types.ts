export interface LocationLike {
  hostname: string;
  pathname: string;
}

/** Site-specific discovery rules and explicit preview-to-original relationships. */
export interface SiteAdapterDefinition {
  id: string;
  label: string;
  description: string;
  domainLabel: string;
  defaultEnabled: boolean;
  matches(location: LocationLike): boolean;
  getRootSelectors(): string[];
  /** Refresh any page-wide lookup data once before an image discovery pass. */
  prepareScan?(document: Document): void;
  isImageCandidate(image: HTMLImageElement): boolean;
  resolveImageSource(image: HTMLImageElement): string | null;
  /** Accept a loaded site preview for an original URL; never authorizes pixel fallback. */
  isLoadedPreviewForSource?(image: HTMLImageElement, sourceUrl: string): boolean;
  installDomTweaks?(document: Document): void | (() => void);
}

export interface SiteAdapterState {
  id: string;
  label: string;
  description: string;
  domainLabel: string;
  defaultEnabled: boolean;
  enabled: boolean;
  matched: boolean;
  active: boolean;
}
