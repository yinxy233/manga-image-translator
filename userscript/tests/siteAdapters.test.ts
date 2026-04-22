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
