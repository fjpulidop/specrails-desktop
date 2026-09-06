// Parses ` ```spec-draft ` fenced JSON blocks emitted by Claude during an
// Explore Spec conversation. Each block carries a partial structured draft
// that the app merges into the per-conversation latest draft state and
// broadcasts to clients. Blocks are stripped from the chat content before it
// reaches the WS so the user never sees raw JSON.

const VALID_PRIORITIES = new Set(['low', 'medium', 'high', 'critical'] as const)
export type SpecDraftPriority = 'low' | 'medium' | 'high' | 'critical'

export interface SpecDraft {
  repositoryIds?: string[]
  title: string
  description: string
  labels: string[]
  priority: SpecDraftPriority
  acceptanceCriteria: string[]
}

export interface ParsedSpecDraftBlock {
  partial: Partial<SpecDraft>
  ready: boolean
  chips: string[]
}

export interface ParseResult {
  /** Full message text with every `spec-draft` fenced block removed. */
  stripped: string
  /** Each parsed block in order; empty when the message has no blocks. */
  blocks: ParsedSpecDraftBlock[]
}

const FENCE_RE = /```spec-draft\s*\n([\s\S]*?)\n```/g

function coerceStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string') out.push(item)
  }
  return out
}

function validateBlock(parsed: unknown): ParsedSpecDraftBlock | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  const partial: Partial<SpecDraft> = {}

  if (typeof obj.title === 'string') partial.title = obj.title
  if (typeof obj.description === 'string') partial.description = obj.description
  if (Array.isArray(obj.repositoryIds) && obj.repositoryIds.length > 0 && obj.repositoryIds.every((id) => typeof id === 'string' && id.trim()) && new Set(obj.repositoryIds).size === obj.repositoryIds.length) {
    partial.repositoryIds = [...obj.repositoryIds] as string[]
  }
  const labels = coerceStringArray(obj.labels)
  if (labels) partial.labels = labels
  const ac = coerceStringArray(obj.acceptanceCriteria)
  if (ac) partial.acceptanceCriteria = ac
  if (typeof obj.priority === 'string' && VALID_PRIORITIES.has(obj.priority as SpecDraftPriority)) {
    partial.priority = obj.priority as SpecDraftPriority
  }

  const chips = coerceStringArray(obj.chips) ?? []
  const ready = obj.ready === true

  return { partial, ready, chips }
}

/**
 * Scan `text` for `spec-draft` fenced blocks. Returns the text with each
 * block (including its fences) stripped, plus every successfully-parsed
 * block in the order they appeared. Malformed JSON / non-object payloads
 * are silently dropped (their fenced span is still stripped) — the parser
 * never throws.
 */
export function parseSpecDraftBlocks(text: string): ParseResult {
  if (!text || !text.includes('```spec-draft')) {
    return { stripped: text ?? '', blocks: [] }
  }

  const blocks: ParsedSpecDraftBlock[] = []
  let stripped = ''
  let cursor = 0
  FENCE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FENCE_RE.exec(text)) !== null) {
    stripped += text.slice(cursor, match.index)
    cursor = match.index + match[0].length
    let parsed: unknown
    try {
      parsed = JSON.parse(match[1])
    } catch {
      // malformed; drop silently but still strip the fence
      continue
    }
    const block = validateBlock(parsed)
    if (block) blocks.push(block)
  }
  stripped += text.slice(cursor)
  return { stripped, blocks }
}

/**
 * Shallow-merge a parsed block into a draft. Empty strings and undefined
 * are no-ops. Arrays replace (caller controls authority). Returns a new
 * draft object — never mutates `prev`.
 */
export function mergeDraft(prev: Partial<SpecDraft>, next: Partial<SpecDraft>): Partial<SpecDraft> {
  const out: Partial<SpecDraft> = { ...prev }
  if (typeof next.title === 'string' && next.title !== '') out.title = next.title
  if (typeof next.description === 'string' && next.description !== '') out.description = next.description
  if (Array.isArray(next.repositoryIds) && next.repositoryIds.length > 0 && next.repositoryIds.every((id) => typeof id === 'string' && id.trim()) && new Set(next.repositoryIds).size === next.repositoryIds.length) out.repositoryIds = next.repositoryIds.slice()
  if (Array.isArray(next.labels)) out.labels = next.labels.slice()
  if (Array.isArray(next.acceptanceCriteria)) out.acceptanceCriteria = next.acceptanceCriteria.slice()
  if (next.priority && VALID_PRIORITIES.has(next.priority)) out.priority = next.priority
  return out
}

export interface ConversationDraftState {
  draft: Partial<SpecDraft>
  ready: boolean
  chips: string[]
  /** Returns the field keys that changed in the most recent merge. */
  lastChangedFields: ReadonlyArray<keyof SpecDraft>
}

/** Apply every block from a parse result to a conversation's draft state. */
export function applyBlocks(
  prev: ConversationDraftState | undefined,
  blocks: ParsedSpecDraftBlock[],
): ConversationDraftState {
  const baseDraft = prev?.draft ?? {}
  if (blocks.length === 0) {
    return prev ?? { draft: baseDraft, ready: false, chips: [], lastChangedFields: [] }
  }
  let nextDraft: Partial<SpecDraft> = baseDraft
  let ready = prev?.ready ?? false
  let chips = prev?.chips ?? []
  const changed = new Set<keyof SpecDraft>()
  for (const block of blocks) {
    const before = nextDraft
    nextDraft = mergeDraft(before, block.partial)
    for (const key of ['title', 'description', 'labels', 'priority', 'acceptanceCriteria', 'repositoryIds'] as const) {
      if (!shallowEqual(before[key], nextDraft[key])) changed.add(key)
    }
    ready = block.ready
    if (block.chips.length > 0) chips = block.chips.slice(0, 3)
  }
  return { draft: nextDraft, ready, chips, lastChangedFields: Array.from(changed) }
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }
  return false
}
