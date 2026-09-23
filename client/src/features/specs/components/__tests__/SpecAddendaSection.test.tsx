import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '../../../../test-utils'
import { SpecAddendaSection } from '../SpecAddendaSection'
import type { LocalTicket } from '../../../../types'
import type { SpecAddendum } from '../../lib/spec-addenda-core'

vi.mock('../../../../lib/api', () => ({ getApiBase: () => '/api/projects/p1' }))

function addendum(over: Partial<SpecAddendum> = {}): SpecAddendum {
  return {
    id: 'a1', version: 1, kind: 'change-request', title: 'Idempotency keys', body: 'Send an **Idempotency-Key** header.',
    status: 'open', hash: 'f'.repeat(64), created_at: '2026-09-21T10:00:00.000Z', updated_at: '2026-09-21T10:00:00.000Z',
    created_by: 'user', origin_conversation_id: null, run_id: null, applied_at: null, ...over,
  }
}

function ticket(over: Partial<LocalTicket> = {}): LocalTicket {
  return {
    id: 7, title: 'Promote tab', description: 'never edited', status: 'on_review', priority: 'medium', labels: [],
    assignee: null, prerequisites: [], metadata: {}, origin_conversation_id: null, is_epic: false, parent_epic_id: null,
    execution_order: null, created_at: '2026-09-21T10:00:00.000Z', updated_at: '2026-09-21T10:00:00.000Z',
    created_by: 'user', source: 'manual', ...over,
  }
}

type Call = { url: string; init?: RequestInit }
let calls: Call[]
function mockFetch(respond: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    const r = respond(url, init)
    return { ok: r.status < 400, status: r.status, json: async () => r.body } as Response
  }))
}
const sent = (c: Call) => JSON.parse(String(c.init?.body ?? '{}')) as Record<string, unknown>

