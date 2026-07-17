export interface ContextScope {
  specrails: boolean
  openspec: boolean
  full: boolean
  mcp: boolean
  contractRefine: boolean
  /** Explore-only: inject the user's own already-approved MCP servers
   *  (claude `~/.claude.json`, codex `~/.codex`). Optional for backward compat —
   *  preset literals omit it and it is treated as `false`. */
  userMcp?: boolean
}

export interface ContextBudget {
  specrailsTicketsTokens: number
  openspecSpecsTokens: number
  codebaseFileCount: number
  codebaseEstimatedTokens: number
  mcpServers: string[]
}

export type SpecMode = 'quick' | 'explore' | 'free'

export type Tier = 'Light' | 'Medium' | 'Heavy' | 'Deep'

export function defaultBootScope(mode: SpecMode): ContextScope {
  return {
    specrails: true,
    openspec: false,
    full: mode === 'explore',
    mcp: false,
    contractRefine: false,
    userMcp: false,
  }
}

export function tierFromScope(scope: ContextScope): Tier {
  const weight =
    (scope.specrails ? 1 : 0) +
    (scope.openspec ? 2 : 0) +
    (scope.mcp ? 2 : 0) +
    (scope.full ? 4 : 0) +
    (scope.contractRefine ? 4 : 0)
  if (weight === 0) return 'Light'
  if (weight <= 2) return 'Medium'
  if (weight <= 5) return 'Heavy'
  return 'Deep'
}

export function submitAccentForTier(tier: Tier): string {
  switch (tier) {
    case 'Light': return 'bg-accent-success text-white hover:bg-accent-success/90'
    case 'Medium': return 'bg-accent-info text-white hover:bg-accent-info/90'
    case 'Heavy': return 'bg-accent-warning text-white hover:bg-accent-warning/90'
    case 'Deep': return 'bg-accent-secondary text-white hover:bg-accent-secondary/90'
  }
}

// Coarse per-1k-token price (USD). Used only for the qualitative estimate
// line under the meter — actual cost is captured authoritatively via
// `ai_invocations.total_cost_usd` after the turn settles.
const MODEL_PRICE_PER_1K_INPUT_TOKENS: Record<string, number> = {
  sonnet: 0.003,
  opus: 0.015,
  haiku: 0.0008,
  'gpt-5.5': 0.0015,
  'gpt-5.4-mini': 0.0006,
  'gpt-5.4': 0.005,
  'gpt-5.6-sol': 0.005,
  'gpt-5.6-terra': 0.0025,
  'gpt-5.6-luna': 0.001,
}

export function estimateInputTokens(scope: ContextScope, budget: ContextBudget): number {
  let n = 0
  if (scope.specrails) n += budget.specrailsTicketsTokens ?? 0
  if (scope.openspec) n += budget.openspecSpecsTokens ?? 0
  if (scope.full) n += Math.min(budget.codebaseEstimatedTokens ?? 0, 50_000)
  return n
}

export function estimateCostUsd(scope: ContextScope, budget: ContextBudget, model: string): number {
  const tokens = estimateInputTokens(scope, budget)
  const price = MODEL_PRICE_PER_1K_INPUT_TOKENS[model] ?? 0.003
  return (tokens / 1000) * price
}

export function timeHintForTier(tier: Tier): string {
  switch (tier) {
    case 'Light': return '~15s'
    case 'Medium': return '~30s'
    case 'Heavy': return '~60s'
    case 'Deep': return '~120s'
  }
}

export function quickHintForScope(scope: ContextScope): string {
  return scope.full ? '~45s' : '~15s'
}
