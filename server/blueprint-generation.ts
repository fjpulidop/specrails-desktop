// App-driven batched generation for the Project Builder (premium-milestone-
// progress D7). Pure helpers — the BlueprintChatManager drives the turns.
//
// Why: "emit all 5–10 specs in ONE response" capped every spec's depth by the
// output budget. The premium protocol splits generation:
//   1. OUTLINE — one full `blueprint-draft` snapshot, every spec with its
//      kind/title/summary/priority/labels/dependency and EMPTY body.
//   2. DETAIL turns — the app asks for two specs at a time; the model answers
//      with `spec-detail` fenced blocks ({ index, spec }) — small, focused
//      payloads the app merges into the snapshot by index.
//   3. AUDIT turn — the model answers with one `spec-audit` block
//      ({ specsComplete, issues[], fixes[] }); the app merges the fixes, sets
//      specsComplete and runs the deterministic gate as before.
// Transcript hygiene: the generation fences are stripped exactly like
// blueprint-draft blocks (never shown as raw JSON).

import { parseJsonTolerant } from './json-tolerant'
import { M1_SPECS_MIN } from './blueprint-types'

export const SPECS_PER_DETAIL_TURN = 2
/** Outline + detail turns + audit + one repair — 10 specs ⇒ 1 + 5 + 1 + 1. */
export const MAX_GENERATION_TURNS = 8

export type GenerationPhase = 'outline' | 'details' | 'audit' | 'repair'

