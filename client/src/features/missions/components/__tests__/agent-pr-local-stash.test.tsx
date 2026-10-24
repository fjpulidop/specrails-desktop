// proactive-local-integration: the mission card's saved-local-changes note,
// Restore my changes / copy stash name actions and the integrate toasts.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

// ── Mocks (mirror the agent-chat harness) ─────────────────────────────────────
vi.mock('../../../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: () => {},
    unregisterHandler: () => {},
    connectionStatus: 'connected',
  }),
}))

const projects = [
  { id: 'p1', name: 'acme-api', slug: 'acme-api', path: '/acme', provider: 'claude' },
  { id: 'p2', name: 'deckdex', slug: 'deckdex', path: '/deck', provider: 'claude' },
]
const mockSetActiveProjectId = vi.fn()
vi.mock('../../../../hooks/useDesktop', () => ({
  useDesktop: () => ({ projects, activeProjectId: 'p1', setActiveProjectId: mockSetActiveProjectId }),
}))
const mockForceProjectRoute = vi.fn()
vi.mock('../../../../lib/route-memory', () => ({ forceProjectRoute: (...args: unknown[]) => mockForceProjectRoute(...args) }))

// The card is Router-OPTIONAL: bare renders below must keep working, so only the
// two review-entry tests wrap in a MemoryRouter. useNavigate is mocked so the
// route target can be asserted.
const mockNavigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return { ...(actual as object), useNavigate: () => mockNavigate }
})

const mockOpenWebView = vi.fn()
vi.mock('../../../browser/context/WebViewModalContext', () => ({
  useWebViewModal: () => ({ openWebView: mockOpenWebView, canOpenWebView: false }),
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() }),
  Toaster: () => null,
}))

const tauriMocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  revealItemInDir: vi.fn(async () => {}),
}))
vi.mock('../../../../lib/tauri-shell', () => tauriMocks)

const api = {
  conv: { id: 'c1', title: null, provider: 'claude', model: null, session_id: null, pinned_project_id: null, tier_level: 0 as const, reasoning_effort: null, created_at: '', updated_at: '' },
}
vi.mock('../../lib/agent-api', async (orig) => {
  const actual = await orig<typeof import('../../lib/agent-api')>()
  return {
    ...actual, // coerce/parsePrDecisionEnvelope + postRailPrDecision stay REAL
    listAgentConversations: vi.fn(async () => []),
    createAgentConversation: vi.fn(async () => api.conv),
    getAgentConversation: vi.fn(async () => ({ conversation: api.conv, messages: [] })),
    patchAgentConversation: vi.fn(async () => api.conv),
    deleteAgentConversation: vi.fn(async () => {}),
    sendAgentMessage: vi.fn(async () => ({ queued: false })),
    abortAgentTurn: vi.fn(async () => {}),
    getMcpStatus: vi.fn(async () => ({ enabled: true, running: true })),
    enableMcp: vi.fn(async () => {}),
    getAvailableProviders: vi.fn(async () => ({ any: true, installed: ['claude'] })),
    getAgentModels: vi.fn(async () => ({
      models: [{ value: 'sonnet', label: 'Sonnet 5.5', default: true }],
      supportsImageInput: true,
      efforts: ['low', 'medium', 'high'],
    })),
  }
})

import { toast } from 'sonner'
import * as agentApi from '../../lib/agent-api'
import type { AgentPrDecisionEnvelope } from '../../lib/agent-api'
import { AgentPrDecisionCard } from '../AgentPrDecisionCard'

const SHA = 'c'.repeat(40)
const stash = (over: Partial<NonNullable<AgentPrDecisionEnvelope['localStash']>> = {}): NonNullable<AgentPrDecisionEnvelope['localStash']> => ({
  sha: SHA, name: 'specrails: before integrating #4, #7 (d1)', branch: 'main', state: 'needs_attention',
  restoreBranch: 'specrails/restore-local-cccccccc', conflictPaths: ['src/app.ts'], savedAt: '', updatedAt: '', ...over,
})
const env = (over: Partial<AgentPrDecisionEnvelope> = {}): AgentPrDecisionEnvelope => ({
  kind: 'pr_decision', prDeliveryId: 'd1', railIndex: 0, projectId: 'p1', baseBranch: 'main', ticketIds: [4, 7],
  decision: 'merged', prUrl: null, prNumber: null, prState: 'none', branch: null, runIds: [],
  statusCode: 'local_changes_attention', ...over,
})
const httpRes = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) })
const snapshot = (localStash: unknown, statusCode = 'merged') => ({
  prDeliveryId: 'd1', railIndex: 0, railKey: 'k', ticketIds: [4, 7], baseBranch: 'main', branch: null, prUrl: null, prNumber: null,
  prState: 'none', decision: 'merged', runIds: [], originConversationId: 'c1', statusCode, localStash, updatedAt: '2026-10-24T10:00:00.000Z',
})

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => {}) } })
  vi.mocked(agentApi.listAgentConversations).mockResolvedValue([])
})

