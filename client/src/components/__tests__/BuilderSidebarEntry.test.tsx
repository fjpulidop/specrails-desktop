import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '../../test-utils'
import userEvent from '@testing-library/user-event'
import { BuilderSidebarEntry } from '../project-builder/BuilderSidebarEntry'
import type { Blueprint } from '../../lib/blueprint-draft'
import type { MilestoneProgress } from '../../lib/milestone-progress'

vi.mock('../project-builder/MilestoneGenerateShell', async () => {
  const ReactModule = await import('react')
  return {
    MilestoneGenerateShell: (props: { onCommitted?: () => void; onClose: () => void }) => ReactModule.createElement(
      'button',
      { type: 'button', 'data-testid': 'mock-milestone-committed', onClick: () => { props.onCommitted?.(); props.onClose() } },
      'finish milestone',
    ),
  }
})

const { toastMocks } = vi.hoisted(() => ({ toastMocks: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }))
vi.mock('sonner', () => ({ toast: toastMocks }))

let mockActiveProjectId: string | null = 'proj-1'
vi.mock('../../hooks/useDesktop', () => ({
  useDesktop: () => ({ activeProjectId: mockActiveProjectId, projects: [], setActiveProjectId: vi.fn() }),
}))
const mockNavigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return { ...(actual as object), useNavigate: () => mockNavigate }
})

const launchMilestone = vi.fn()
const resumeChain = vi.fn()
const cancelChain = vi.fn()
const setChainAutoAdvance = vi.fn()
vi.mock('../../lib/milestone-launch', async () => {
  const actual = await vi.importActual<typeof import('../../lib/milestone-launch')>('../../lib/milestone-launch')
  return {
    ...actual,
    launchMilestone: (...a: unknown[]) => launchMilestone(...a),
    resumeChain: (...a: unknown[]) => resumeChain(...a),
    cancelChain: (...a: unknown[]) => cancelChain(...a),
    setChainAutoAdvance: (...a: unknown[]) => setChainAutoAdvance(...a),
  }
})

// The live model is the hook's contract — the component never fetches the board.
const progressState: { blueprint: Blueprint | null; progress: MilestoneProgress[]; hasBlueprint: boolean | null } = { blueprint: null, progress: [], hasBlueprint: null }
const refresh = vi.fn(async () => {})
vi.mock('../../hooks/useMilestoneProgress', () => ({
  useMilestoneProgress: () => ({ ...progressState, loading: false, refresh }),
  useStackedHeadDeliveryIds: () => new Set<string>(),
}))

function blueprint(): Blueprint {
  return {
    blueprintVersion: 1, product: { name: 'Recipely', pitch: 'p', audience: 'a' }, coreFlow: 'flow', platform: 'web',
    stack: { language: 'ts', framework: 'next', db: 'sqlite' }, assumptions: [],
    milestones: [
      { id: 'm1', title: 'Skeleton', goal: 'e2e', status: 'committed', plannedSpecs: [] },
      { id: 'm2', title: 'Accounts', goal: 'auth', status: 'planned', plannedSpecs: ['login'] },
    ],
    specsComplete: false, m1Specs: [],
  }
}
function m1(over: Partial<MilestoneProgress> = {}): MilestoneProgress {
  return { id: 'm1', n: 1, title: 'Skeleton', storedStatus: 'committed', state: 'committed', counts: { total: 2, done: 1, onReview: 0, inProgress: 0, todo: 1, failed: 0 }, rails: [], chain: null, ...over }
}
const m2: MilestoneProgress = { id: 'm2', n: 2, title: 'Accounts', storedStatus: 'planned', state: 'planned', counts: { total: 0, done: 0, onReview: 0, inProgress: 0, todo: 0, failed: 0 }, rails: [], chain: null }

async function openPanel() {
  const user = userEvent.setup()
  render(<BuilderSidebarEntry expanded />)
  await waitFor(() => expect(screen.getByTestId('builder-sidebar-entry')).toBeInTheDocument())
  await user.click(screen.getByTestId('builder-sidebar-toggle'))
  await waitFor(() => expect(screen.getByTestId('builder-sidebar-panel')).toBeInTheDocument())
  return user
}

beforeEach(() => {
  vi.clearAllMocks()
  mockActiveProjectId = 'proj-1'
  localStorage.clear()
  progressState.blueprint = blueprint()
  progressState.progress = [m1(), m2]
  progressState.hasBlueprint = true
})

