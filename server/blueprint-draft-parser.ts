// Parses ```blueprint-draft fenced JSON blocks emitted during a Project
// Builder conversation (design D2). Unlike spec-draft (partial + merge), each
// blueprint-draft block is a FULL snapshot: the LAST syntactically valid
// block wins outright and there is no merging. Blocks are stripped from the
// chat content before it reaches the WS so the user never sees raw JSON.
//
// Streaming tail cut: the fence regex only matches CLOSED fences, so an
// unterminated trailing block is never parsed. `cutUnterminatedBlock` lets
// stream renderers hide the raw open fence while it is still arriving.
//
// Nothing is dropped silently any more: every block that could not become a
// snapshot is reported in `rejected` (invalid JSON after the tolerant repair
// pass, missing `blueprintVersion`, or a block the output limit cut off before
// its closing fence — `truncated`). The chat manager turns those into an
// automatic repair turn and the UI into a precise, actionable notice.

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
import { parseJsonTolerant } from './json-tolerant'

export type BlueprintRejectionReason = 'invalid_json' | 'missing_version' | 'truncated'

export interface BlueprintRejectedBlock {
  /** 0-based position of the block among every fenced block in the text. */
  index: number
  reason: BlueprintRejectionReason
  /** Human/model-readable diagnostic (parser message + excerpt, or the
   *  number of specs that had started when the output was cut off). */
  detail: string
}

export interface BlueprintParseResult {
  /** Full message text with every `blueprint-draft` fenced block removed —
   *  including an unterminated trailing one, so raw JSON never reaches the
   *  chat transcript. */
  stripped: string
  /** The last VALID snapshot in the text, or null when none parsed. */
  blueprint: Blueprint | null
  /** Exact JSON payload that produced `blueprint`, before compatibility
   * defaults/drop rules. Commit quality gates MUST inspect this value so an
   * invalid model field cannot become valid merely because the read parser is
   * intentionally permissive for legacy blueprints. */
  rawBlueprint: unknown | null
  /** True when at least one fenced block (valid, invalid or truncated) was present. */
  hadBlocks: boolean
  /** Every block that did not become a snapshot, in document order. */
  rejected: BlueprintRejectedBlock[]
  /** True when the winning snapshot only parsed after the tolerant repair pass. */
  repaired: boolean
  /** True when the text ended inside an open fence (the reply was cut off). */
  truncated: boolean
}

const FENCE_RE = /```blueprint-draft\s*\n([\s\S]*?)\n\s*```/g
const OPEN_FENCE_RE = /```blueprint-draft(?![\s\S]*?\n\s*```)/
// Fence tolerance: models mirror the schema example and sometimes emit the
// snapshot inside a ```json (or bare) fence. A closed json/bare block whose
// body is a `{…}` object carrying an integer `blueprintVersion` IS a snapshot
// — it is promoted to a blueprint-draft fence before parsing so the panel
// fills and the raw JSON never lands in the transcript. Never applied inside
// a proper blueprint-draft block (the nested-json case is handled there).
const JSON_BLUEPRINT_FENCE_RE = /```(?:json|JSON)?[ \t]*\r?\n(?=[ \t]*\{)([\s\S]*?)\r?\n[ \t]*```(?=[ \t]*(?:\r?\n|$))/g
const OPEN_JSON_BLUEPRINT_FENCE_RE = /```(?:json|JSON)?[ \t]*\r?\n[ \t]*\{(?=[\s\S]*"blueprintVersion")(?![\s\S]*?\n[ \t]*```)/
/** A lone closing fence right after a matched block — left behind when the
 *  model nested a ```json fence inside the blueprint-draft one. */
const ORPHAN_CLOSE_RE = /^[ \t]*\r?\n?[ \t]*```[ \t]*(?=\r?\n|$)/

/** Promote json / bare fenced blueprint objects to blueprint-draft fences
 *  (outside proper blueprint-draft blocks). Exported for the client mirror
 *  tests' parity checks. */
export function promoteJsonBlueprintFences(text: string): string {
  if (!text || !text.includes('"blueprintVersion"')) return text ?? ''
  const promoteGap = (gap: string): string => {
    if (!gap.includes('```') || !gap.includes('"blueprintVersion"')) return gap
    JSON_BLUEPRINT_FENCE_RE.lastIndex = 0
    return gap.replace(JSON_BLUEPRINT_FENCE_RE, (whole, body: string) => {
      if (!body.includes('"blueprintVersion"')) return whole
      const parsed = parseJsonTolerant(body)
      if (!parsed.ok || !coerceBlueprint(parsed.value)) return whole
      return '```blueprint-draft\n' + body + '\n```'
    })
  }
  let out = ''
  let cursor = 0
  FENCE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = FENCE_RE.exec(text)) !== null) {
    out += promoteGap(text.slice(cursor, m.index)) + m[0]
    cursor = m.index + m[0].length
  }
  return out + promoteGap(text.slice(cursor))
}

/** Rough count of specs that had started in a (possibly truncated) block. */
export function countStartedSpecs(blockText: string): number {
  const at = blockText.indexOf('"m1Specs"')
  if (at === -1) return 0
  return (blockText.slice(at).match(/"title"\s*:/g) ?? []).length
}

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
    if (Array.isArray(obj.repositoryIds) && obj.repositoryIds.length > 0 && obj.repositoryIds.every((id) => typeof id === 'string' && id.trim()) && new Set(obj.repositoryIds).size === obj.repositoryIds.length) {
      spec.repositoryIds = [...obj.repositoryIds] as string[]
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
export function parseBlueprintDraftBlocks(input: string): BlueprintParseResult {
  const text = promoteJsonBlueprintFences(input ?? '')
  if (!text || (!text.includes('```blueprint-draft') && !OPEN_JSON_BLUEPRINT_FENCE_RE.test(text))) {
    return {
      stripped: text ?? '',
      blueprint: null,
      rawBlueprint: null,
      hadBlocks: false,
      rejected: [],
      repaired: false,
      truncated: false,
    }
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
      continue // keep the previous valid snapshot
    }
    const candidate = coerceBlueprint(parsed.value)
    if (!candidate) {
      rejected.push({
        index: blockIndex,
        reason: 'missing_version',
        detail: 'the payload is not a blueprint object with an integer blueprintVersion',
      })
      continue
    }
    blueprint = candidate
    rawBlueprint = parsed.value
    repaired = parsed.repaired
  }
  const remainder = text.slice(cursor)
  const open = OPEN_FENCE_RE.exec(remainder) ?? OPEN_JSON_BLUEPRINT_FENCE_RE.exec(remainder)
  let truncated = false
  if (open) {
    // The reply ended inside a block: the output limit cut it off. Never let
    // the partial JSON reach the transcript; report how far it got instead.
    hadBlocks = true
    truncated = true
    const partial = remainder.slice(open.index)
    const started = countStartedSpecs(partial)
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

/**
 * For live stream rendering: cut an UNTERMINATED trailing `blueprint-draft`
 * fence (and everything after it) so raw JSON never flashes on screen while
 * the block is still arriving. Complete blocks are untouched — run the full
 * parser on the settled text instead.
 */
export function cutUnterminatedBlock(text: string): string {
  if (!text) return ''
  const match = (text.includes('```blueprint-draft') ? OPEN_FENCE_RE.exec(text) : null) ?? OPEN_JSON_BLUEPRINT_FENCE_RE.exec(text)
  if (!match) return text
  return text.slice(0, match.index)
}
