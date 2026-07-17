// Parses ```blueprint-draft fenced JSON blocks emitted during a Project
// Builder conversation (design D2). Unlike spec-draft (partial + merge), each
// blueprint-draft block is a FULL snapshot: the LAST syntactically valid
// block wins outright and there is no merging. Blocks are stripped from the
// chat content before it reaches the WS so the user never sees raw JSON.
//
// Streaming tail cut: the fence regex only matches CLOSED fences, so an
// unterminated trailing block is never parsed. `cutUnterminatedBlock` lets
// stream renderers hide the raw open fence while it is still arriving.

import {
  Blueprint,
  BlueprintM1Spec,
  BlueprintMilestone,
  BlueprintProduct,
  BlueprintStack,
  isBlueprintSpecKind,
  isBlueprintSpecPriority,
  isMilestoneStatus,
} from './blueprint-types'

export interface BlueprintParseResult {
  /** Full message text with every `blueprint-draft` fenced block removed. */
  stripped: string
  /** The last VALID snapshot in the text, or null when none parsed. */
  blueprint: Blueprint | null
  /** Exact JSON payload that produced `blueprint`, before compatibility
   * defaults/drop rules. Commit quality gates MUST inspect this value so an
   * invalid model field cannot become valid merely because the read parser is
   * intentionally permissive for legacy blueprints. */
  rawBlueprint: unknown | null
  /** True when at least one fenced block (valid or not) was present. */
  hadBlocks: boolean
}

const FENCE_RE = /```blueprint-draft\s*\n([\s\S]*?)\n\s*```/g
const OPEN_FENCE_RE = /```blueprint-draft(?![\s\S]*?\n\s*```)/

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function coerceProduct(value: unknown): BlueprintProduct {
  const obj = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>
  return { name: asString(obj.name), pitch: asString(obj.pitch), audience: asString(obj.audience) }
}

function coerceStack(value: unknown): BlueprintStack {
  const obj = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>
  const stack: BlueprintStack = {
    language: asString(obj.language),
    framework: asString(obj.framework),
    db: asString(obj.db),
  }
  if (typeof obj.notes === 'string' && obj.notes !== '') stack.notes = obj.notes
  return stack
}

function coerceMilestones(value: unknown): BlueprintMilestone[] {
  if (!Array.isArray(value)) return []
  const out: BlueprintMilestone[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const obj = item as Record<string, unknown>
    const id = asString(obj.id)
    const title = asString(obj.title)
    if (id === '' && title === '') continue
    const milestone: BlueprintMilestone = {
      id,
      title,
      goal: asString(obj.goal),
      status: isMilestoneStatus(obj.status) ? obj.status : 'planned',
      plannedSpecs: coerceStringArray(obj.plannedSpecs),
    }
    if (Array.isArray(obj.ticketIds)) {
      const ids = obj.ticketIds.filter((n): n is number => typeof n === 'number' && Number.isInteger(n))
      if (ids.length > 0) milestone.ticketIds = ids
    }
    out.push(milestone)
  }
  return out
}

function coerceM1Specs(value: unknown): BlueprintM1Spec[] {
  if (!Array.isArray(value)) return []
  const out: BlueprintM1Spec[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const obj = item as Record<string, unknown>
    const title = asString(obj.title)
    if (title === '') continue
    const spec: BlueprintM1Spec = {
      kind: isBlueprintSpecKind(obj.kind) ? obj.kind : 'feature',
      title,
      shortSummary: asString(obj.shortSummary),
      description: asString(obj.description),
      acceptanceCriteria: coerceStringArray(obj.acceptanceCriteria),
      priority: isBlueprintSpecPriority(obj.priority) ? obj.priority : 'medium',
      labels: coerceStringArray(obj.labels),
    }
    if (typeof obj.dependsOnIndex === 'number' && Number.isInteger(obj.dependsOnIndex) && obj.dependsOnIndex >= 0) {
      spec.dependsOnIndex = obj.dependsOnIndex
    }
    out.push(spec)
  }
  return out
}

/**
 * Validate + normalise one parsed JSON payload into a Blueprint snapshot.
 * Unknown keys are dropped; missing sub-objects default to empty values. A
 * missing or non-integer `blueprintVersion` rejects the block (spec gate).
 */
export function coerceBlueprint(parsed: unknown): Blueprint | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  if (typeof obj.blueprintVersion !== 'number' || !Number.isInteger(obj.blueprintVersion)) return null
  return {
    blueprintVersion: obj.blueprintVersion,
    product: coerceProduct(obj.product),
    coreFlow: asString(obj.coreFlow),
    platform: asString(obj.platform),
    stack: coerceStack(obj.stack),
    assumptions: coerceStringArray(obj.assumptions),
    milestones: coerceMilestones(obj.milestones),
    specsComplete: obj.specsComplete === true,
    m1Specs: coerceM1Specs(obj.m1Specs),
  }
}

/**
 * Scan `text` for `blueprint-draft` fenced blocks. Returns the text with
 * every block (valid or malformed) stripped, plus the LAST valid snapshot.
 * Never throws.
 */
export function parseBlueprintDraftBlocks(text: string): BlueprintParseResult {
  if (!text || !text.includes('```blueprint-draft')) {
    return { stripped: text ?? '', blueprint: null, rawBlueprint: null, hadBlocks: false }
  }

  let blueprint: Blueprint | null = null
  let rawBlueprint: unknown | null = null
  let hadBlocks = false
  let stripped = ''
  let cursor = 0
  FENCE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FENCE_RE.exec(text)) !== null) {
    hadBlocks = true
    stripped += text.slice(cursor, match.index)
    cursor = match.index + match[0].length
    let parsed: unknown
    try {
      parsed = JSON.parse(match[1])
    } catch {
      continue // malformed; drop silently, keep the previous valid snapshot
    }
    const candidate = coerceBlueprint(parsed)
    if (candidate) {
      blueprint = candidate
      rawBlueprint = parsed
    }
  }
  stripped += text.slice(cursor)
  return { stripped, blueprint, rawBlueprint, hadBlocks }
}

/**
 * For live stream rendering: cut an UNTERMINATED trailing `blueprint-draft`
 * fence (and everything after it) so raw JSON never flashes on screen while
 * the block is still arriving. Complete blocks are untouched — run the full
 * parser on the settled text instead.
 */
export function cutUnterminatedBlock(text: string): string {
  if (!text || !text.includes('```blueprint-draft')) return text ?? ''
  const match = OPEN_FENCE_RE.exec(text)
  if (!match) return text
  return text.slice(0, match.index)
}