describe('BuilderSidebarEntry', () => {
  it('renders nothing when the project has no blueprint', () => {
    progressState.blueprint = null
    progressState.hasBlueprint = false
    render(<BuilderSidebarEntry expanded />)
    expect(screen.queryByTestId('builder-sidebar-entry')).not.toBeInTheDocument()
  })

  it('opens a portalled 320px flyout with one live card per milestone, honest counts, Launch + Generate', async () => {
    await openPanel()
    const panel = screen.getByTestId('builder-sidebar-panel')
    expect(panel.className).toContain('fixed')
    expect(panel.className).toContain('w-80')
    expect(panel.parentElement).toBe(document.body)
    expect(screen.getAllByTestId('milestone-card')).toHaveLength(2)
    expect(screen.getByText('Skeleton')).toBeInTheDocument()
    expect(screen.getByTestId('milestone-counts')).toHaveTextContent('1 of 2 delivered · 1 done')
    expect(screen.getByTestId('sidebar-launch-m1')).toBeInTheDocument()
    expect(screen.getByTestId('milestone-launch-mode')).toBeInTheDocument()
    expect(screen.getByTestId('sidebar-generate-next')).toHaveTextContent('Generate M2')
  })

  it('a delivered milestone reads as delivered / awaiting review, with a Review action into the packet', async () => {
    progressState.progress = [m1({
      state: 'delivered',
      counts: { total: 8, done: 0, onReview: 8, inProgress: 0, todo: 0, failed: 0 },
      rails: [{ railIndex: 3, name: 'M1 · 1', ticketIds: [1, 2, 3], active: false, runId: null, startedAt: null, chunkIndex: 1,
        delivery: { id: 'd-3', railIndex: 3, ticketIds: [1, 2, 3], decision: 'on_review', branch: 'b', baseBranch: 'main', prUrl: null, prNumber: null, prState: 'none', createdAt: null } }],
    }), m2]
    const user = await openPanel()
    expect(screen.queryByTestId('sidebar-launch-m1')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('milestone-state-pill')[0]).toHaveTextContent('Delivered — awaiting review')
    expect(screen.getByTestId('milestone-counts')).toHaveTextContent('8 of 8 delivered · 0 done')
    await user.click(screen.getByTestId('milestone-rail-review'))
    expect(mockNavigate).toHaveBeenCalledWith('/review/d-3')
  })

  it('Launch M1 posts the stored mode and toasts the chain framing', async () => {
    launchMilestone.mockResolvedValue({ ok: true, chainId: 'c1', launched: [{ chunk: 1, railIndex: 3, ticketIds: [1, 2, 3], runIds: ['r'], deliveryId: 'd' }], pending: [[4, 5, 6], [7, 8]], ticketCount: 3, skippedCount: 5 })
    const user = await openPanel()
    // Default: checkpoints (auto-continue OFF) — the toast says so.
    expect(screen.getByTestId('sidebar-auto-advance')).toHaveAttribute('aria-checked', 'false')
    await user.click(screen.getByTestId('sidebar-launch-m1'))
    expect(launchMilestone).toHaveBeenCalledWith('proj-1', 1, 'sequential', { autoAdvance: false })
    expect(toastMocks.success).toHaveBeenCalledWith('M1 launched — 3 specs on rail 1 of 3; you\'ll be asked before each next rail')
  })

  it('the auto-continue switch persists the preference and changes the launch body + framing', async () => {
    launchMilestone.mockResolvedValue({ ok: true, chainId: 'c1', launched: [{ chunk: 1, railIndex: 3, ticketIds: [1, 2, 3], runIds: ['r'], deliveryId: 'd' }], pending: [[4, 5, 6], [7, 8]], ticketCount: 3, skippedCount: 5 })
    const user = await openPanel()
    await user.click(screen.getByTestId('sidebar-auto-advance'))
    expect(screen.getByTestId('sidebar-auto-advance')).toHaveAttribute('aria-checked', 'true')
    expect(localStorage.getItem('specrails-desktop:milestone-auto-advance')).toBe('true')
    await user.click(screen.getByTestId('sidebar-launch-m1'))
    expect(launchMilestone).toHaveBeenCalledWith('proj-1', 1, 'sequential', { autoAdvance: true })
    expect(toastMocks.success).toHaveBeenCalledWith('M1 launched — 3 specs on rail 1 of 3; the next rails follow automatically')
    // Parallel launches have no checkpoints — the switch is hidden.
    await user.click(screen.getByTestId('builder-sidebar-toggle'))
    await user.click(await screen.findByRole('radio', { name: 'Parallel' }))
    expect(screen.queryByTestId('sidebar-auto-advance')).not.toBeInTheDocument()
  })

  it('a chain at a wave checkpoint offers Launch next rail and the chain-level auto-continue switch; Launch M1 is hidden', async () => {
    resumeChain.mockResolvedValue({ ok: true, chain: null })
    setChainAutoAdvance.mockResolvedValue({ ok: true, chain: null })
    progressState.progress = [m1({
      state: 'delivered',
      counts: { total: 8, done: 0, onReview: 3, inProgress: 0, todo: 5, failed: 0 },
      chain: { id: 'c1', milestoneN: 1, mode: 'sequential', status: 'awaiting_approval', pauseReason: null, autoAdvance: false, nextChunk: 1, totalChunks: 3, currentRailIndex: null, headBranch: 'feat/1', launched: [], updatedAt: 'x' },
    }), m2]
    const user = await openPanel()
    expect(screen.queryByTestId('sidebar-launch-m1')).not.toBeInTheDocument()
    expect(screen.getByTestId('milestone-chain-checkpoint')).toHaveTextContent('Rail 1 of 3 delivered — launch rail 2?')
    await user.click(screen.getByTestId('milestone-chain-launch-next'))
    expect(resumeChain).toHaveBeenCalledWith('proj-1', 'c1')
    await user.click(screen.getByTestId('milestone-chain-auto-advance'))
    expect(setChainAutoAdvance).toHaveBeenCalledWith('proj-1', 'c1', true)
    expect(toastMocks.success).toHaveBeenCalledWith('Auto-continue on — the next rails launch on their own')
    // The chain flag doubles as the preference for the next launch.
    expect(localStorage.getItem('specrails-desktop:milestone-auto-advance')).toBe('true')
    setChainAutoAdvance.mockResolvedValueOnce({ ok: false, error: 'chain_terminal', detail: 'chain is cancelled' })
    await user.click(screen.getByTestId('milestone-chain-auto-advance'))
    expect(toastMocks.error).toHaveBeenCalledWith('Could not update the chain', { description: 'chain is cancelled' })
  })

  it('parallel mode is remembered and framed as all rails at once; a guard refusal surfaces', async () => {
    launchMilestone.mockResolvedValueOnce({ ok: true, chainId: null, launched: [{ chunk: 1, railIndex: 3, ticketIds: [1], runIds: [], deliveryId: null }], pending: [], ticketCount: 1, skippedCount: 0 })
    const user = await openPanel()
    await user.click(screen.getByRole('radio', { name: 'Parallel' }))
    await user.click(screen.getByTestId('sidebar-launch-m1'))
    expect(launchMilestone).toHaveBeenCalledWith('proj-1', 1, 'parallel', { autoAdvance: false })
    expect(toastMocks.success).toHaveBeenCalledWith('M1 launched — 1 specs across 1 rails')
    expect(localStorage.getItem('specrails-desktop:milestone-launch-mode')).toBe('parallel')
    launchMilestone.mockResolvedValueOnce({ ok: false, reason: 'launch_rejected', error: 'tickets_in_flight', detail: 'busy' })
    await user.click(screen.getByTestId('builder-sidebar-toggle'))
    await user.click(await screen.findByTestId('sidebar-launch-m1'))
    expect(toastMocks.error).toHaveBeenCalledWith('Could not launch Milestone 1', { description: 'busy' })
    launchMilestone.mockResolvedValueOnce({ ok: false, reason: 'chain_active', error: 'chain_active', chainId: 'c' })
    await user.click(screen.getByTestId('sidebar-launch-m1'))
    expect(toastMocks.info).toHaveBeenCalled()
  })

  it('a paused chain offers Resume / Cancel through the chain routes and hides Launch', async () => {
    resumeChain.mockResolvedValue({ ok: true, chain: null })
    cancelChain.mockResolvedValue({ ok: true, chain: null })
    progressState.progress = [m1({
      state: 'committed',
      counts: { total: 8, done: 0, onReview: 3, inProgress: 0, todo: 5, failed: 3 },
      chain: { id: 'c1', milestoneN: 1, mode: 'sequential', status: 'paused', pauseReason: 'chunk_stalled', autoAdvance: true, nextChunk: 1, totalChunks: 3, currentRailIndex: 3, headBranch: 'feat/1', launched: [], updatedAt: 'x' },
    }), m2]
    const user = await openPanel()
    expect(screen.queryByTestId('sidebar-launch-m1')).not.toBeInTheDocument()
    expect(screen.getByTestId('milestone-chain-row')).toHaveTextContent('the last rail stalled')
    await user.click(screen.getByTestId('milestone-chain-resume'))
    expect(resumeChain).toHaveBeenCalledWith('proj-1', 'c1')
    expect(toastMocks.success).toHaveBeenCalledWith('Chain resumed')
    await user.click(screen.getByTestId('milestone-chain-cancel'))
    expect(cancelChain).toHaveBeenCalledWith('proj-1', 'c1')
  })

  it('committing M2 refreshes the live model', async () => {
    const user = await openPanel()
    await user.click(screen.getByTestId('sidebar-generate-next'))
    await user.click(screen.getByTestId('mock-milestone-committed'))
    expect(refresh).toHaveBeenCalled()
  })
})
