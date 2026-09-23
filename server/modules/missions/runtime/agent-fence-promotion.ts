// ─── Protocol fence promotion (small-model tolerance) ─────────────────────────
// The operator protocol asks for fenced blocks tagged EXACTLY `options`,
// `problem-frame`, `spec-draft` and `rail-launch`. Small / local models routinely emit the
// right JSON under a generic ```json (or bare ```) fence instead, which the
// strict parsers ignore — so no chips, no framing card, and commit_draft then
// refuses because no frame was ever registered. This pass re-tags a CLOSED
// generic fence whose body unambiguously has one protocol shape. Anything
// ambiguous is left untouched; fences already carrying a protocol tag are
// never rewritten. Mirror: server/modules/missions/runtime/agent-fence-promotion.ts (keep in sync).

const GENERIC_FENCE_RE = /```(?:json|jsonc|JSON)?[^\S\n]*\n([\s\S]*?)\n[^\S\n]*```/g

type Shape = 'options' | 'problem-frame' | 'spec-draft' | 'rail-launch'

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** Detect which protocol block a parsed JSON body is, or null. */
export function detectProtocolShape(value: unknown): Shape | null {
  if (Array.isArray(value)) {
    if (value.length < 2 || value.length > 8) return null
    return value.every((s) => typeof s === 'string' && s.trim() && s.trim().length <= 80) ? 'options' : null
  }
  if (!isRecord(value)) return null
  if (isRecord(value.restated) && isRecord(value.alternative) && typeof value.discriminator === 'string') return 'problem-frame'
  if (typeof value.title === 'string' && typeof value.description === 'string'
    && ('acceptanceCriteria' in value || 'labels' in value || 'priority' in value)) return 'spec-draft'
  // mission-rail-cards: a launch proposal = a ticket list plus at least one
  // rail/launch key. Checked LAST so a spec-draft (title+description) never
  // masquerades as a launch.
  const tickets = value.ticketIds ?? value.specs ?? value.tickets
  if (Array.isArray(tickets) && tickets.length > 0
    && ('railIndex' in value || 'newRail' in value || 'mode' in value || 'loopId' in value || 'aiEngine' in value || 'railName' in value)) return 'rail-launch'
  return null
}

/** Re-tag generic fences that carry a protocol-shaped JSON body. */
export function promoteAgentProtocolFences(text: string): string {
  if (!text || !text.includes('```')) return text ?? ''
  GENERIC_FENCE_RE.lastIndex = 0
  return text.replace(GENERIC_FENCE_RE, (whole, body: string, offset: number) => {
    // A fence preceded by another backtick is a quoted/long fence — never touch.
    if (offset > 0 && text[offset - 1] === '`') return whole
    let parsed: unknown
    try { parsed = JSON.parse(body) } catch { return whole }
    const shape = detectProtocolShape(parsed)
    return shape ? '```' + shape + '\n' + body + '\n```' : whole
  })
}
