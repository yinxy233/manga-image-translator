export const USERSCRIPT_MATCH_ENV_KEY = "USERSCRIPT_MATCH"

export const BUILT_IN_SITE_USERSCRIPT_MATCHES = [
  "*://manga18.club/*"
] as const

export const DEFAULT_USERSCRIPT_MATCHES = [
  // 保留全站兜底以兼容“任意图片站点”模式，同时显式声明已适配站点，便于构建脚本后续收敛注入范围。
  ...BUILT_IN_SITE_USERSCRIPT_MATCHES,
  "*://*/*"
] as const

const USERSCRIPT_MATCH_SEPARATOR = /[\n,]+/

export function resolveUserscriptMatches(envValue: string | undefined): string[] {
  if (envValue === undefined) {
    return [...DEFAULT_USERSCRIPT_MATCHES]
  }

  // Tampermonkey 在脚本执行前就会根据 @match 决定是否注入，因此页面范围必须在构建期收敛。
  const overrideMatches = Array.from(
    new Set(
      envValue
        .split(USERSCRIPT_MATCH_SEPARATOR)
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    )
  )

  if (overrideMatches.length === 0) {
    throw new Error(
      `${USERSCRIPT_MATCH_ENV_KEY} was provided but does not contain a valid @match pattern. ` +
        'Use a comma-separated list like "https://example.com/chapter/*,https://reader.example.org/*".'
    )
  }

  return Array.from(
    new Set([
      ...overrideMatches,
      // 构建环境可能用 USERSCRIPT_MATCH 收敛注入范围；内置适配站点仍需写进打包后的 // @match。
      ...BUILT_IN_SITE_USERSCRIPT_MATCHES
    ])
  )
}
