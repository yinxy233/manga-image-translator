import { genericSiteAdapter } from "./generic";
import { mamekichimamekoSiteAdapter } from "./mamekichimameko";
import type { LocationLike, SiteAdapterDefinition, SiteAdapterState } from "./types";

const SITE_SPECIFIC_ADAPTERS: ReadonlyArray<SiteAdapterDefinition> = [mamekichimamekoSiteAdapter];
const ALL_SITE_ADAPTERS: ReadonlyArray<SiteAdapterDefinition> = [...SITE_SPECIFIC_ADAPTERS, genericSiteAdapter];

function isAdapterId(value: string): boolean {
  return ALL_SITE_ADAPTERS.some((adapter) => adapter.id === value);
}

export function getRegisteredSiteAdapters(): ReadonlyArray<SiteAdapterDefinition> {
  return ALL_SITE_ADAPTERS;
}

export function buildDefaultAdapterOverrides(): Record<string, boolean> {
  return Object.fromEntries(
    ALL_SITE_ADAPTERS.map((adapter) => [adapter.id, adapter.defaultEnabled])
  );
}

export function sanitizeAdapterOverrides(input: unknown): Record<string, boolean> {
  const defaults = buildDefaultAdapterOverrides();
  if (!input || typeof input !== "object") {
    return defaults;
  }

  const normalized = { ...defaults };
  for (const [key, value] of Object.entries(input)) {
    if (!isAdapterId(key)) {
      continue;
    }
    normalized[key] = Boolean(value);
  }
  return normalized;
}

export function resolveSiteAdapterStates(
  location: LocationLike,
  adapterOverrides: Record<string, boolean>
): SiteAdapterState[] {
  const siteSpecificStates = SITE_SPECIFIC_ADAPTERS.map((adapter) => {
    const enabled = adapterOverrides[adapter.id] ?? adapter.defaultEnabled;
    const matched = adapter.matches(location);
    return createSiteAdapterState(adapter, enabled, matched, enabled && matched);
  });
  const hasActiveSiteSpecificAdapter = siteSpecificStates.some((state) => state.active);
  const genericEnabled =
    adapterOverrides[genericSiteAdapter.id] ?? genericSiteAdapter.defaultEnabled;
  const genericMatched = !hasActiveSiteSpecificAdapter;

  return [
    ...siteSpecificStates,
    createSiteAdapterState(
      genericSiteAdapter,
      genericEnabled,
      genericMatched,
      genericMatched && genericEnabled
    )
  ];
}

export function resolveActiveSiteAdapters(
  location: LocationLike,
  adapterOverrides: Record<string, boolean>
): SiteAdapterDefinition[] {
  const states = resolveSiteAdapterStates(location, adapterOverrides);
  return states
    .filter((state) => state.active)
    .map((state) => ALL_SITE_ADAPTERS.find((adapter) => adapter.id === state.id))
    .filter((adapter): adapter is SiteAdapterDefinition => Boolean(adapter));
}

function createSiteAdapterState(
  adapter: SiteAdapterDefinition,
  enabled: boolean,
  matched: boolean,
  active: boolean
): SiteAdapterState {
  return {
    id: adapter.id,
    label: adapter.label,
    description: adapter.description,
    domainLabel: adapter.domainLabel,
    defaultEnabled: adapter.defaultEnabled,
    enabled,
    matched,
    active
  };
}