describe('AgentPrDecisionCard — saved local changes', () => {
  it('explains a conflicting restore: stash note, conflicting files, restore branch and copyable name', async () => {
    render(<AgentPrDecisionCard envelope={env({ localStash: stash() })} />)
    const notice = screen.getByTestId('local-stash-notice')
    expect(notice).toHaveAttribute('data-state', 'needs_attention')
    expect(notice).toHaveTextContent('Your local changes are saved as a stash')
    expect(notice).toHaveTextContent('specrails/restore-local-cccccccc')
    expect(screen.getByTestId('local-stash-files')).toHaveTextContent('src/app.ts')
    expect(screen.getByTestId('local-stash-name')).toHaveTextContent('specrails: before integrating #4, #7 (d1)')
    await act(async () => { fireEvent.click(screen.getByTestId('local-stash-copy')) })
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('specrails: before integrating #4, #7 (d1)')
    expect(screen.getByTestId('local-stash-copy')).toHaveTextContent('Stash name copied')
  })

  it('renders nothing once the changes were restored or released', () => {
    const { rerender } = render(<AgentPrDecisionCard envelope={env({ localStash: stash({ state: 'restored' }), statusCode: 'merged' })} />)
    expect(screen.queryByTestId('local-stash-notice')).toBeNull()
    rerender(<AgentPrDecisionCard envelope={env({ localStash: stash({ state: 'released' }), statusCode: 'merged' })} />)
    expect(screen.queryByTestId('local-stash-notice')).toBeNull()
  })

  it('shows the not-yet-restored copy for a saved stash', () => {
    render(<AgentPrDecisionCard envelope={env({ localStash: stash({ state: 'saved', restoreBranch: null, conflictPaths: [] }) })} />)
    expect(screen.getByTestId('local-stash-notice')).toHaveTextContent('They have not been restored yet')
    expect(screen.queryByTestId('local-stash-files')).toBeNull()
  })

  it('Restore my changes posts to the card project and converges on the restored snapshot', async () => {
    global.fetch = vi.fn(async () => httpRes(200, { ok: true, localChanges: { state: 'restored', stashName: 'n', stashSha: SHA }, snapshot: snapshot({ ...stash(), state: 'restored' }) })) as unknown as typeof fetch
    render(<AgentPrDecisionCard envelope={env({ localStash: stash() })} />)
    await act(async () => { fireEvent.click(screen.getByTestId('local-stash-restore')) })
    expect(global.fetch).toHaveBeenCalledWith('/api/projects/p1/rails/pr-local-changes/restore', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ prDeliveryId: 'd1' }),
    }))
    await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Your local changes are back on main.'))
    await waitFor(() => expect(screen.queryByTestId('local-stash-notice')).toBeNull())
  })

  it('keeps the note and says so when the restore still conflicts or is blocked', async () => {
    global.fetch = vi.fn(async () => httpRes(200, { ok: true, localChanges: { state: 'needs_attention' }, snapshot: snapshot(stash(), 'local_changes_attention') })) as unknown as typeof fetch
    render(<AgentPrDecisionCard envelope={env({ localStash: stash() })} />)
    await act(async () => { fireEvent.click(screen.getByTestId('local-stash-restore')) })
    await waitFor(() => expect(vi.mocked(toast.warning)).toHaveBeenCalledWith('Your local changes still conflict with main; they stay safe in the stash.'))
    expect(screen.getByTestId('local-stash-notice')).toBeInTheDocument()
    global.fetch = vi.fn(async () => httpRes(409, { error: 'local_restore_blocked', reason: 'wrong_branch', current: 'feature', base: 'main' })) as unknown as typeof fetch
    await act(async () => { fireEvent.click(screen.getByTestId('local-stash-restore')) })
    await waitFor(() => expect(vi.mocked(toast.warning)).toHaveBeenCalledWith('Check out main first (you are on feature), then restore.'))
  })
})

describe('AgentPrDecisionCard — integrate toasts with local changes', () => {
  const integrate = async (localChanges: unknown) => {
    global.fetch = vi.fn(async () => httpRes(200, { ok: true, decision: 'merged', merged: true, local: true, localChanges })) as unknown as typeof fetch
    render(<AgentPrDecisionCard envelope={env({ decision: 'on_review', statusCode: 'ready_for_review' })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Integrate locally' }))
    await act(async () => { fireEvent.click(screen.getByTestId('agent-pr-merge-local-confirm-btn')) })
  }

  it('success → saved, integrated and restored', async () => {
    await integrate({ state: 'restored', stashName: 'n', stashSha: SHA })
    await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Saved your local changes, integrated #4, #7, and restored them.'))
  })

  it('conflict → integrated, changes safe in a stash, agent resolving', async () => {
    await integrate({ state: 'needs_attention', stashName: 'specrails: before integrating #4, #7 (d1)', stashSha: SHA })
    await waitFor(() => expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
      'Integrated #4, #7. Your local changes are safe in a stash; the agent is resolving the conflicts.',
      { description: 'specrails: before integrating #4, #7 (d1)' },
    ))
  })

  it('no local changes → the usual integrated toast', async () => {
    await integrate(undefined)
    await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Integrated into main locally'))
  })
})
