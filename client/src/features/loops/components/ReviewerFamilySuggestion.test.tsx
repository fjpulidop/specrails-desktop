import { beforeEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '../../../test-utils'
import { LoopAgentsEditor } from './LoopAgentsEditor'
import type { LoopAgentConfig } from '../lib/loops-api'

const desktop = vi.hoisted(() => ({ activeProjectId: 'first' as string | null, projects: [{ id: 'first', provider: 'claude' }] }))
vi.mock('../../../hooks/useDesktop', () => ({ useDesktop: () => desktop }))

const config = (reviewer = 'inherit'): LoopAgentConfig => ({ schemaVersion: 1, agents: { architect: { provider: 'inherit' }, developer: { provider: 'inherit' }, reviewer: { provider: reviewer, maxTurns: 40 } }, rolePrompts: { reviewer: 'Review the task' } })
const json = (data: unknown, ok = true) => ({ ok, json: async () => data }) as Response
let available: Record<string, boolean>
let stored: { reviewerFamilySuggestionDismissed?: boolean }

beforeEach(() => {
  desktop.activeProjectId = 'first'
  available = { claude: true, codex: true }
  stored = {}
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/available-providers')) return json(available)
    if (url.endsWith('/api/projects/first/settings')) {
      if (init?.method === 'PATCH') { Object.assign(stored, JSON.parse(String(init.body))); return json({ ok: true, settings: stored }) }
      return json(stored)
    }
    if (url === '/api/runtime-providers') return json({ providers: [{ id: 'claude', kind: 'cli', cli: 'claude' }, { id: 'codex', kind: 'cli', cli: 'codex' }] })
    return json({ agents: config(), rolePromptDefaults: null, guardrails: { supported: false, catalog: [] } })
  }))
})

function Draft({ onChange = () => {}, initial = config() }: { onChange?: (value: LoopAgentConfig) => void; initial?: LoopAgentConfig }) {
  const [value, setValue] = useState(initial)
  return <LoopAgentsEditor value={value} onChange={next => { onChange(next); setValue(next) }} />
}

it('suggests the other model family and applies it to the reviewer only', async () => {
  const changes = vi.fn()
  render(<Draft onChange={changes} />)
  const note = await screen.findByTestId('reviewer-family-suggestion')
  expect(note).toHaveTextContent('Run the reviewer on Codex')
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
  expect(changes).toHaveBeenCalledOnce()
  expect(changes.mock.calls[0][0].agents).toEqual({ architect: { provider: 'inherit' }, developer: { provider: 'inherit' }, reviewer: { provider: 'codex', maxTurns: 40 } })
  await waitFor(() => expect(screen.queryByTestId('reviewer-family-suggestion')).not.toBeInTheDocument())
  expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method)).toBe(false)
})

it('is hidden with a single usable provider and never changes the default on its own', async () => {
  available = { claude: true, codex: false }
  const changes = vi.fn()
  render(<Draft onChange={changes} />)
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/api/available-providers'))).toBe(true))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Import current project agents' })).toBeEnabled())
  expect(screen.queryByTestId('reviewer-family-suggestion')).not.toBeInTheDocument()
  expect(changes).not.toHaveBeenCalled()
})

it('is hidden when the reviewer already runs on another provider', async () => {
  render(<Draft initial={config('codex')} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Import current project agents' })).toBeEnabled())
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/settings'))).toBe(true))
  expect(screen.queryByTestId('reviewer-family-suggestion')).not.toBeInTheDocument()
})

it('persists a dismissal for the project and stays dismissed on the next visit', async () => {
  const changes = vi.fn()
  const view = render(<Draft onChange={changes} />)
  await screen.findByTestId('reviewer-family-suggestion')
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
  expect(screen.queryByTestId('reviewer-family-suggestion')).not.toBeInTheDocument()
  await waitFor(() => expect(stored.reviewerFamilySuggestionDismissed).toBe(true))
  expect(vi.mocked(fetch)).toHaveBeenCalledWith(expect.stringMatching(/\/api\/projects\/first\/settings$/), expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ reviewerFamilySuggestionDismissed: true }) }))
  expect(changes).not.toHaveBeenCalled()
  view.unmount()
  render(<Draft />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Import current project agents' })).toBeEnabled())
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url).endsWith('/settings') && !init?.method).length).toBe(2))
  expect(screen.queryByTestId('reviewer-family-suggestion')).not.toBeInTheDocument()
})
