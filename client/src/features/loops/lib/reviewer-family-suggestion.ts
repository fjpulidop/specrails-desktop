import type { LoopAgentConfig } from './loops-api'

/** Loop roles marked `inherit` run on the launch provider: the project's primary one. */
export function effectiveRoleProvider(provider: string | undefined, projectProvider: string): string {
  return !provider || provider === 'inherit' ? projectProvider : provider
}

/**
 * The provider to suggest for the reviewer so it runs on a different model family
 * than the developer, or null when there is nothing to suggest (fewer than two
 * usable providers, or the reviewer already differs). Deterministic: Claude and
 * Codex pair with each other first, then Gemini, Kimi, and finally local engines
 * in their detection order.
 */
export function suggestReviewerProvider(agents: LoopAgentConfig['agents'], projectProvider: string, available: readonly string[]): string | null {
  if (new Set(available).size < 2) return null
  const developer = effectiveRoleProvider(agents.developer?.provider, projectProvider)
  const reviewer = effectiveRoleProvider(agents.reviewer?.provider, projectProvider)
  if (reviewer !== developer) return null
  const cli = developer === 'claude' ? ['codex', 'claude', 'gemini', 'kimi'] : ['claude', 'codex', 'gemini', 'kimi']
  const ordered = [...cli.filter(id => available.includes(id)), ...available.filter(id => !cli.includes(id))]
  return ordered.find(id => id !== developer) ?? null
}
