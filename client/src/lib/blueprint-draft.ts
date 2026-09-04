// Client mirror of server/blueprint-draft-parser.ts (add-project-builder D2).
// Full-snapshot last-valid-wins extraction of ```blueprint-draft fenced JSON
// blocks, plus a streaming tail cut so raw JSON never flashes while a block is
// still arriving. Keep the coercion rules in sync with the server module.
//
// Nothing is dropped silently: a block that cannot become a snapshot is
// reported in `rejected` (invalid JSON after the tolerant repair pass, missing
// `blueprintVersion`, or a reply cut off inside the block — `truncated`), and
// `countStreamingSpecs` lets the chat show live generation progress while a
// block is still arriving.

import { parseJsonTolerant } from './json-tolerant'

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
  ticketIds?: number[]
}

export interface BlueprintM1Spec {
  kind: BlueprintSpecKind
  title: string
  shortSummary: string
  description: string
  acceptanceCriteria: string[]
  priority: BlueprintSpecPriority
  labels: string[]
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
  specsComplete: boolean
  m1Specs: BlueprintM1Spec[]
}

const FENCE_RE = /```blueprint-draft\s*\n([\s\S]*?)\n\s*```/g
const OPEN_FENCE_RE = /```blueprint-draft(?![\s\S]*?\n\s*```)/

const MILESTONE_STATUSES = new Set<MilestoneStatus>(['planned', 'committed', 'done'])
const SPEC_KINDS = new Set<BlueprintSpecKind>(['scaffold', 'feature', 'verification'])
const SPEC_PRIORITIES = new Set<BlueprintSpecPriority>(['critical', 'high', 'medium', 'low'])

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
      status: MILESTONE_STATUSES.has(obj.status as MilestoneStatus) ? (obj.status as MilestoneStatus) : 'planned',
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
      kind: SPEC_KINDS.has(obj.kind as BlueprintSpecKind) ? (obj.kind as BlueprintSpecKind) : 'feature',
      title,
      shortSummary: asString(obj.shortSummary),
      description: asString(obj.description),
      acceptanceCriteria: coerceStringArray(obj.acceptanceCriteria),
      priority: SPEC_PRIORITIES.has(obj.priority as BlueprintSpecPriority) ? (obj.priority as BlueprintSpecPriority) : 'medium',
      labels: coerceStringArray(obj.labels),
    }
    if (typeof obj.dependsOnIndex === 'number' && Number.isInteger(obj.dependsOnIndex) && obj.dependsOnIndex >= 0) {
      spec.dependsOnIndex = obj.dependsOnIndex
    }
    out.push(spec)
  }
  return out
}

/** Validate + normalise one parsed payload; null when rejected. */
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

export type BlueprintRejectionReason = 'invalid_json' | 'missing_version' | 'truncated'

export interface BlueprintRejectedBlock {
  index: number
  reason: BlueprintRejectionReason
  detail: string
}

export interface BlueprintParseResult {
  /** Text with every block removed — including an unterminated trailing one. */
  stripped: string
  blueprint: Blueprint | null
  /** Exact last schema-valid JSON payload before legacy-compatible coercion.
   * Keep it for readiness/commit validation; render from `blueprint`. */
  rawBlueprint: unknown | null
  hadBlocks: boolean
  /** Every block that did not become a snapshot, in document order. */
  rejected: BlueprintRejectedBlock[]
  /** The winning snapshot only parsed after the tolerant repair pass. */
  repaired: boolean
  /** The text ended inside an open fence (the reply was cut off). */
  truncated: boolean
}

