import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation, type Location } from 'react-router-dom'
import i18n, { loadLanguage } from '../../../lib/i18n'

const h = vi.hoisted(() => ({
  desktop: { projects: [{ id: 'p1', name: 'Alpha' }], activeProjectId: 'p1' as string | null, setActiveProjectId: vi.fn() },
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}))
vi.mock('sonner', () => ({ toast: h.toast }))
vi.mock('../../../hooks/useDesktop', () => ({ useDesktop: () => h.desktop }))
vi.mock('../../../context/UiModeContext', () => ({ useUiMode: () => ({ uiMode: 'agent' }) }))

import { SharedWebSocketContext } from '../../../hooks/useSharedWebSocket'
import { OPEN_MISSION_EVENT } from '../../../lib/mission-events'
import { InboxProvider } from '../context/InboxContext'
import { InboxDialog } from '../components/InboxDialog'
import { inboxItemText } from '../lib/inbox-item-text'
import { attentionCategoryOf, primaryLabelKey, readInboxSnapshot, type InboxItem } from '../lib/inbox-model'
import { inboxItemRunState } from '../lib/inbox-run-state'

const base = { projectId: 'p1', projectName: 'Alpha', detail: null, at: new Date(Date.now() - 60_000).toISOString(), version: 'v', diagnosis: null, cap: null }
const chainItem = (over: Partial<InboxItem> = {}): InboxItem => ({
  ...base, id: 'p1:chain:c1', kind: 'chain', title: 'Milestone 2', action: 'resume-chain', subjectId: 'c1', conversationId: null,
  chain: { milestoneN: 2, status: 'paused', pauseReason: 'integration_failed:conflict', autoAdvance: true, nextChunk: 1, totalChunks: 3, retryChunk: null }, ...over,
})
const missionItem = (over: Partial<InboxItem> = {}): InboxItem => ({
  ...base, id: 'p1:mission:m1:rail-launch:0', kind: 'mission', title: 'Ship the checkout', detail: '#12, #14', action: 'open-mission', subjectId: 'm1:rail-launch:0', conversationId: 'conv-1',
  card: { id: 'm1:rail-launch:0', kind: 'rail-launch', ticketIds: [12, 14] }, ...over,
})
const text = (item: InboxItem) => inboxItemText(item, i18n.t.bind(i18n), 'en')

describe('inbox model: chains and mission cards', () => {
  it('reads both kinds from the wire, dropping a chain without its chain or a card without its mission', () => {
    const snapshot = readInboxSnapshot({ items: [chainItem(), missionItem(), { ...chainItem({ id: 'x' }), chain: null }, { ...missionItem({ id: 'y' }), conversationId: null }, { ...missionItem({ id: 'z' }), card: { id: 'q', kind: 'options' } }] })
    expect(snapshot.items.map((item) => item.id)).toEqual(['p1:chain:c1', 'p1:mission:m1:rail-launch:0'])
    expect(snapshot.items[0].chain).toMatchObject({ milestoneN: 2, status: 'paused', totalChunks: 3 })
    expect(snapshot.items[1].card).toEqual({ id: 'm1:rail-launch:0', kind: 'rail-launch', ticketIds: [12, 14] })
  })

  it('words a paused chain by why it stopped and a checkpoint by where it stands', () => {
    expect(text(chainItem())).toEqual({ title: 'Milestone 2', kindLabel: 'Milestone paused', detail: 'Integrating the last rail needs you', rawDetail: null })
    const checkpoint = chainItem({ chain: { ...chainItem().chain!, status: 'awaiting_approval', pauseReason: null, nextChunk: 1 } })
    expect(text(checkpoint)).toMatchObject({ kindLabel: 'Milestone waiting for your go', detail: 'Rail 1 of 3 done' })
    expect(text(chainItem({ chain: { ...chainItem().chain!, pauseReason: 'something_new' } })).detail).toBe('Paused')
    expect(primaryLabelKey(chainItem())).toBe('actions.resumeChain')
    expect(primaryLabelKey(checkpoint)).toBe('actions.continueChain')
    expect(inboxItemRunState(chainItem())).toBe('paused')
    expect(inboxItemRunState(checkpoint)).toBe('review')
    expect(attentionCategoryOf(checkpoint)).toBe('review')
    expect(attentionCategoryOf(chainItem())).toBe('failed')
  })

  it('words mission cards by what they propose, in the person\'s language', async () => {
    expect(text(missionItem())).toEqual({ title: 'Ship the checkout', kindLabel: 'Launch proposal', detail: '#12, #14', rawDetail: null })
    expect(text(missionItem({ card: { id: 'm:pr-ci-offer:0', kind: 'pr-ci-offer', prNumber: 41 }, detail: 'PR #41' }))).toMatchObject({ kindLabel: 'Fix the failing CI?', detail: 'PR #41' })
    expect(primaryLabelKey(missionItem())).toBe('actions.openMission')
    expect(attentionCategoryOf(missionItem())).toBe('question')
    await loadLanguage('es')
    expect(inboxItemText(chainItem(), i18n.getFixedT('es'), 'es')).toMatchObject({ title: 'Hito 2', kindLabel: 'Hito en pausa' })
    expect(inboxItemText(missionItem(), i18n.getFixedT('es'), 'es').kindLabel).toBe('Propuesta de lanzamiento')
  })
})

