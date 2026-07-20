// Shared TypeScript types for the Agents section client code.
// Mirror of server/profile-manager.ts types — kept narrow to avoid a shared package.

/** Provider-native model id or a configured custom alias. */
export type ModelAlias = string

export interface ProfileAgent {
  id: string
  model?: ModelAlias
  required?: boolean
}

export interface RoutingTagRule {
  tags: string[]
  agent: string
}

export interface RoutingDefaultRule {
  default: true
  agent: string
}

export type RoutingRule = RoutingTagRule | RoutingDefaultRule

export interface Profile {
  schemaVersion: 1
  name: string
  description?: string
  /** Profiles are provider-bound so model ids never cross runtimes. */
  provider?: string
  orchestrator: { model: ModelAlias }
  agents: ProfileAgent[]
  routing: RoutingRule[]
}

export interface ProfileListEntry {
  name: string
  description?: string
  provider?: string
  isDefault: boolean
  updatedAt: number
}

export const BASELINE_REQUIRED_AGENTS = new Set([
  'sr-architect',
  'sr-developer',
  'sr-reviewer',
  'sr-merge-resolver',
])

export const MODEL_ALIASES: ModelAlias[] = ['sonnet', 'fable', 'opus', 'haiku']

export interface ProfileModelOption {
  value: string
  label: string
}

export interface ProviderProfileCatalog {
  models: ProfileModelOption[]
  defaultModel: string
  baselineAgents: string[]
  customModelAliases?: boolean
}

export interface ProfilesContext {
  primaryProvider: string
  providers: string[]
  catalogs: Record<string, ProviderProfileCatalog>
}
