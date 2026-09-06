// Client-side types and helpers for the Explore Spec draft model.
// Mirrors server/spec-draft-parser.ts. The client only consumes draft updates
// (it never parses fenced blocks itself — server does that and broadcasts).

export type SpecDraftPriority = 'low' | 'medium' | 'high' | 'critical'

export interface SpecDraft {
  repositoryIds?: string[]
  title: string
  description: string
  labels: string[]
  priority: SpecDraftPriority
  acceptanceCriteria: string[]
}

export const SPEC_DRAFT_FIELDS = [
  'title',
  'description',
  'labels',
  'priority',
  'acceptanceCriteria',
  'repositoryIds',
] as const

export type SpecDraftField = (typeof SPEC_DRAFT_FIELDS)[number]

export const SPEC_DRAFT_DEFAULTS: SpecDraft = {
  title: '',
  description: '',
  labels: [],
  priority: 'medium',
  acceptanceCriteria: [],
}

export interface SpecDraftWsUpdate {
  type: 'spec_draft.update'
  conversationId: string
  draft: Partial<SpecDraft>
  ready: boolean
  chips: string[]
  changedFields: string[]
  timestamp: string
  projectId?: string
}

export function isSpecDraftUpdate(msg: unknown): msg is SpecDraftWsUpdate {
  if (!msg || typeof msg !== 'object') return false
  return (msg as { type?: unknown }).type === 'spec_draft.update'
}
