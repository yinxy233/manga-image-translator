import { describe, expect, it } from "vitest"

import { DEFAULT_USERSCRIPT_MATCHES, resolveUserscriptMatches } from "../src/userscriptMatches"

describe("userscript @match configuration", () => {
  it("falls back to the legacy all-page scope when no build override is provided", () => {
    expect(resolveUserscriptMatches(undefined)).toEqual([...DEFAULT_USERSCRIPT_MATCHES])
  })

  it("parses and deduplicates comma or newline separated match patterns", () => {
    expect(
      resolveUserscriptMatches(`https://example.com/chapter/1,
https://reader.example.org/chapter/*
https://example.com/chapter/1`)
    ).toEqual([
      "https://example.com/chapter/1",
      "https://reader.example.org/chapter/*"
    ])
  })

  it("rejects a blank override so the build does not emit invalid userscript metadata", () => {
    expect(() => resolveUserscriptMatches(" , \n ")).toThrow(/USERSCRIPT_MATCH/)
  })
})
