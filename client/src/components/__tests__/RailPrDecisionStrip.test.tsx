import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '../../test-utils'
import { DndContext } from '@dnd-kit/core'

const { mockToast } = vi.hoisted(() => ({
  mockToast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
vi.mock('sonner', () => ({ toast: mockToast }))

import { RailRow } from '../RailRow'
import { RailPrDecisionStrip } from '../RailPrDecisionStrip'
import type { LocalTicket, RailPrDecision, RailPrStateSnapshot } from '../../types'
import type { RailPrActResult } from '../../context/RailPrDecisionContext'

function snapshot(overrides: Partial<RailPrStateSnapshot> = {}): RailPrStateSnapshot {
  return {
    prDeliveryId: 'del-1',
    railIndex: 0,
    railKey: '0-impl',
    ticketIds: [1, 2],
    baseBranch: 'main',
    branch: null,
    prUrl: null,
    prNumber: null,
    prState: 'none',
    decision: 'on_review',
    originConversationId: null,
    ...overrides,
  }
}

const okResult: RailPrActResult = { ok: true, status: 200 }

const railProps = {
  id: 'rail-1',
  label: 'Rail 1',
  tickets: [] as LocalTicket[],
  mode: 'implement' as const,
  status: 'idle' as const,
  jiggleMode: false,
  onModeChange: vi.fn(),
  onToggle: vi.fn(),
  onTicketClick: vi.fn(),
  onDelete: vi.fn(),
  onLongPress: vi.fn(),
  onRename: vi.fn(),
}

function renderRail(prDecision: RailPrStateSnapshot | null, density: 'normal' | 'compact', act = vi.fn().mockResolvedValue(okResult)) {
  const view = render(
    <DndContext>
      <RailRow {...railProps} density={density} prDecision={prDecision} onPrDecision={act} />
    </DndContext>
  )
  return { view, act }
}

function renderStrip(decision: RailPrStateSnapshot, act = vi.fn().mockResolvedValue(okResult)) {
  const view = render(<RailPrDecisionStrip decision={decision} density="normal" act={act} />)
  return { view, act }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('RailPrDecisionStrip states (via RailRow, both densities)', () => {
  for (const density of ['normal', 'compact'] as const) {
    describe(`${density} density`, () => {
      it('renders nothing while building', () => {
        const { view } = renderRail(snapshot({ decision: 'building' }), density)
        expect(view.container.querySelector('[data-testid="rail-pr-strip"]')).toBeNull()
      })

      it('on_review → Ready-for-review pill + Create PR (tooltip → base) + Discard', () => {
        renderRail(snapshot(), density)
        const strip = screen.getByTestId('rail-pr-strip')
        expect(strip).toHaveAttribute('data-decision', 'on_review')
        expect(within(strip).getByText('Ready for review')).toBeInTheDocument()
        const create = within(strip).getByTestId('rail-pr-create')
        expect(create).toHaveTextContent('Create PR')
        expect(create).toHaveAttribute('title', '→ main')
        expect(within(strip).getByTestId('rail-pr-discard')).toHaveTextContent('Discard')
        expect(within(strip).queryByTestId('rail-pr-publish')).toBeNull()
        expect(within(strip).queryByTestId('rail-pr-link')).toBeNull()
      })

      it('pr_draft with prUrl → Draft-PR pill + #N link chip + Publish + Discard', () => {
        renderRail(snapshot({ decision: 'pr_draft', prUrl: 'https://github.com/o/r/pull/12', prNumber: 12, prState: 'pr-created' }), density)
        const strip = screen.getByTestId('rail-pr-strip')
        expect(within(strip).getByText('Draft PR')).toBeInTheDocument()
        const link = within(strip).getByTestId('rail-pr-link')
        expect(link).toHaveTextContent('#12')
        expect(link).toHaveAttribute('href', 'https://github.com/o/r/pull/12')
        expect(within(strip).getByTestId('rail-pr-publish')).toHaveTextContent('Publish')
        expect(within(strip).getByTestId('rail-pr-discard')).toBeInTheDocument()
      })

      it('pr_draft degraded (no prUrl) → Branch-pushed pill + Retry PR + Discard, no Publish', () => {
        renderRail(snapshot({ decision: 'pr_draft', prState: 'pushed', branch: 'sr/p/batch-0' }), density)
        const strip = screen.getByTestId('rail-pr-strip')
        const pill = within(strip).getByText('Branch pushed — PR pending')
        expect(pill.closest('span')).toHaveAttribute('title', expect.stringContaining('Retry'))
        expect(within(strip).getByTestId('rail-pr-create')).toHaveTextContent('Retry PR')
        expect(within(strip).queryByTestId('rail-pr-publish')).toBeNull()
        expect(within(strip).queryByTestId('rail-pr-link')).toBeNull()
        expect(within(strip).getByTestId('rail-pr-discard')).toBeInTheDocument()
      })

      it('pr_ready → PR-ready pill + link chip + Check merge + Discard', () => {
        renderRail(snapshot({ decision: 'pr_ready', prUrl: 'https://github.com/o/r/pull/5', prNumber: 5, prState: 'pr-created' }), density)
        const strip = screen.getByTestId('rail-pr-strip')
        expect(within(strip).getByText('PR ready')).toBeInTheDocument()
        expect(within(strip).getByTestId('rail-pr-link')).toHaveTextContent('#5')
        expect(within(strip).getByTestId('rail-pr-poll')).toHaveTextContent('Check merge')
        expect(within(strip).getByTestId('rail-pr-discard')).toBeInTheDocument()
      })

      it('pr_failed → destructive pill + Retry + Discard', () => {
        renderRail(snapshot({ decision: 'pr_failed' }), density)
        const strip = screen.getByTestId('rail-pr-strip')
        expect(within(strip).getByText('PR failed')).toBeInTheDocument()
        expect(within(strip).getByTestId('rail-pr-create')).toHaveTextContent('Retry')
        expect(within(strip).getByTestId('rail-pr-discard')).toBeInTheDocument()
      })
    })
  }
})

describe('RailPrDecisionStrip interactions', () => {
  it('Create PR calls act(create-pr, on_review) and disables the buttons while in flight', async () => {
    let resolveAct: (v: RailPrActResult) => void = () => {}
    const act = vi.fn().mockReturnValue(new Promise<RailPrActResult>((r) => { resolveAct = r }))
    renderStrip(snapshot(), act)
    const create = screen.getByTestId('rail-pr-create')
    fireEvent.click(create)
    expect(act).toHaveBeenCalledWith('create-pr', 'on_review')
    // In flight: every action disabled, spinner mounted on the clicked one.
    expect(create).toBeDisabled()
    expect(screen.getByTestId('rail-pr-discard')).toBeDisabled()
    // A second click while in flight does nothing.
    fireEvent.click(create)
    expect(act).toHaveBeenCalledTimes(1)
    resolveAct({ ok: true, status: 200, decision: 'pr_draft' })
    await waitFor(() => expect(create).not.toBeDisabled())
  })

  it('409 stale_decision → neutral already-resolved toast', async () => {
    const act = vi.fn().mockResolvedValue({ ok: false, status: 409, error: 'stale_decision', current: 'pr_draft' })
    renderStrip(snapshot(), act)
    fireEvent.click(screen.getByTestId('rail-pr-create'))
    await waitFor(() => expect(mockToast.info).toHaveBeenCalledWith('Already resolved elsewhere'))
    expect(mockToast.error).not.toHaveBeenCalled()
  })

  it('502 gh_failed → error toast carrying the detail', async () => {
    const act = vi.fn().mockResolvedValue({ ok: false, status: 502, error: 'gh_failed', detail: 'gh: not logged in' })
    renderStrip(snapshot({ decision: 'pr_draft', prUrl: 'https://github.com/o/r/pull/4', prNumber: 4 }), act)
    fireEvent.click(screen.getByTestId('rail-pr-publish'))
    expect(act).toHaveBeenCalledWith('publish', 'pr_draft')
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('gh: not logged in')))
  })

  it('poll-merge with merged:false → subtle not-merged-yet toast', async () => {
    const act = vi.fn().mockResolvedValue({ ok: true, status: 200, decision: 'pr_ready', merged: false })
    renderStrip(snapshot({ decision: 'pr_ready', prUrl: 'https://github.com/o/r/pull/5', prNumber: 5 }), act)
    fireEvent.click(screen.getByTestId('rail-pr-poll'))
    expect(act).toHaveBeenCalledWith('poll-merge', 'pr_ready')
    await waitFor(() => expect(mockToast.info).toHaveBeenCalledWith('Not merged yet'))
  })

  it('Discard requires the destructive confirm; confirming calls act(discard, <current>)', async () => {
    const act = vi.fn().mockResolvedValue({ ok: true, status: 200, decision: 'discarded' })
    renderStrip(snapshot({ decision: 'pr_failed' }), act)
    fireEvent.click(screen.getByTestId('rail-pr-discard'))
    // No act yet — the confirm dialog gates the destructive action.
    expect(act).not.toHaveBeenCalled()
    const dialog = await screen.findByTestId('rail-pr-discard-confirm')
    expect(dialog).toHaveTextContent('Discard this delivery?')
    expect(dialog).toHaveTextContent('return to Specs')
    fireEvent.click(within(dialog).getByTestId('rail-pr-discard-confirm-btn'))
    await waitFor(() => expect(act).toHaveBeenCalledWith('discard', 'pr_failed'))
  })

  it('cancelling the discard confirm never calls act', async () => {
    const act = vi.fn().mockResolvedValue(okResult)
    renderStrip(snapshot(), act)
    fireEvent.click(screen.getByTestId('rail-pr-discard'))
    const dialog = await screen.findByTestId('rail-pr-discard-confirm')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByTestId('rail-pr-discard-confirm')).toBeNull())
    expect(act).not.toHaveBeenCalled()
  })

  it('create-pr returning 200 with decision pr_failed → error toast (retryable)', async () => {
    const act = vi.fn().mockResolvedValue({ ok: true, status: 200, decision: 'pr_failed' })
    renderStrip(snapshot(), act)
    fireEvent.click(screen.getByTestId('rail-pr-create'))
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith('PR failed'))
  })

  it('create-pr pr_failed WITH a server detail → the toast carries the underlying git reason', async () => {
    const act = vi.fn().mockResolvedValue({
      ok: true, status: 200, decision: 'pr_failed',
      detail: "branch 'feat/37-add-guess' (ticket #37) no longer exists locally and no other rail branch for the ticket holds commits — nothing to deliver",
    })
    renderStrip(snapshot({ decision: 'pr_failed' }), act)
    fireEvent.click(screen.getByTestId('rail-pr-create'))
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('no longer exists locally')))
    expect(mockToast.error).toHaveBeenCalledWith(expect.stringMatching(/^PR failed: /))
  })

  it('create-pr degrading to pr_draft without a PR (pushed/local-only) → error toast with the git detail', async () => {
    const act = vi.fn().mockResolvedValue({
      ok: true, status: 200, decision: 'pr_draft', prUrl: null, prState: 'local-only', detail: 'no remote configured',
    })
    renderStrip(snapshot(), act)
    fireEvent.click(screen.getByTestId('rail-pr-create'))
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('no remote configured')))
  })

  it('create-pr degrading WITHOUT a detail keeps the legacy silent pill flip (no toast)', async () => {
    const act = vi.fn().mockResolvedValue({ ok: true, status: 200, decision: 'pr_draft', prUrl: null, prState: 'pushed' })
    renderStrip(snapshot(), act)
    fireEvent.click(screen.getByTestId('rail-pr-create'))
    await waitFor(() => expect(act).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByTestId('rail-pr-create')).not.toBeDisabled())
    expect(mockToast.error).not.toHaveBeenCalled()
  })

  it('generic failure (network) → action-failed error toast', async () => {
    const act = vi.fn().mockResolvedValue({ ok: false, status: 0, error: 'network' })
    renderStrip(snapshot(), act)
    fireEvent.click(screen.getByTestId('rail-pr-create'))
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("Couldn't apply the PR decision"))
  })
})
