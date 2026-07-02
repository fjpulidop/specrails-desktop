// Shared TypeScript types for the Agents section client code.
// Mirror of server/profile-manager.ts types — kept narrow to avoid a shared package.

export type ModelAlias = 'sonnet' | 'fable' | 'opus' | 'haiku'

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
  orchestrator: { model: ModelAlias }
  agents: ProfileAgent[]
  routing: RoutingRule[]
}

export interface ProfileListEntry {
  name: string
  description?: string
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