describe('inbox panel: chains and mission cards', () => {
  let loc: Location
  let fetchMock: ReturnType<typeof vi.fn>
  function Probe() { loc = useLocation(); return null }
  const ws = { registerHandler: () => {}, unregisterHandler: () => {}, connectionStatus: 'connected' as const }
  const mount = () => render(
    <MemoryRouter initialEntries={['/?inbox=1']}>
      <SharedWebSocketContext.Provider value={ws as never}><InboxProvider><InboxDialog /><Probe /></InboxProvider></SharedWebSocketContext.Provider>
    </MemoryRouter>,
  )

  beforeEach(() => {
    localStorage.clear()
    h.toast.success.mockClear(); h.toast.error.mockClear()
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/inbox')) return { ok: true, status: 200, json: async () => ({ items: [chainItem(), missionItem()], projects: [], generatedAt: '' }) }
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    })
    global.fetch = fetchMock as never
  })

  it('Resume on a chain posts the chain row\'s own Resume to the item\'s project', async () => {
    mount()
    const row = (await screen.findAllByTestId('inbox-row')).find((r) => r.getAttribute('data-item-id') === 'p1:chain:c1')!
    expect(row).toHaveTextContent('Milestone 2')
    expect(row).toHaveTextContent('Integrating the last rail needs you')
    const primary = within(row).getByTestId('inbox-primary')
    expect(primary).toHaveTextContent('Resume')
    fireEvent.click(primary)
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Milestone resumed'))
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/blueprint/chains/c1/resume'))!
    expect(String(call[0])).toContain('/api/projects/p1/blueprint/chains/c1/resume')
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ from: 'recommended' })
  })

  it('a failed chain Resume says why', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/inbox')) return { ok: true, status: 200, json: async () => ({ items: [chainItem()], projects: [], generatedAt: '' }) }
      return { ok: false, status: 409, json: async () => ({ error: 'chain_not_paused' }) }
    })
    mount()
    fireEvent.click(within((await screen.findAllByTestId('inbox-row'))[0]).getByTestId('inbox-primary'))
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("Couldn't resume the milestone", expect.anything()))
  })

  it('Open mission asks the missions feature to open it and closes the inbox', async () => {
    const requests: string[] = []
    const listener = (event: Event) => { requests.push((event as CustomEvent<{ conversationId: string }>).detail.conversationId) }
    window.addEventListener(OPEN_MISSION_EVENT, listener)
    try {
      mount()
      const row = (await screen.findAllByTestId('inbox-row')).find((r) => r.getAttribute('data-item-id') === 'p1:mission:m1:rail-launch:0')!
      expect(row).toHaveTextContent('Launch proposal')
      const primary = within(row).getByTestId('inbox-primary')
      expect(primary).toHaveTextContent('Open mission')
      fireEvent.click(primary)
      await waitFor(() => expect(requests).toEqual(['conv-1']))
      await waitFor(() => expect(loc.search).not.toContain('inbox'))
    } finally {
      window.removeEventListener(OPEN_MISSION_EVENT, listener)
    }
  })
})
