// Spec search for the ⌘K `#` scope (CD6). Specs live in the project's ticket
// store (a JSON file Core also writes), not in SQLite, so an FTS table would be
// a second copy to keep in step with external writers. A project holds tens to
// a few hundred specs: a folded-substring scan over title, summary, description,
// labels, non-goals, addenda and comments is exact, always current, and cheap.
// Matching ignores case and diacritics; snippets share the mission highlight
// shape (text + ranges) so the client renders every scope the same way.
import { isFlowHeldTicket, type Ticket } from './ticket-store'
import type { SearchSnippet } from '../../../util/search-snippet'

export type SpecSearchField = 'id' | 'title' | 'summary' | 'description' | 'label' | 'nonGoal' | 'addendum' | 'comment'

export interface SpecSearchHit {
  id: number
  title: string
  status: string
  priority: string | null
  field: SpecSearchField
  snippet: SearchSnippet | null
}

export const SPEC_SEARCH_DEFAULT_LIMIT = 8
export const SPEC_SEARCH_MAX_LIMIT = 30
const CONTEXT = 60

/** Fold to lowercase without diacritics, keeping a map back to original offsets. */
function foldWithMap(text: string): { folded: string; map: number[] } {
  let folded = ''
  const map: number[] = []
  let offset = 0
  for (const ch of text) {
    const piece = ch.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    for (let i = 0; i < piece.length; i++) map.push(offset)
    folded += piece
    offset += ch.length
  }
  map.push(offset)
  return { folded, map }
}

function foldPlain(text: string): string {
  return foldWithMap(text).folded
}

/** Window of ~CONTEXT characters on each side of the first match, with its range. */
function snippetAround(text: string, needle: string): SearchSnippet | null {
  const { folded, map } = foldWithMap(text)
  const at = folded.indexOf(needle)
  if (at < 0) return null
  const matchStart = map[at]
  const matchEnd = map[Math.min(at + needle.length, folded.length)]
  const start = Math.max(0, matchStart - CONTEXT)
  const end = Math.min(text.length, matchEnd + CONTEXT)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  // Whitespace collapsing keeps ranges honest by working segment by segment.
  const before = text.slice(start, matchStart).replace(/\s+/g, ' ')
  const hit = text.slice(matchStart, matchEnd).replace(/\s+/g, ' ')
  const after = text.slice(matchEnd, end).replace(/\s+/g, ' ')
  const lead = prefix + before
  return { text: lead + hit + after + suffix, ranges: [[lead.length, lead.length + hit.length]] }
}

interface Candidate { field: SpecSearchField; text: string }

function candidates(ticket: Ticket): Candidate[] {
  const out: Candidate[] = [{ field: 'title', text: ticket.title ?? '' }]
  if (ticket.short_summary) out.push({ field: 'summary', text: ticket.short_summary })
  if (ticket.description) out.push({ field: 'description', text: ticket.description })
  for (const label of ticket.labels ?? []) out.push({ field: 'label', text: label })
  for (const goal of ticket.nonGoals ?? []) out.push({ field: 'nonGoal', text: goal })
  for (const addendum of ticket.addenda ?? []) {
    out.push({ field: 'addendum', text: addendum.title })
    out.push({ field: 'addendum', text: addendum.body })
  }
  for (const comment of ticket.comments ?? []) out.push({ field: 'comment', text: comment.body })
  return out
}

const FIELD_RANK: Record<SpecSearchField, number> = {
  id: 0, title: 1, summary: 2, label: 3, description: 4, nonGoal: 5, addendum: 6, comment: 7,
}

export function searchSpecs(tickets: readonly Ticket[], rawQuery: string, limit = SPEC_SEARCH_DEFAULT_LIMIT): SpecSearchHit[] {
  const query = rawQuery.trim().replace(/^#/, '').trim()
  if (!query) return []
  const cap = Math.max(1, Math.min(SPEC_SEARCH_MAX_LIMIT, Math.floor(limit)))
  const needle = foldPlain(query)
  const idQuery = /^\d+$/.test(query) ? Number(query) : null
  const scored: Array<{ hit: SpecSearchHit; rank: number; updated: string }> = []
  for (const ticket of tickets) {
    if (isFlowHeldTicket(ticket)) continue
    let best: { field: SpecSearchField; text: string } | null = null
    if (idQuery !== null && ticket.id === idQuery) {
      best = { field: 'id', text: ticket.title }
    } else {
      for (const c of candidates(ticket)) {
        if (!foldPlain(c.text).includes(needle)) continue
        if (!best || FIELD_RANK[c.field] < FIELD_RANK[best.field]) best = c
        if (best.field === 'title') break
      }
    }
    if (!best) continue
    const startsWithTitle = best.field === 'title' && foldPlain(ticket.title).startsWith(needle)
    scored.push({
      hit: {
        id: ticket.id,
        title: ticket.title,
        status: ticket.status,
        priority: ticket.priority,
        field: best.field,
        snippet: best.field === 'id' ? null : snippetAround(best.text, needle),
      },
      rank: FIELD_RANK[best.field] * 2 + (startsWithTitle ? 0 : 1),
      updated: ticket.updated_at ?? '',
    })
  }
  scored.sort((a, b) => a.rank - b.rank || b.updated.localeCompare(a.updated) || b.hit.id - a.hit.id)
  return scored.slice(0, cap).map((s) => s.hit)
}
