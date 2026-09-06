// Shared Blueprint schema types for the Project Builder (design D2).
//
// A Blueprint is the full structured snapshot the day-0 Builder conversation
// converges on: the five interview dimensions (product, core flow, platform,
// stack, M1 constraints via milestones) plus the detailed Milestone-1 specs.
// It travels as fenced ```blueprint-draft JSON blocks during the conversation
// and persists as `<workspace>/.specrails/blueprint.json` after the commit.

export const BLUEPRINT_VERSION = 1

export type MilestoneStatus = 'planned' | 'committed' | 'done'
export type BlueprintSpecKind = 'scaffold' | 'feature' | 'verification'
export type BlueprintSpecPriority = 'critical' | 'high' | 'medium' | 'low'

export interface BlueprintProduct {
  name: string
  pitch: string
  audience: string
}

export interface BlueprintStack {
  language: string
  framework: string
  db: string
  notes?: string
}

export interface BlueprintMilestone {
  id: string
  title: string
  goal: string
  status: MilestoneStatus
  plannedSpecs: string[]
  /**
   * Advisory only — ticket ids inserted for this milestone at commit time.
   * Live progress always derives from the ticket board (label `M<n>`), never
   * from these ids; manual ticket edits/deletes must never break the Builder.
   */
  ticketIds?: number[]
}

export interface BlueprintM1Spec {
  /** Existing-project milestone specs may target several project members. */
  repositoryIds?: string[]
  kind: BlueprintSpecKind
  title: string
  shortSummary: string
  description: string
  acceptanceCriteria: string[]
  priority: BlueprintSpecPriority
  labels: string[]
  /** Index into m1Specs of a spec this one builds on (informational). */
  dependsOnIndex?: number
}

export interface Blueprint {
  blueprintVersion: number
  product: BlueprintProduct
  coreFlow: string
  platform: string
  stack: BlueprintStack
  assumptions: string[]
  milestones: BlueprintMilestone[]
  /** True only after the model has self-audited the complete detailed batch. */
  specsComplete: boolean
  m1Specs: BlueprintM1Spec[]
}

/** Milestone-1 walking-skeleton bounds (proposal: 5–10 specs, scaffold first). */
export const M1_SPECS_MIN = 5
export const M1_SPECS_MAX = 10

const MILESTONE_STATUSES = new Set<MilestoneStatus>(['planned', 'committed', 'done'])
const SPEC_KINDS = new Set<BlueprintSpecKind>(['scaffold', 'feature', 'verification'])
const SPEC_PRIORITIES = new Set<BlueprintSpecPriority>(['critical', 'high', 'medium', 'low'])

export function isMilestoneStatus(value: unknown): value is MilestoneStatus {
  return typeof value === 'string' && MILESTONE_STATUSES.has(value as MilestoneStatus)
}

export function isBlueprintSpecKind(value: unknown): value is BlueprintSpecKind {
  return typeof value === 'string' && SPEC_KINDS.has(value as BlueprintSpecKind)
}

export function isBlueprintSpecPriority(value: unknown): value is BlueprintSpecPriority {
  return typeof value === 'string' && SPEC_PRIORITIES.has(value as BlueprintSpecPriority)
}
