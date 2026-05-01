import { describe, expect, it } from "vitest"

import {
  BUILT_IN_SITE_USERSCRIPT_MATCHES,
  DEFAULT_USERSCRIPT_MATCHES,
  resolveUserscriptMatches
} from "../src/userscriptMatches"

describe("userscript @match configuration", () => {
  it("falls back to the legacy all-page scope when no build override is provided", () => {
    expect(resolveUserscriptMatches(undefined)).toEqual([...DEFAULT_USERSCRIPT_MATCHES])
  })

  it("includes the manga18 domain in the default userscript metadata", () => {
    expect(DEFAULT_USERSCRIPT_MATCHES).toEqual(
      expect.arrayContaining([...BUILT_IN_SITE_USERSCRIPT_MATCHES])
    )
    expect(BUILT_IN_SITE_USERSCRIPT_MATCHES).toEqual(["*://manga18.club/*"])
  })

  it("parses, deduplicates, and keeps built-in site match patterns", () => {
    expect(
      resolveUserscriptMatches(`https://example.com/chapter/1,
https://reader.example.org/chapter/*
https://example.com/chapter/1`)
    ).toEqual([
      "https://example.com/chapter/1",
      "https://reader.example.org/chapter/*",
      ...BUILT_IN_SITE_USERSCRIPT_MATCHES
    ])
  })

  it("rejects a blank override so the build does not emit invalid userscript metadata", () => {
    expect(() => resolveUserscriptMatches(" , \n ")).toThrow(/USERSCRIPT_MATCH/)
  })
})