describe('SpecAddendaSection', () => {
  beforeEach(() => { calls = [] })
  afterEach(() => { vi.unstubAllGlobals() })

  it('renders the empty call-to-action and opens the form from it', () => {
    mockFetch(() => ({ status: 200, body: {} }))
    render(<SpecAddendaSection ticket={ticket()} />)
    expect(screen.getByTestId('spec-addenda-empty')).toHaveTextContent('Add an addendum to iterate on this spec')
    fireEvent.click(screen.getByTestId('spec-addenda-empty'))
    expect(screen.getByTestId('spec-addenda-form')).toBeInTheDocument()
    expect(screen.getByTestId('spec-addenda-save')).toBeDisabled()
  })

  it('lists addenda with kind + lifecycle pills, an open count, and expands the markdown body', () => {
    mockFetch(() => ({ status: 200, body: {} }))
    const t = ticket({ addenda: [
      addendum(),
      addendum({ id: 'a2', kind: 'review-feedback', title: 'Flying', status: 'in_flight', run_id: 'run-abcdef12' }),
      addendum({ id: 'a3', kind: 'constraint', title: 'Done', status: 'applied', run_id: 'run-x', applied_at: '2026-09-21T11:00:00.000Z' }),
      addendum({ id: 'a4', kind: 'clarification', title: 'Gone', status: 'dismissed' }),
    ] })
    render(<SpecAddendaSection ticket={t} />)
    expect(screen.getByTestId('spec-addenda-open-count')).toHaveTextContent('1 open')
    const statuses = screen.getAllByTestId('spec-addendum-status').map((el) => el.textContent)
    expect(statuses).toEqual(['Open', 'In flight', 'Applied', 'Dismissed'])
    expect(screen.getByText('Change request')).toBeInTheDocument()
    // Body collapsed: a clamped preview; expanded: markdown with <strong>.
    fireEvent.click(screen.getByText('Idempotency keys'))
    const body = screen.getByTestId('spec-addendum-body')
    expect(body.querySelector('strong')?.textContent).toBe('Idempotency-Key')
    expect(screen.getByText(/hash ffffffffffff/)).toBeInTheDocument()
    // An in-flight addendum exposes NO edit/dismiss/delete controls.
    const flying = screen.getByTestId('spec-addendum-a2')
    expect(flying.querySelector('button[aria-label="Edit"]')).toBeNull()
    expect(flying.querySelector('button[aria-label="Dismiss"]')).toBeNull()
    expect(flying.querySelector('button[aria-label="Delete"]')).toBeNull()
    expect(flying.querySelector('[data-testid="spec-addendum-release"]')).not.toBeNull()
    // An applied one can be reopened or dismissed but not edited.
    const done = screen.getByTestId('spec-addendum-a3')
    expect(done.querySelector('button[aria-label="Reopen"]')).not.toBeNull()
    expect(done.querySelector('button[aria-label="Edit"]')).toBeNull()
  })

  it('POSTs a new addendum and replaces the list from the server response', async () => {
    const created = addendum({ id: 'new', title: 'Retry on 502' })
    mockFetch((url, init) => (init?.method === 'POST' ? { status: 201, body: { addendum: created, ticket: ticket({ addenda: [created] }) } } : { status: 200, body: {} }))
    const onChanged = vi.fn()
    render(<SpecAddendaSection ticket={ticket()} onChanged={onChanged} />)
    fireEvent.click(screen.getByTestId('spec-addenda-add'))
    fireEvent.change(screen.getByTestId('spec-addenda-kind'), { target: { value: 'review-feedback' } })
    fireEvent.change(screen.getByTestId('spec-addenda-title'), { target: { value: 'Retry on 502' } })
    fireEvent.change(screen.getByTestId('spec-addenda-body'), { target: { value: 'Classify ambiguous transport failures as unknown.' } })
    await act(async () => { fireEvent.click(screen.getByTestId('spec-addenda-save')) })
    await waitFor(() => expect(screen.getByTestId('spec-addendum-new')).toBeInTheDocument())
    const post = calls.find((c) => c.init?.method === 'POST')!
    expect(post.url).toBe('/api/projects/p1/tickets/7/addenda')
    expect(sent(post)).toEqual({ kind: 'review-feedback', title: 'Retry on 502', body: 'Classify ambiguous transport failures as unknown.' })
    expect(onChanged).toHaveBeenCalledWith([created])
    expect(screen.queryByTestId('spec-addenda-form')).toBeNull()
  })

  it('dismisses via PATCH status, deletes with a two-step confirm, and surfaces an in-flight conflict', async () => {
    const a = addendum()
    mockFetch((url, init) => {
      if (init?.method === 'PATCH') return { status: 200, body: { addendum: { ...a, status: 'dismissed' }, ticket: ticket({ addenda: [{ ...a, status: 'dismissed' }] }) } }
      if (init?.method === 'DELETE') return { status: 409, body: { error: 'addendum_in_flight' } }
      return { status: 200, body: {} }
    })
    render(<SpecAddendaSection ticket={ticket({ addenda: [a] })} />)
    await act(async () => { fireEvent.click(screen.getByLabelText('Dismiss')) })
    await waitFor(() => expect(screen.getByTestId('spec-addendum-status')).toHaveTextContent('Dismissed'))
    const patch = calls.find((c) => c.init?.method === 'PATCH')!
    expect(patch.url).toBe('/api/projects/p1/tickets/7/addenda/a1')
    expect(sent(patch)).toEqual({ status: 'dismissed' })

    // First click arms the confirm, second click sends DELETE.
    fireEvent.click(screen.getByLabelText('Delete'))
    expect(calls.some((c) => c.init?.method === 'DELETE')).toBe(false)
    await act(async () => { fireEvent.click(screen.getByLabelText('Confirm delete')) })
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'DELETE')).toBe(true))
    // The 409 keeps the row (the server is the authority).
    expect(screen.getByTestId('spec-addendum-a1')).toBeInTheDocument()
  })

  it('Release on an in-flight addendum PATCHes { status: open, force: true }', async () => {
    const a = addendum({ status: 'in_flight', run_id: 'gone' })
    mockFetch(() => ({ status: 200, body: { addendum: { ...a, status: 'open', run_id: null }, ticket: ticket({ addenda: [{ ...a, status: 'open', run_id: null }] }) } }))
    render(<SpecAddendaSection ticket={ticket({ addenda: [a] })} />)
    await act(async () => { fireEvent.click(screen.getByTestId('spec-addendum-release')) })
    await waitFor(() => expect(screen.getByTestId('spec-addendum-status')).toHaveTextContent('Open'))
    expect(sent(calls.find((c) => c.init?.method === 'PATCH')!)).toEqual({ status: 'open', force: true })
  })

  it('re-syncs from the ticket prop when a broadcast updates it', () => {
    mockFetch(() => ({ status: 200, body: {} }))
    const { rerender } = render(<SpecAddendaSection ticket={ticket({ addenda: [addendum()] })} />)
    expect(screen.getByTestId('spec-addendum-status')).toHaveTextContent('Open')
    rerender(<SpecAddendaSection ticket={ticket({ updated_at: '2026-09-21T12:00:00.000Z', addenda: [addendum({ status: 'in_flight', run_id: 'r1' })] })} />)
    expect(screen.getByTestId('spec-addendum-status')).toHaveTextContent('In flight')
  })
})