/** A lone closing fence right after a matched block (nested ```json fence). */
const ORPHAN_CLOSE_RE = /^[ \t]*\r?\n?[ \t]*```[ \t]*(?=\r?\n|$)/

/** Rough count of specs that had started in a (possibly partial) block. */
export function countStartedSpecs(blockText: string): number {
  const at = blockText.indexOf('"m1Specs"')
  if (at === -1) return 0
  return (blockText.slice(at).match(/"title"\s*:/g) ?? []).length
}

/** Scan for closed blueprint-draft fences; the LAST valid snapshot wins. */
export function parseBlueprintDraftBlocks(text: string): BlueprintParseResult {
  if (!text || !text.includes('```blueprint-draft')) {
    return { stripped: text ?? '', blueprint: null, rawBlueprint: null, hadBlocks: false, rejected: [], repaired: false, truncated: false }
  }
  let blueprint: Blueprint | null = null
  let rawBlueprint: unknown | null = null
  let repaired = false
  let hadBlocks = false
  const rejected: BlueprintRejectedBlock[] = []
  let stripped = ''
  let cursor = 0
  let index = 0
  FENCE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FENCE_RE.exec(text)) !== null) {
    hadBlocks = true
    stripped += text.slice(cursor, match.index)
    cursor = match.index + match[0].length
    const orphan = ORPHAN_CLOSE_RE.exec(text.slice(cursor))
    if (orphan) {
      cursor += orphan[0].length
      FENCE_RE.lastIndex = cursor
    }
    const blockIndex = index
    index += 1
    const parsed = parseJsonTolerant(match[1])
    if (!parsed.ok) {
      const where = parsed.excerpt ? ` near: …${parsed.excerpt}…` : ''
      rejected.push({ index: blockIndex, reason: 'invalid_json', detail: `${parsed.error}${where}` })
      continue
    }
    const candidate = coerceBlueprint(parsed.value)
    if (!candidate) {
      rejected.push({ index: blockIndex, reason: 'missing_version', detail: 'the payload is not a blueprint object with an integer blueprintVersion' })
      continue
    }
    blueprint = candidate
    rawBlueprint = parsed.value
    repaired = parsed.repaired
  }
  const remainder = text.slice(cursor)
  const open = OPEN_FENCE_RE.exec(remainder)
  let truncated = false
  if (open) {
    hadBlocks = true
    truncated = true
    const started = countStartedSpecs(remainder.slice(open.index))
    rejected.push({
      index,
      reason: 'truncated',
      detail: started > 0
        ? `the block was cut off before its closing fence after ${started} spec title(s) had started`
        : 'the block was cut off before its closing fence',
    })
    stripped += remainder.slice(0, open.index)
  } else {
    stripped += remainder
  }
  return { stripped, blueprint, rawBlueprint, hadBlocks, rejected, repaired, truncated }
}

/** Live generation progress for a stream buffer: whether a snapshot block is
 *  currently arriving and how many M1 spec titles have started inside it. */
export function describeStreamingSnapshot(buffer: string | null): { generating: boolean; specsStarted: number } {
  if (!buffer || !buffer.includes('```blueprint-draft')) return { generating: false, specsStarted: 0 }
  const open = OPEN_FENCE_RE.exec(buffer)
  if (!open) return { generating: false, specsStarted: 0 }
  return { generating: true, specsStarted: countStartedSpecs(buffer.slice(open.index)) }
}

/** Cut an UNTERMINATED trailing fence for live stream rendering. */
export function cutUnterminatedBlock(text: string): string {
  if (!text || !text.includes('```blueprint-draft')) return text ?? ''
  const match = OPEN_FENCE_RE.exec(text)
  if (!match) return text
  return text.slice(0, match.index)
}

/** The five interview dimensions the live panel tracks (✓/✗ rows). */
export interface BlueprintDimensions {
  product: boolean
  coreFlow: boolean
  platform: boolean
  stack: boolean
  milestones: boolean
}

export function deriveDimensions(blueprint: Blueprint | null): BlueprintDimensions {
  if (!blueprint) {
    return { product: false, coreFlow: false, platform: false, stack: false, milestones: false }
  }
  return {
    product: blueprint.product.name !== '' && blueprint.product.pitch !== '',
    coreFlow: blueprint.coreFlow !== '',
    platform: blueprint.platform !== '',
    stack: blueprint.stack.language !== '' || blueprint.stack.framework !== '',
    milestones: blueprint.milestones.length > 0,
  }
}
