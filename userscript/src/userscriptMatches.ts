export const USERSCRIPT_MATCH_ENV_KEY = "USERSCRIPT_MATCH"

export const DEFAULT_USERSCRIPT_MATCHES = ["*://*/*"] as const

const USERSCRIPT_MATCH_SEPARATOR = /[\n,]+/

export function resolveUserscriptMatches(envValue: string | undefined): string[] {
  if (envValue === undefined) {
    return [...DEFAULT_USERSCRIPT_MATCHES]
  }

  // Tampermonkey 在脚本执行前就会根据 @match 决定是否注入，因此页面范围必须在构建期收敛。
  const matches = Array.from(
    new Set(
      envValue
        .split(USERSCRIPT_MATCH_SEPARATOR)
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    )
  )

  if (matches.length === 0) {
    throw new Error(
      `${USERSCRIPT_MATCH_ENV_KEY} was provided but does not contain a valid @match pattern. ` +
        'Use a comma-separated list like "https://example.com/chapter/*,https://reader.example.org/*".'
    )
  }

  return matches
}
