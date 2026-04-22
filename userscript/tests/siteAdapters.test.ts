import { describe, expect, it } from "vitest";

import {
  buildDefaultAdapterOverrides,
  resolveActiveSiteAdapters,
  resolveSiteAdapterStates
} from "../src/adapters";

describe("site adapter registry", () => {
  it("activates the mamekichimameko adapter for desktop article pages", () => {
    const states = resolveSiteAdapterStates(
      new URL("https://mamekichimameko.blog.jp/archives/91257494.html"),
      buildDefaultAdapterOverrides()
    );
    const activeAdapters = resolveActiveSiteAdapters(
      new URL("https://mamekichimameko.blog.jp/archives/91257494.html"),
      buildDefaultAdapterOverrides()
    );

    expect(states.find((state) => state.id === "mamekichimameko")).toMatchObject({
      matched: true,
      active: true
    });
    expect(states.find((state) => state.id === "generic")).toMatchObject({
      matched: false,
      active: false
    });
    expect(activeAdapters.map((adapter) => adapter.id)).toEqual(["mamekichimameko"]);
  });

  it("activates the mamekichimameko adapter for mobile article pages", () => {
    const activeAdapters = resolveActiveSiteAdapters(
      new URL("https://mamekichimameko.blog.jp/archives/91257494.html?sp=1"),
      buildDefaultAdapterOverrides()
    );

    expect(activeAdapters.map((adapter) => adapter.id)).toEqual(["mamekichimameko"]);
  });

  it("installs ad-hiding DOM tweaks for mamekichimameko article pages", () => {
    const [activeAdapter] = resolveActiveSiteAdapters(
      new URL("https://mamekichimameko.blog.jp/archives/91234726.html?sp=1"),
      buildDefaultAdapterOverrides()
    );

    const cleanup = activeAdapter?.installDomTweaks?.(document);
    const style = document.head.querySelector('style[data-mit-site-adapter="mamekichimameko"]');

    expect(activeAdapter?.id).toBe("mamekichimameko");
    expect(style?.textContent).toContain("#article_top");
    expect(style?.textContent).toContain("#geniee_overlay_outer");
    expect(style?.textContent).toContain('iframe[src*="doubleclick.net"]');

    cleanup?.();
    expect(document.head.querySelector('style[data-mit-site-adapter="mamekichimameko"]')).toBeNull();
  });

  it("falls back to the generic adapter outside supported article pages", () => {
    const states = resolveSiteAdapterStates(
      new URL("https://mamekichimameko.blog.jp/"),
      buildDefaultAdapterOverrides()
    );
    const activeAdapters = resolveActiveSiteAdapters(
      new URL("https://mamekichimameko.blog.jp/"),
      buildDefaultAdapterOverrides()
    );

    expect(states.find((state) => state.id === "mamekichimameko")).toMatchObject({
      matched: false,
      active: false
    });
    expect(states.find((state) => state.id === "generic")).toMatchObject({
      matched: true,
      active: true
    });
    expect(activeAdapters.map((adapter) => adapter.id)).toEqual(["generic"]);
  });
});