export interface GenerationDescriptor {
  phase: GenerationPhase
  /** 1-based inclusive spec range this phase is about (details/repair). */
  from: number
  to: number
  total: number
  /** 1-based turn ordinal within the generation and the projected total. */
  turn: number
  totalTurns: number
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function specList(raw: unknown): Record<string, unknown>[] | null {
  const source = record(raw)
  if (!source || !Array.isArray(source.m1Specs)) return null
  return source.m1Specs.map((s) => record(s) ?? {})
}

function specIsEmpty(spec: Record<string, unknown>): boolean {
  const description = typeof spec.description === 'string' ? spec.description.trim() : ''
  const criteria = Array.isArray(spec.acceptanceCriteria) ? spec.acceptanceCriteria.filter((c) => typeof c === 'string' && c.trim()) : []
  return description === '' && criteria.length === 0
}

/** True when the snapshot is an OUTLINE: ≥ the batch minimum of specs, none detailed. */
export function isOutlineSnapshot(raw: unknown): boolean {
  const specs = specList(raw)
  if (!specs || specs.length < M1_SPECS_MIN) return false
  return specs.every(specIsEmpty)
}

/** Indices (0-based) of specs still without a body. */
export function unfilledSpecIndices(raw: unknown): number[] {
  const specs = specList(raw)
  if (!specs) return []
  return specs.flatMap((spec, index) => (specIsEmpty(spec) ? [index] : []))
}

/** Next detail range (0-based inclusive) or null when every spec is filled. */
export function nextDetailRange(raw: unknown, perTurn = SPECS_PER_DETAIL_TURN): { from: number; to: number } | null {
  const pending = unfilledSpecIndices(raw)
  if (pending.length === 0) return null
  const from = pending[0]
  const to = Math.min(from + perTurn - 1, pending[pending.length - 1])
  return { from, to }
}

/** Total projected turns for an outline of `total` specs (details + audit). */
export function projectedGenerationTurns(total: number, perTurn = SPECS_PER_DETAIL_TURN): number {
  return 1 + Math.ceil(total / perTurn) + 1
}

export function specTitles(raw: unknown): string[] {
  return (specList(raw) ?? []).map((s) => (typeof s.title === 'string' ? s.title : ''))
}

// ─── Prompts (static apart from the range/titles, so the session cache holds) ─

export function buildDetailPrompt(range: { from: number; to: number }, titles: string[]): string {
  const items = []
  for (let i = range.from; i <= range.to; i++) items.push(`- index ${i}: "${titles[i] ?? ''}"`)
  return `APP CONTINUE: write the FULL premium detail for these outline specs now — every section, every sub-block, ${items.length === 1 ? 'the spec' : 'every spec'} at the depth the contract demands:
${items.join('\n')}

Reply with ONE fenced \`spec-detail\` block per spec and NOTHING else — no prose, no blueprint-draft block. Each block is strictly valid JSON:

\`\`\`spec-detail
{ "index": <the 0-based m1Specs index above>, "spec": { "kind": "...", "title": "...", "shortSummary": "...", "description": "...", "acceptanceCriteria": ["..."], "priority": "...", "labels": ["..."], "dependsOnIndex": <optional> } }
\`\`\`

Keep the index, kind, title, priority, labels and dependsOnIndex the outline already fixed (refine the title only if it was wrong). Newlines inside strings escaped as \\n, inner double quotes as \\", no trailing commas, no comments, no nested fences.`
}

export function buildAuditPrompt(): string {
  return `APP AUDIT: every spec now has a body. Audit the WHOLE Milestone-1 batch against the contract — five headings once and in order, the ### sub-blocks, the section depth floors, ${SPECS_PER_DETAIL_TURN}-spec consistency (titles unique, dependencies strictly backward, scaffold first), 6-10 criteria each with a failure case and an automated verification, English content, priority and labels. Reply with ONE fenced \`spec-audit\` block and NOTHING else:

\`\`\`spec-audit
{ "specsComplete": true, "issues": [], "fixes": [ { "index": <0-based>, "spec": { ...the complete corrected spec... } } ] }
\`\`\`

Put every spec you had to correct in \`fixes\` (complete spec objects, same shape as spec-detail). Set \`specsComplete\` to true only when every spec passes after your fixes; otherwise false with the blocking problems listed in \`issues\`.`
}

export function buildDetailRepairPrompt(range: { from: number; to: number }, titles: string[], detail: string): string {
  const items = []
  for (let i = range.from; i <= range.to; i++) items.push(`- index ${i}: "${titles[i] ?? ''}"`)
  return `APP CHECK: your last reply did not yield usable spec-detail blocks for:
${items.join('\n')}
${detail ? `\nProblem: ${detail}\n` : ''}
Re-emit ONE complete, strictly valid \`spec-detail\` block per spec above (index + complete spec object), and nothing else.`
}

/** Correction turn after an audit that reported blocking problems (D7 §4). */
export function buildAuditIssuesPrompt(issues: readonly string[]): string {
  const list = issues.map((i) => `- ${i}`).join('\n')
  return `APP CHECK: your audit reported blocking problems. Fix EXACTLY these — enrich, never trim — and reply with ONE fenced \`spec-detail\` block per AFFECTED spec ({ "index": <0-based m1Specs index>, "spec": { …the complete corrected spec… } }) and nothing else; untouched specs keep their content.
${list}`
}

// ─── Fenced generation blocks ────────────────────────────────────────────────

const DETAIL_FENCE_RE = /```spec-detail\s*\n([\s\S]*?)\n\s*```/g
const AUDIT_FENCE_RE = /```spec-audit\s*\n([\s\S]*?)\n\s*```/g
const OPEN_GENERATION_FENCE_RE = /```spec-(?:detail|audit)(?![\s\S]*?\n\s*```)/

export interface SpecDetailBlock {
  index: number
  spec: Record<string, unknown>
}

export interface GenerationBlocksResult {
  /** Text with every spec-detail / spec-audit fence removed (transcript-safe). */
  stripped: string
  details: SpecDetailBlock[]
  audit: { specsComplete: boolean; issues: string[]; fixes: SpecDetailBlock[] } | null
  /** Blocks that could not be used, with a model-facing reason. */
  rejected: string[]
  /** The reply ended inside an open generation fence. */
  truncated: boolean
  hadBlocks: boolean
}

function coerceDetail(value: unknown): SpecDetailBlock | null {
  const obj = record(value)
  if (!obj) return null
  const index = obj.index
  const spec = record(obj.spec)
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || !spec) return null
  return { index, spec }
}

