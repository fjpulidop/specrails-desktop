import { describe, it, expect } from 'vitest'
import { searchSpecs, SPEC_SEARCH_MAX_LIMIT } from './spec-search'
import type { Ticket } from './ticket-store'

function spec(id: number, over: Partial<Ticket> = {}): Ticket {
  return {
    id, title: `Spec ${id}`, description: '', status: 'todo', priority: null, labels: [], assignee: null, prerequisites: [], metadata: {},
    origin_conversation_id: null, is_epic: false, parent_epic_id: null, execution_order: null, short_summary: null,
    created_at: '2026-10-01T00:00:00Z', updated_at: `2026-10-0${Math.min(id, 9)}T00:00:00Z`, created_by: 't', source: 'manual', ...over,
  } as Ticket
}

describe('searchSpecs', () => {
  it('finds title, description, labels, addenda and comments, best field first', () => {
    const tickets = [
      spec(1, { title: 'Billing page', description: 'show invoices' }),
      spec(2, { title: 'Other', description: 'refactor the invoices table' }),
      spec(3, { title: 'Misc', labels: ['invoices'] }),
      spec(4, { title: 'Later', addenda: [{ id: 'a', kind: 'clarification', title: 'About invoices', body: 'x', status: 'open' } as any] }),
      spec(5, { title: 'Chatty', comments: [{ id: 1, body: 'what about invoices?', created_at: '', created_by: 'u' }] }),
      spec(6, { title: 'Unrelated' }),
    ]
    const hits = searchSpecs(tickets, 'invoices')
    expect(hits.map((h) => h.field)).toEqual(['label', 'description', 'description', 'addendum', 'comment'])
    expect(hits.some((h) => h.id === 6)).toBe(false)
  })

  it('ranks a title that starts with the query first and highlights the match', () => {
    const hits = searchSpecs([spec(1, { title: 'Add search box' }), spec(2, { title: 'Search everything' })], 'search')
    expect(hits[0].id).toBe(2)
    const s = hits[0].snippet!
    const [a, b] = s.ranges[0]
    expect(s.text.slice(a, b)).toBe('Search')
  })

  it('ignores case and diacritics but keeps ranges on the original text', () => {
    const [hit] = searchSpecs([spec(1, { title: 'Revisión de la API' })], 'revision de')
    expect(hit.snippet!.text.slice(...hit.snippet!.ranges[0])).toBe('Revisión de')
  })

  it('matches a bare number or #number as a spec id', () => {
    const tickets = [spec(12, { title: 'Twelve' }), spec(7, { title: 'Needs 12 retries' })]
    expect(searchSpecs(tickets, '#12').map((h) => [h.id, h.field])[0]).toEqual([12, 'id'])
  })

  it('windows long text with ellipses and caps results; skips live Flow placeholders', () => {
    const long = `${'a '.repeat(200)}needle${' b'.repeat(200)}`
    const [hit] = searchSpecs([spec(1, { description: long })], 'needle')
    expect(hit.snippet!.text.startsWith('…')).toBe(true)
    expect(hit.snippet!.text.endsWith('…')).toBe(true)
    expect(hit.snippet!.text.length).toBeLessThan(200)

    const many = Array.from({ length: 50 }, (_, i) => spec(i + 1, { title: `needle ${i}` }))
    expect(searchSpecs(many, 'needle')).toHaveLength(8)
    expect(searchSpecs(many, 'needle', 500)).toHaveLength(SPEC_SEARCH_MAX_LIMIT)

    const flow = spec(99, { title: 'needle flow', metadata: { flow: { state: 'active', conversationId: 'c', flowId: 'f', worktreeId: 'w', startedAt: '' } } })
    expect(searchSpecs([flow], 'needle')).toEqual([])
    expect(searchSpecs(many, '  ')).toEqual([])
  })
})
