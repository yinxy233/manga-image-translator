export interface LocationLike {
  hostname: string;
  pathname: string;
}

export interface SiteAdapterDefinition {
  id: string;
  label: string;
  description: string;
  domainLabel: string;
  defaultEnabled: boolean;
  matches(location: LocationLike): boolean;
  getRootSelectors(): string[];
  isImageCandidate(image: HTMLImageElement): boolean;
  resolveImageSource(image: HTMLImageElement): string | null;
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