/** Extract every closed spec-detail / spec-audit block; strip them from the text. */
export function parseGenerationBlocks(text: string): GenerationBlocksResult {
  const out: GenerationBlocksResult = { stripped: text ?? '', details: [], audit: null, rejected: [], truncated: false, hadBlocks: false }
  if (!text || !/```spec-(?:detail|audit)/.test(text)) return out
  let stripped = ''
  let cursor = 0
  const matches: Array<{ kind: 'detail' | 'audit'; index: number; length: number; body: string }> = []
  DETAIL_FENCE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = DETAIL_FENCE_RE.exec(text)) !== null) matches.push({ kind: 'detail', index: m.index, length: m[0].length, body: m[1] })
  AUDIT_FENCE_RE.lastIndex = 0
  while ((m = AUDIT_FENCE_RE.exec(text)) !== null) matches.push({ kind: 'audit', index: m.index, length: m[0].length, body: m[1] })
  matches.sort((a, b) => a.index - b.index)
  for (const block of matches) {
    if (block.index < cursor) continue // overlapping match (nested fence quirk)
    out.hadBlocks = true
    stripped += text.slice(cursor, block.index)
    cursor = block.index + block.length
    const parsed = parseJsonTolerant(block.body)
    if (!parsed.ok) {
      out.rejected.push(`${block.kind} block: ${parsed.error}${parsed.excerpt ? ` near …${parsed.excerpt}…` : ''}`)
      continue
    }
    if (block.kind === 'detail') {
      const detail = coerceDetail(parsed.value)
      if (!detail) { out.rejected.push('spec-detail block: expected { "index": <integer>, "spec": { … } }'); continue }
      out.details.push(detail)
    } else {
      const obj = record(parsed.value)
      if (!obj) { out.rejected.push('spec-audit block: expected an object'); continue }
      const fixes = Array.isArray(obj.fixes) ? obj.fixes.map(coerceDetail).filter((d): d is SpecDetailBlock => d !== null) : []
      const issues = Array.isArray(obj.issues) ? obj.issues.filter((i): i is string => typeof i === 'string') : []
      out.audit = { specsComplete: obj.specsComplete === true, issues, fixes }
    }
  }
  const remainder = text.slice(cursor)
  const open = OPEN_GENERATION_FENCE_RE.exec(remainder)
  if (open) {
    out.hadBlocks = true
    out.truncated = true
    out.rejected.push('a generation block was cut off before its closing fence')
    stripped += remainder.slice(0, open.index)
  } else {
    stripped += remainder
  }
  out.stripped = stripped
  return out
}

/** Merge spec-detail blocks into a raw snapshot by index (out-of-range ignored). */
export function mergeSpecDetails(raw: unknown, details: readonly SpecDetailBlock[]): unknown {
  const source = record(raw)
  if (!source || !Array.isArray(source.m1Specs)) return raw
  const specs = source.m1Specs.map((s) => (record(s) ? { ...(s as Record<string, unknown>) } : s))
  for (const d of details) {
    if (d.index >= specs.length) continue
    const previous = record(specs[d.index]) ?? {}
    // The outline fixed kind/title/priority/labels/dependency; a detail block
    // may refine them but never DROP them (a missing key keeps the outline's).
    specs[d.index] = { ...previous, ...d.spec }
  }
  return { ...source, m1Specs: specs }
}

export function withSpecsComplete(raw: unknown, specsComplete: boolean): unknown {
  const source = record(raw)
  if (!source) return raw
  return { ...source, specsComplete }
}

/** True when every spec in `range` (0-based inclusive) now has a body. */
export function rangeFilled(raw: unknown, range: { from: number; to: number }): boolean {
  const specs = specList(raw)
  if (!specs) return false
  for (let i = range.from; i <= range.to; i++) {
    const spec = specs[i]
    if (!spec || specIsEmpty(spec)) return false
  }
  return true
}

/** Live-stream helper: cut an UNTERMINATED generation fence (mirrors the client). */
export function cutUnterminatedGenerationBlock(text: string): string {
  if (!text || !/```spec-(?:detail|audit)/.test(text)) return text ?? ''
  const match = OPEN_GENERATION_FENCE_RE.exec(text)
  if (!match) return text
  return text.slice(0, match.index)
}
