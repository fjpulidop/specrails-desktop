/**
 * Provider capability guards.
 *
 * Pure functions with no side effects — safe to call from any render context
 * or test without a React provider wrapper.
 *
 * See openspec/changes/hide-smash-codex-explore.
 */

// Open provider id. The set of valid ids is owned by the server's provider
// registry (surfaced via /available-providers and each project's `providers`),
// not this union — adding a provider needs no edit here. Capability/label
// helpers below already accept `string | null | undefined` and fall back safely.
export type ProviderId = string

/**
 * Returns true when the given provider supports SMASH (Spec decomposition via
 * Contract Layer). SMASH requires a Claude-specific Contract Layer generation
 * step; no Codex equivalent exists.
 *
 * Accepts `string | null | undefined` so callers need not assert type narrowness
 * when the provider has not yet been resolved (null/undefined → false, which is
 * the safe default: hide the hint rather than flash it for Codex users).
 */
export function isSmashCapable(provider: string | null | undefined): boolean {
  return provider === 'claude'
}

/**
 * Returns true when the given provider honours a per-invocation reasoning-effort
 * (low/medium/high) control — so the effort selector should be offered.
 *
 *  - claude: native `--effort <level>` flag (low/medium/high/xhigh/max).
 *  - codex: native via `-c model_reasoning_effort` (none/minimal/low/medium/high/xhigh).
 *  - gemini: NO per-invocation mechanism — gemini-cli only supports thinking levels
 *    via settings.json `thinkingConfig` + custom model aliases (no per-spawn flag),
 *    so the selector is hidden and the adapter ignores `reasoning_effort`.
 * (All verified empirically via each CLI's `--help`.)
 *
 * Mirrors each adapter's server-side `capabilities.supportsReasoningEffort`.
 * null/undefined → false (safe default: hide rather than offer a no-op control).
 */
export function providerSupportsReasoningEffort(provider: string | null | undefined): boolean {
  return provider === 'claude' || provider === 'codex'
}

// ─── Multi-provider capability matrix ────────────────────────────────────────
//
// Right-sidebar sections that depend on a provider-specific mechanic. When a
// project has more than one provider installed we show only the INTERSECTION of
// what every installed provider supports — this prevents surfacing a Claude-only
// section (Agents/Profiles, Integrations/Plugins) for a project that can also run
// jobs on Codex, which has no equivalent. Single-provider projects are
// unaffected: the intersection of one set is that set.

export type SidebarSection =
  | 'dashboard'
  | 'jobs'
  | 'analytics'
  | 'agents'
  | 'code'
  | 'integrations'
  | 'settings'

/** Sections whose backing feature is Claude-only (no Codex equivalent yet). */
const CLAUDE_ONLY_SECTIONS: ReadonlySet<SidebarSection> = new Set<SidebarSection>([
  'agents',
  // 'integrations' is NOT Claude-only: it hosts the provider-agnostic Jira card
  // (shown for every project). Claude-only entries inside it (Serena plugin) are
  // filtered per-provider by IntegrationsPage, not by hiding the whole section.
])

/** True when a single provider supports a given sidebar section. */
export function providerSupportsSection(
  provider: string | null | undefined,
  section: SidebarSection,
): boolean {
  if (!CLAUDE_ONLY_SECTIONS.has(section)) return true
  return provider === 'claude'
}

/**
 * Intersection gate: a section is visible only when EVERY installed provider
 * supports it. An empty/undefined list defaults to Claude behaviour for
 * backward compatibility (everything visible).
 */
export function sectionVisibleForProviders(
  section: SidebarSection,
  providers: readonly string[] | null | undefined,
): boolean {
  const list = providers && providers.length > 0 ? providers : ['claude']
  return list.every((p) => providerSupportsSection(p, section))
}

/** True when the project offers a choice of engines (more than one installed). */
export function isMultiProvider(providers: readonly string[] | null | undefined): boolean {
  return !!providers && providers.length > 1
}

/** Human label for a provider id (UI menus / chips). */
export function providerLabel(provider: string | null | undefined): string {
  if (provider === 'codex') return 'Codex'
  if (provider === 'claude') return 'Claude'
  if (provider === 'gemini') return 'Gemini'
  return provider ?? 'Claude'
}
