import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act } from '../../../../test-utils'
import { DndContext } from '@dnd-kit/core'
import { cleanup } from '@testing-library/react'

const { mockToast, mockRevealItemInDir, mockClipboardWriteText, mockIsTauri } = vi.hoisted(() => ({
  mockToast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  mockRevealItemInDir: vi.fn(),
  mockClipboardWriteText: vi.fn().mockResolvedValue(undefined),
  mockIsTauri: vi.fn(() => false),
}))
vi.mock('sonner', () => ({ toast: mockToast }))
vi.mock('../../../../hooks/useDesktop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../hooks/useDesktop')>()
  return { ...actual, useDesktop: () => ({ ...actual.useDesktop(), activeProjectId: 'p1' }) }
})
vi.mock('../../../../lib/tauri-shell', () => ({
  isTauri: mockIsTauri,
  revealItemInDir: mockRevealItemInDir,
}))

import { RailRow } from '../../../rails/components/RailRow'
import { RailPrDecisionStrip } from '../RailPrDecisionStrip'
import { setActiveProjectId } from '../../../../lib/api'
import type { LocalTicket, RailPrDecision, RailPrStateSnapshot } from '../../../../types'
import type { RailPrActResult } from '../../context/RailPrDecisionContext'
import type { RepositoryDeliverySnapshot } from '../../../projects/types/multi-repo'

/** Secondary actions live behind the "More actions" menu; a lone discard stays a plain button. */
function menuItem(testId: string): HTMLElement {
  const direct = screen.queryByTestId(testId)
  if (direct) return direct
  const trigger = screen.getByTestId('rail-pr-more')
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger)
  return screen.getByTestId(testId)
}

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
const interruptedActionDetail = 'A previous delivery action was interrupted by restart. Its durable evidence was preserved; review the current state and retry.'

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
  mockIsTauri.mockReturnValue(false)
  mockClipboardWriteText.mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: mockClipboardWriteText },
  })
})

describe('grouped RailPrDecisionStrip actions', () => {
  const repositories: RepositoryDeliverySnapshot[] = ['web', 'api'].map((repositoryId) => ({
    repositoryId, name: repositoryId, path: `/repos/${repositoryId}`, deliveryId: `child-${repositoryId}`,
    branch: `feature-${repositoryId}`, baseBranch: 'previous-chunk', integrationBranch: `${repositoryId}-main`,
    deliverySha: 'a'.repeat(40), decision: 'on_review', implementationOutcome: 'succeeded', deliveryOutcome: 'ready',
    statusCode: null, statusDetail: null, prUrl: null, prNumber: null, worktreeIds: [], runIds: [],
  }))

  it('confirms the selected member destination and sends its identity without any global delivery action', async () => {
    const caller = vi.fn().mockResolvedValue({ ...okResult, decision: 'merged' })
    const checkout = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    render(<RailPrDecisionStrip decision={snapshot({ baseBranch: 'unrelated-parent-base', repositoryDeliveries: repositories })}
      density="normal" act={caller} checkout={checkout} />)
    expect(screen.queryByTestId('rail-pr-create')).toBeNull()
    expect(screen.queryByTestId('rail-pr-merge-local')).toBeNull()
    expect(screen.queryByTestId('rail-pr-checkout')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Create PR' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: 'Integrate locally' })).toHaveLength(2)
    expect(menuItem('rail-pr-discard')).toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('region', { name: 'api' })).getByRole('button', { name: 'Integrate locally' }))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByText(/api-main/)).toBeInTheDocument()
    expect(screen.queryByText(/unrelated-parent-base/)).toBeNull()
    expect(caller).not.toHaveBeenCalled()
    fireEvent.click(dialog.getByRole('button', { name: 'Integrate locally' }))
    await waitFor(() => expect(caller).toHaveBeenCalledWith('merge-local', 'on_review', 'del-1', 'api'))
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith(expect.stringContaining('api-main')))
  })

  it.each(['pr_draft', 'pr_ready', 'pr_failed', 'pr_closed', 'no_changes'] as const)('keeps %s global delivery controls hidden while repository rows remain available', (decision) => {
    renderStrip(snapshot({ decision, prUrl: 'https://github.com/test/parent/pull/3', prState: 'pr-created',
      repositoryDeliveries: repositories.map((repository) => ({ ...repository, decision, ...(decision === 'no_changes' ? { deliveryOutcome: 'no_changes' } : {}) })),
    }))
    for (const id of ['rail-pr-create', 'rail-pr-create-partial', 'rail-pr-merge-local', 'rail-pr-publish', 'rail-pr-poll', 'rail-pr-reopen', 'rail-pr-checkout', 'rail-pr-no-changes-done']) {
      expect(screen.queryByTestId(id)).toBeNull()
    }
    expect(screen.getByTestId('repository-deliveries')).toBeInTheDocument()
  })
})

describe('RailPrDecisionStrip states (via RailRow, both densities)', () => {
  for (const density of ['normal', 'compact'] as const) {
    describe(`${density} density`, () => {
      it('renders nothing while building', () => {
        const { view } = renderRail(snapshot({ decision: 'building' }), density)
        expect(view.container.querySelector('[data-testid="rail-pr-strip"]')).toBeNull()
      })

      it('building on an existing PR → Updating-PR pill + link + branch, no decision actions', () => {
        renderRail(snapshot({
          decision: 'building',
          prUrl: 'https://github.com/o/r/pull/521',
          prNumber: 521,
          prState: 'pr-created',
          branch: 'feat/3-add-galaxy-theme-with-blade-trail',
        }), density)
        const strip = screen.getByTestId('rail-pr-strip')
        expect(strip).toHaveAttribute('data-decision', 'building')
        expect(within(strip).getByText('Updating PR')).toBeInTheDocument()
        expect(within(strip).getByTestId('rail-pr-link')).toHaveTextContent('#521')
        expect(within(strip).getByTestId('rail-pr-branch')).toHaveTextContent('feat/3-add-galaxy-theme-with-blade-trail')
        expect(within(strip).queryByTestId('rail-pr-discard')).toBeNull()
        expect(within(strip).queryByTestId('rail-pr-poll')).toBeNull()
      })

      it('shows the spec number inside the status pill, not only in a tooltip', () => {
        renderRail(snapshot(), density)
        const ref = screen.getByTestId('rail-pr-spec-ref')
        expect(ref.textContent).toMatch(/^#\d+/)
        expect(ref.parentElement).toHaveTextContent(/Ready for review/)
      })

      it('on_review → Ready-for-review pill + Create PR (tooltip → base) + Discard', () => {
        renderRail(snapshot(), density)
        const strip = screen.getByTestId('rail-pr-strip')
        expect(strip).toHaveAttribute('data-decision', 'on_review')
        expect(within(strip).getByText('Ready for review')).toBeInTheDocument()
        const create = within(strip).getByTestId('rail-pr-create')
        expect(create).toHaveTextContent('Create PR')
        expect(create).toHaveAttribute('title', '→ main')
        // Review carries the primary call to action; Create PR must not compete with it (or with other rails' Create PR).
        expect(within(strip).getByTestId('rail-pr-open-packet')).toBeInTheDocument()
        expect(create.className).not.toContain('bg-primary')
        expect(menuItem('rail-pr-discard')).toHaveTextContent('Discard')
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
        expect(menuItem('rail-pr-discard')).toBeInTheDocument()
      })

      it('pr_draft degraded (no prUrl) → Branch-pushed pill + Retry PR + Discard, no Publish', () => {
        renderRail(snapshot({ decision: 'pr_draft', prState: 'pushed', branch: 'sr/p/batch-0' }), density)
        const strip = screen.getByTestId('rail-pr-strip')
        const pill = within(strip).getByText('Branch pushed — PR pending')
        expect(pill.closest('span')).toHaveAttribute('title', expect.stringContaining('Retry'))
        expect(within(strip).getByTestId('rail-pr-create')).toHaveTextContent('Retry PR')
        expect(within(strip).queryByTestId('rail-pr-publish')).toBeNull()
        expect(within(strip).queryByTestId('rail-pr-link')).toBeNull()
        expect(menuItem('rail-pr-discard')).toBeInTheDocument()
      })

      it('pr_ready → PR-ready pill + link chip + Verify PR + Discard', () => {
        renderRail(snapshot({ decision: 'pr_ready', prUrl: 'https://github.com/o/r/pull/5', prNumber: 5, prState: 'pr-created' }), density)
        const strip = screen.getByTestId('rail-pr-strip')
        expect(within(strip).getByText('PR ready')).toBeInTheDocument()
        expect(within(strip).getByTestId('rail-pr-link')).toHaveTextContent('#5')
        expect(within(strip).getByTestId('rail-pr-poll')).toHaveTextContent('Verify PR')
        expect(menuItem('rail-pr-discard')).toBeInTheDocument()
      })

      it('pr_failed → destructive pill + Retry + Discard', () => {
        renderRail(snapshot({ decision: 'pr_failed' }), density)
        const strip = screen.getByTestId('rail-pr-strip')
        expect(within(strip).getByText('PR failed')).toBeInTheDocument()
        expect(within(strip).getByTestId('rail-pr-create')).toHaveTextContent('Retry')
        expect(menuItem('rail-pr-discard')).toBeInTheDocument()
      })

      it('implementation_failed → destructive pill + Discard only', () => {
        renderRail(snapshot({ decision: 'implementation_failed' }), density)
        const strip = screen.getByTestId('rail-pr-strip')
        expect(strip).toHaveAttribute('data-decision', 'implementation_failed')
        expect(within(strip).getByText('Implementation failed')).toBeInTheDocument()
        expect(menuItem('rail-pr-discard')).toHaveAttribute('title', expect.stringContaining('implementation run failed'))
        expect(within(strip).queryByTestId('rail-pr-create')).toBeNull()
        expect(within(strip).queryByTestId('rail-pr-merge-local')).toBeNull()
      })

      it('names the delivery loop when the snapshot carries it (custom loops by name); absent otherwise', () => {
        renderRail(snapshot({ decision: 'on_review', loopId: 'custom:hardening', loopName: 'Hardening' }), density)
        // The loop folds into the one status pill's tooltip (the menu is on screen).
        const strip = screen.getByTestId('rail-pr-strip')
        expect(within(strip).queryByTestId('loop-chip')).toBeNull()
        expect(within(strip).getByText('Ready for review').closest('span')).toHaveAttribute('title', expect.stringContaining('Hardening'))
        cleanup()
        renderRail(snapshot({ decision: 'on_review' }), density)
        expect(within(screen.getByTestId('rail-pr-strip')).queryByTestId('loop-chip')).toBeNull()
      })

      it('Flow → Spec with requested changes → review pill, never Discard (the Flow worktree is kept)', () => {
        renderRail(snapshot({ decision: 'implementation_failed', statusCode: 'review_changes_requested', statusDetail: 'The reviewer requested changes (score 58)' }), density)
        const strip = screen.getByTestId('rail-pr-strip')
        expect(within(strip).getByTestId('rail-pr-review-changes')).toHaveTextContent('Changes requested')
        expect(within(strip).getByTestId('rail-pr-review-changes')).toHaveAttribute('title', 'The reviewer requested changes (score 58)')
        expect(within(strip).queryByText('Implementation failed')).toBeNull()
        expect(within(strip).queryByTestId('rail-pr-discard')).toBeNull()
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
    expect(act).toHaveBeenCalledWith('create-pr', 'on_review', 'del-1')
    // In flight: every action disabled, spinner mounted on the clicked one.
    expect(create).toBeDisabled()
    expect(menuItem('rail-pr-discard')).toBeDisabled()
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

  it('surfaces delivery conflicts without disguising them as an answered card', async () => {
    const act = vi.fn().mockResolvedValue({ ok: false, status: 409, error: 'delivery_not_verified', detail: 'Missing commit evidence.' })
    renderStrip(snapshot(), act)
    fireEvent.click(screen.getByTestId('rail-pr-create'))
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith(expect.any(String), { description: 'Missing commit evidence.' }))
    expect(mockToast.info).not.toHaveBeenCalled()
  })

  it('offers local checkout before PR creation and reports preserved worktrees', async () => {
    const checkout = vi.fn().mockResolvedValue({ ok: true, status: 200, branch: 'sr/local', cleanupWarnings: ['Modified worktree preserved.'] })
    render(<RailPrDecisionStrip density="normal" act={vi.fn()} checkout={checkout} decision={snapshot({
      ticketIds: [1], units: [{ ticketId: 1, branch: 'sr/local', succeeded: true, finalSha: 'a'.repeat(40) }],
    })} />)
    fireEvent.click(menuItem('rail-pr-checkout'))
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('Checked out sr/local'))
    expect(checkout).toHaveBeenCalledWith('del-1')
    expect(mockToast.warning).toHaveBeenCalledWith('Cleanup is incomplete (1 warning)', { description: 'Modified worktree preserved.' })
  })

  it.each(['stale', 'untracked'] as const)('does not celebrate an ok HTTP snapshot classified as %s', async (snapshotApplication) => {
    const act = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      decision: 'pr_ready',
      merged: false,
      deliveryVerified: true,
      snapshot: snapshot({ prDeliveryId: 'generation-a', decision: 'pr_ready' }),
      snapshotApplication,
    } satisfies RailPrActResult)
    renderStrip(snapshot({
      prDeliveryId: 'generation-a', decision: 'pr_ready', prUrl: 'https://github.com/o/r/pull/5',
      prState: 'pr-created', deliverySha: 'a'.repeat(40),
    }), act)

    fireEvent.click(screen.getByTestId('rail-pr-poll'))

    await waitFor(() => expect(mockToast.info).toHaveBeenCalledWith('Already resolved elsewhere'))
    expect(mockToast.success).not.toHaveBeenCalled()
    expect(mockToast.warning).not.toHaveBeenCalled()
    expect(mockToast.error).not.toHaveBeenCalled()
  })

  it('409 project recovery reports a safe temporary pause instead of stale/destructive feedback', async () => {
    const act = vi.fn().mockResolvedValue({ ok: false, status: 409, error: 'project_recovery_in_progress' })
    renderStrip(snapshot(), act)
    const create = screen.getByTestId('rail-pr-create')
    fireEvent.click(create)

    await waitFor(() => expect(mockToast.info).toHaveBeenCalledWith(
      'Project recovery is still in progress. Your delivery is safe. Retry in a moment.',
    ))
    expect(mockToast.info).not.toHaveBeenCalledWith('Already resolved elsewhere')
    expect(mockToast.warning).not.toHaveBeenCalled()
    expect(mockToast.error).not.toHaveBeenCalled()
    expect(create).toBeEnabled()
  })

  it('409 operation_in_progress reports the owned operation instead of a stale-decision message', async () => {
    const act = vi.fn().mockResolvedValue({
      ok: false, status: 409, error: 'operation_in_progress', busy: true, operation: 'publish', current: 'pr_draft',
    })
    renderStrip(snapshot({ decision: 'pr_draft', prUrl: 'https://github.com/o/r/pull/4', prState: 'pr-created' }), act)
    fireEvent.click(screen.getByTestId('rail-pr-publish'))
    await waitFor(() => expect(mockToast.info).toHaveBeenCalledWith('Publishing…'))
    expect(mockToast.info).not.toHaveBeenCalledWith('Already resolved elsewhere')
  })

  it('a hydrated operation lease disables all competing dashboard actions', () => {
    renderStrip(snapshot({
      decision: 'pr_draft', prUrl: 'https://github.com/o/r/pull/4', prState: 'pr-created', operation: 'publish',
    }))
    expect(screen.getByTestId('rail-pr-operation')).toHaveTextContent('Publishing…')
    expect(screen.getByTestId('rail-pr-publish')).toBeDisabled()
    expect(menuItem('rail-pr-discard')).toBeDisabled()
  })

  it('502 gh_failed → error toast carrying the detail', async () => {
    const act = vi.fn().mockResolvedValue({ ok: false, status: 502, error: 'gh_failed', detail: 'gh: not logged in' })
    renderStrip(snapshot({ decision: 'pr_draft', prUrl: 'https://github.com/o/r/pull/4', prNumber: 4 }), act)
    fireEvent.click(screen.getByTestId('rail-pr-publish'))
    expect(act).toHaveBeenCalledWith('publish', 'pr_draft', 'del-1')
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith('GitHub CLI failed', { description: 'gh: not logged in' }))
  })

  it('poll-merge with merged:false → subtle not-merged-yet toast', async () => {
    const act = vi.fn().mockResolvedValue({ ok: true, status: 200, decision: 'pr_ready', merged: false })
    renderStrip(snapshot({ decision: 'pr_ready', prUrl: 'https://github.com/o/r/pull/5', prNumber: 5 }), act)
    fireEvent.click(screen.getByTestId('rail-pr-poll'))
    expect(act).toHaveBeenCalledWith('poll-merge', 'pr_ready', 'del-1')
    await waitFor(() => expect(mockToast.info).toHaveBeenCalledWith('Not merged yet'))
  })

  it('poll-merge CLOSED does not also claim it is merely not merged yet', async () => {
    const act = vi.fn().mockResolvedValue({ ok: true, status: 200, decision: 'pr_closed', merged: false })
    renderStrip(snapshot({ decision: 'pr_ready', prUrl: 'https://github.com/o/r/pull/5', prNumber: 5 }), act)
    fireEvent.click(screen.getByTestId('rail-pr-poll'))
    await waitFor(() => expect(act).toHaveBeenCalledWith('poll-merge', 'pr_ready', 'del-1'))
    expect(mockToast.info).not.toHaveBeenCalledWith('Not merged yet')
  })

  it('Checkout calls the checkout callback and shows a success toast', async () => {
    const act = vi.fn().mockResolvedValue(okResult)
    const checkout = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    render(
      <RailPrDecisionStrip
        decision={snapshot({
          decision: 'pr_ready',
          branch: 'feat/review-followup',
          prUrl: 'https://github.com/o/r/pull/5',
          prNumber: 5,
          prState: 'pr-created',
          deliverySha: 'a'.repeat(40),
        })}
        density="normal"
        act={act}
        checkout={checkout}
      />,
    )

    fireEvent.click(menuItem('rail-pr-checkout'))

    await waitFor(() => expect(checkout).toHaveBeenCalledWith('del-1'))
    expect(act).not.toHaveBeenCalled()
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('Checked out feat/review-followup'))
  })

  it('checkout 409 project recovery uses the same safe temporary feedback', async () => {
    const checkout = vi.fn().mockResolvedValue({ ok: false, status: 409, error: 'project_recovery_in_progress' })
    render(
      <RailPrDecisionStrip
        decision={snapshot({
          decision: 'pr_ready', branch: 'feat/review-followup',
          prUrl: 'https://github.com/o/r/pull/5', prState: 'pr-created',
          deliverySha: 'a'.repeat(40),
        })}
        density="normal"
        act={vi.fn().mockResolvedValue(okResult)}
        checkout={checkout}
      />,
    )
    const button = menuItem('rail-pr-checkout')
    fireEvent.click(button)

    await waitFor(() => expect(mockToast.info).toHaveBeenCalledWith(
      'Project recovery is still in progress. Your delivery is safe. Retry in a moment.',
    ))
    expect(mockToast.warning).not.toHaveBeenCalled()
    expect(button).toBeEnabled()
  })

  it('localizes a dirty checkout refusal and makes clear that nothing changed', async () => {
    const checkout = vi.fn().mockResolvedValue({ ok: false, status: 409, error: 'checkout_dirty' })
    render(
      <RailPrDecisionStrip
        decision={snapshot({
          decision: 'pr_ready', branch: 'feat/review-followup',
          prUrl: 'https://github.com/o/r/pull/5', prState: 'pr-created',
          deliverySha: 'a'.repeat(40),
        })}
        density="normal"
        act={vi.fn().mockResolvedValue(okResult)}
        checkout={checkout}
      />,
    )

    fireEvent.click(menuItem('rail-pr-checkout'))

    await waitFor(() => expect(mockToast.warning).toHaveBeenCalledWith(
      'Checkout blocked to protect your changes',
      { description: 'The main project folder has uncommitted changes. Commit or stash them, then retry. Nothing was changed.' },
    ))
  })

  it('localizes an unreadable checkout safety preflight without exposing raw Git output', async () => {
    const checkout = vi.fn().mockResolvedValue({
      ok: false, status: 409, error: 'checkout_safety_unknown', detail: 'fatal: index.lock permission denied',
    })
    render(
      <RailPrDecisionStrip
        decision={snapshot({
          decision: 'pr_ready', branch: 'feat/review-followup',
          prUrl: 'https://github.com/o/r/pull/5', prState: 'pr-created',
          deliverySha: 'a'.repeat(40),
        })}
        density="normal"
        act={vi.fn().mockResolvedValue(okResult)}
        checkout={checkout}
      />,
    )

    fireEvent.click(menuItem('rail-pr-checkout'))

    await waitFor(() => expect(mockToast.warning).toHaveBeenCalledWith(
      'Checkout paused because safety could not be verified',
      { description: 'Specrails could not read the main project folder’s Git status. Nothing was released or changed. Retry after Git is available.' },
    ))
    expect(mockToast.warning).not.toHaveBeenCalledWith(expect.anything(), { description: expect.stringContaining('index.lock') })
  })

  it('restart-interrupted action detail is localized and leaves the recovered card actionable', () => {
    renderStrip(snapshot({
      decision: 'on_review', operation: null, statusCode: 'operation_interrupted', statusDetail: interruptedActionDetail,
    }))

    expect(screen.getByTestId('rail-pr-status-code')).toHaveTextContent('Previous delivery action interrupted')
    expect(screen.getByTestId('rail-pr-recovery-interrupted')).toHaveTextContent(
      'A previous delivery action was interrupted during restart. Your work was preserved; review the current state and retry when ready.',
    )
    expect(screen.queryByText(interruptedActionDetail)).toBeNull()
    expect(screen.getByTestId('rail-pr-create')).toBeEnabled()
    expect(menuItem('rail-pr-discard')).toBeEnabled()
  })

  it('Discard requires the destructive confirm; confirming calls act(discard, <current>)', async () => {
    const act = vi.fn().mockResolvedValue({ ok: true, status: 200, decision: 'discarded' })
    renderStrip(snapshot({ decision: 'pr_failed' }), act)
    fireEvent.click(menuItem('rail-pr-discard'))
    // No act yet — the confirm dialog gates the destructive action.
    expect(act).not.toHaveBeenCalled()
    const dialog = await screen.findByTestId('rail-pr-discard-confirm')
    expect(dialog).toHaveTextContent('Discard this delivery?')
    expect(dialog).toHaveTextContent('PR will be closed without deleting its remote branch')
    expect(dialog).toHaveTextContent('SpecRails-owned local branches and worktrees that are still at their recorded commit')
    expect(dialog).toHaveTextContent('anything changed will be preserved with a warning')
    expect(dialog).toHaveTextContent('specs will return to the Specs backlog')
    expect(dialog).toHaveTextContent('Removed local resources cannot be recovered')
    fireEvent.click(within(dialog).getByTestId('rail-pr-discard-confirm-btn'))
    await waitFor(() => expect(act).toHaveBeenCalledWith('discard', 'pr_failed', 'del-1'))
  })

  it('implementation-failed discard says recoverable local work and branches are preserved', () => {
    renderStrip(snapshot({ decision: 'implementation_failed', implementationOutcome: 'failed' }))
    fireEvent.click(menuItem('rail-pr-discard'))

    const dialog = screen.getByTestId('rail-pr-discard-confirm')
    expect(dialog).toHaveTextContent('Local work and branches will be kept for inspection')
    expect(dialog).toHaveTextContent('Only resources proven safe to clean up may be removed')
    expect(dialog).not.toHaveTextContent('branches and worktrees will be dropped')
  })

  it('cancelling the discard confirm never calls act', async () => {
    const act = vi.fn().mockResolvedValue(okResult)
    renderStrip(snapshot(), act)
    fireEvent.click(menuItem('rail-pr-discard'))
    const dialog = await screen.findByTestId('rail-pr-discard-confirm')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByTestId('rail-pr-discard-confirm')).toBeNull())
    expect(act).not.toHaveBeenCalled()
  })

  it('closes and invalidates generation A confirmation when the rail advances to B', async () => {
    const act = vi.fn().mockResolvedValue(okResult)
    const { view } = renderStrip(snapshot({ prDeliveryId: 'generation-a', decision: 'pr_failed' }), act)
    fireEvent.click(menuItem('rail-pr-discard'))
    const staleConfirmButton = within(await screen.findByTestId('rail-pr-discard-confirm'))
      .getByTestId('rail-pr-discard-confirm-btn')

    view.rerender(
      <RailPrDecisionStrip
        decision={snapshot({ prDeliveryId: 'generation-b', decision: 'pr_failed' })}
        density="normal"
        act={act}
      />,
    )

    await waitFor(() => expect(screen.queryByTestId('rail-pr-discard-confirm')).toBeNull())
    fireEvent.click(staleConfirmButton)
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
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith('PR failed', { description: expect.stringContaining('no longer exists locally') }))
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

describe('RailPrDecisionStrip orthogonal implementation/delivery outcomes', () => {
  it('shows blocked delivery as successful implementation, preserves run evidence, and offers no unsafe retry', () => {
    renderStrip(snapshot({
      decision: 'pr_failed',
      runIds: ['run-4'],
      implementationOutcome: 'succeeded',
      deliveryOutcome: 'blocked',
      isContinuation: true,
      statusCode: 'branch_verification_failed',
      statusDetail: 'the PR branch moved after implementation',
      units: [{
        ticketId: 1, runId: 'run-4', branch: 'feat/1', succeeded: true,
        implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
        initialSha: 'aaa', finalSha: 'bbb', changed: true, failureCode: 'branch_verification_failed',
      }],
    }))
    const strip = screen.getByTestId('rail-pr-strip')
    expect(strip).not.toHaveAttribute('role')
    expect(within(strip).getByRole('status', { name: 'Implementation complete — delivery needs attention' })).toBeInTheDocument()
    expect(within(strip).getByText('Implementation complete — delivery needs attention')).toBeInTheDocument()
    expect(within(strip).getByText('the PR branch moved after implementation')).toBeInTheDocument()
    expect(within(strip).getByTestId('rail-pr-status-code')).toHaveTextContent('Branch verification failed')
    expect(within(strip).getByTestId('rail-pr-run-log')).toBeInTheDocument()
    expect(within(strip).getByTestId('rail-pr-unit-evidence')).toHaveTextContent('delivery blocked')
    expect(within(strip).queryByTestId('rail-pr-create')).toBeNull()
    expect(within(strip).queryByTestId('rail-pr-retry-push')).toBeNull()
    expect(menuItem('rail-pr-dismiss')).toBeInTheDocument()
    expect(within(strip).queryByTestId('rail-pr-discard-local')).toBeNull()
  })

  it('replaces unsafe Checkout with inspect and confirmed commit-and-push recovery for the interrupted continuation', async () => {
    const sha = 'c'.repeat(40)
    const act = vi.fn().mockResolvedValue({
      ok: true, status: 200, decision: 'pr_ready', deliveryVerified: true,
      verifiedSha: sha, remoteHeadSha: sha, pushed: true,
    } satisfies RailPrActResult)
    const checkout = vi.fn()
    render(
      <RailPrDecisionStrip
        decision={snapshot({
          decision: 'pr_failed', prUrl: 'https://github.com/o/r/pull/548', prNumber: 548,
          branch: 'fix/legacy-pr-delivery-recovery', prState: 'pr-created', deliverySha: null,
          implementationOutcome: 'succeeded', deliveryOutcome: 'blocked', isContinuation: true,
          statusCode: 'settlement_interrupted', runIds: ['run-recovered'],
          units: [{
            ticketId: 1, runId: 'run-recovered', branch: 'fix/legacy-pr-delivery-recovery',
            succeeded: true, implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
            initialSha: 'a'.repeat(40), finalSha: null, failureCode: 'settlement_interrupted',
            worktreePath: '/tmp/specrails/worktrees/ticket-1',
          }],
        })}
        density="normal"
        act={act}
        checkout={checkout}
      />,
    )

    expect(screen.queryByTestId('rail-pr-checkout')).toBeNull()
    expect(screen.getByTestId('rail-pr-inspect-local-result')).toHaveTextContent('Inspect local result')
    expect(screen.getByTestId('rail-pr-recover-and-retry')).toHaveTextContent('Commit & retry push')

    fireEvent.click(screen.getByTestId('rail-pr-inspect-local-result'))
    await waitFor(() => expect(mockClipboardWriteText).toHaveBeenCalledWith('/tmp/specrails/worktrees/ticket-1'))
    expect(mockRevealItemInDir).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('rail-pr-recover-and-retry'))
    const dialog = screen.getByTestId('rail-pr-recover-and-retry-confirm')
    expect(dialog).toHaveTextContent('Your main project folder and its uncommitted changes will not be touched')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Commit & retry push' }))

    await waitFor(() => expect(act).toHaveBeenCalledWith('recover-and-retry', 'pr_failed', 'del-1'))
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith(
      'Recovered commit cccccccc is verified in the PR',
    ))
    expect(checkout).not.toHaveBeenCalled()
  })

  it('offers recovery but no misleading local-path action when this computer has no preserved worktree', () => {
    renderStrip(snapshot({
      decision: 'pr_failed', prUrl: 'https://github.com/o/r/pull/548',
      branch: 'fix/legacy-pr-delivery-recovery', prState: 'pr-created', deliverySha: null,
      implementationOutcome: 'succeeded', deliveryOutcome: 'blocked', isContinuation: true,
      statusCode: 'settlement_interrupted', runIds: ['run-recovered'],
      units: [{
        ticketId: 1, runId: 'run-recovered', branch: 'fix/legacy-pr-delivery-recovery',
        succeeded: true, implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
        initialSha: 'a'.repeat(40), finalSha: null, failureCode: 'settlement_interrupted',
      }],
    }))

    expect(screen.getByTestId('rail-pr-recover-and-retry')).toBeInTheDocument()
    expect(screen.queryByTestId('rail-pr-inspect-local-result')).toBeNull()
    expect(screen.queryByTestId('rail-pr-checkout')).toBeNull()
    expect(menuItem('rail-pr-dismiss')).toBeInTheDocument()
    expect(screen.queryByTestId('rail-pr-discard-local')).toBeNull()
  })

  it('shows a truthful unavailable-on-this-computer path with Check again, run inspection, and Dismiss only', () => {
    renderStrip(snapshot({
      decision: 'pr_failed', prUrl: 'https://github.com/o/r/pull/548',
      branch: 'fix/legacy-pr-delivery-recovery', prState: 'pr-created', deliverySha: null,
      implementationOutcome: 'succeeded', deliveryOutcome: 'blocked', isContinuation: true,
      statusCode: 'recovery_unavailable', statusDetail: 'raw recovery scan detail that must not be shown',
      runIds: ['run-recovered'],
      units: [{
        ticketId: 1, runId: 'run-recovered', branch: 'fix/legacy-pr-delivery-recovery',
        succeeded: true, implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
        initialSha: 'a'.repeat(40), finalSha: null, failureCode: 'recovery_unavailable',
      }],
    }))

    expect(screen.getByTestId('rail-pr-recheck-recovery')).toHaveTextContent('Check again')
    expect(screen.getByTestId('rail-pr-run-log')).toBeInTheDocument()
    expect(menuItem('rail-pr-dismiss')).toHaveTextContent('Dismiss follow-up')
    expect(screen.getByTestId('rail-pr-recovery-unavailable')).toHaveTextContent(
      'Specrails could not safely prove one delivery-owned result in this clone. Nothing was changed or removed. Inspect the stage detail and run logs. If the run executed on another computer, open Specrails there, then check again.',
    )
    const technicalDetail = screen.getByTestId('rail-pr-recovery-technical-detail')
    expect(technicalDetail).not.toHaveAttribute('open')
    expect(within(technicalDetail).getByText('Technical recovery detail')).toBeInTheDocument()
    expect(within(technicalDetail).getByText('raw recovery scan detail that must not be shown')).toBeInTheDocument()
    expect(screen.queryByTestId('rail-pr-recover-and-retry')).toBeNull()
    expect(screen.queryByTestId('rail-pr-inspect-local-result')).toBeNull()
    expect(screen.queryByTestId('rail-pr-checkout')).toBeNull()
    expect(screen.queryByTestId('rail-pr-discard')).toBeNull()
    expect(screen.queryByTestId('rail-pr-discard-local')).toBeNull()
  })

  it('offers exactly one explicit local-result discard when unavailable recovery has a protected SHA', () => {
    renderStrip(snapshot({
      decision: 'pr_failed', prUrl: 'https://github.com/o/r/pull/548',
      branch: 'fix/legacy-pr-delivery-recovery', prState: 'pr-created', deliverySha: 'b'.repeat(40),
      implementationOutcome: 'succeeded', deliveryOutcome: 'blocked', isContinuation: true,
      statusCode: 'recovery_unavailable', runIds: ['run-recovered'],
      units: [{
        ticketId: 1, runId: 'run-recovered', branch: 'fix/legacy-pr-delivery-recovery',
        succeeded: true, implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
        initialSha: 'a'.repeat(40), finalSha: 'b'.repeat(40), failureCode: 'recovery_unavailable',
      }],
    }))

    expect(screen.getByTestId('rail-pr-recheck-recovery')).toHaveTextContent('Check again')
    expect(screen.getAllByTestId('rail-pr-discard-local')).toHaveLength(1)
    expect(screen.queryByTestId('rail-pr-dismiss')).toBeNull()
    expect(screen.queryByTestId('rail-pr-discard')).toBeNull()
    expect(screen.queryByTestId('rail-pr-recover-and-retry')).toBeNull()
    expect(screen.queryByTestId('rail-pr-checkout')).toBeNull()
  })

  it('confirms Check again and reports unavailable recovery with localized, non-destructive feedback', async () => {
    const act = vi.fn().mockResolvedValue({
      ok: true, status: 200, decision: 'pr_failed', deliveryVerified: false,
      recoveryUnavailable: true, detail: 'raw scan result',
    } satisfies RailPrActResult)
    renderStrip(snapshot({
      decision: 'pr_failed', prUrl: 'https://github.com/o/r/pull/548',
      branch: 'fix/legacy-pr-delivery-recovery', prState: 'pr-created',
      implementationOutcome: 'succeeded', deliveryOutcome: 'blocked', isContinuation: true,
      statusCode: 'recovery_unavailable', runIds: ['run-recovered'],
      units: [{
        ticketId: 1, runId: 'run-recovered', branch: 'fix/legacy-pr-delivery-recovery',
        succeeded: true, implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
        initialSha: 'a'.repeat(40), finalSha: null, failureCode: 'recovery_unavailable',
      }],
    }), act)

    fireEvent.click(screen.getByTestId('rail-pr-recheck-recovery'))
    const dialog = screen.getByTestId('rail-pr-recover-and-retry-confirm')
    expect(dialog).toHaveTextContent('Check this computer again?')
    expect(dialog).toHaveTextContent('Specrails will rescan this clone’s delivery-owned worktree, branch, refs, reflogs, and orphan Git objects for fix/legacy-pr-delivery-recovery')
    expect(dialog).toHaveTextContent('Your main project folder will not be touched')
    expect(act).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Check again' }))

    await waitFor(() => expect(act).toHaveBeenCalledWith('recover-and-retry', 'pr_failed', 'del-1'))
    await waitFor(() => expect(mockToast.info).toHaveBeenCalledWith(
      'Recovery could not be verified on this computer',
      { description: 'Specrails could not safely prove one delivery-owned result in this clone. Nothing was changed or removed. Inspect the stage detail and run logs. If the run executed on another computer, open Specrails there, then check again.' },
    ))
    expect(mockToast.warning).not.toHaveBeenCalledWith(
      'Local recovery still needs attention',
      { description: 'raw scan result' },
    )
  })

  it('still reveals the preserved worktree in Tauri when clipboard permission is denied', async () => {
    mockIsTauri.mockReturnValue(true)
    mockClipboardWriteText.mockRejectedValueOnce(new Error('clipboard denied'))
    renderStrip(snapshot({
      decision: 'pr_failed', prUrl: 'https://github.com/o/r/pull/548',
      branch: 'fix/legacy-pr-delivery-recovery', prState: 'pr-created',
      implementationOutcome: 'succeeded', deliveryOutcome: 'blocked', isContinuation: true,
      statusCode: 'settlement_interrupted', runIds: ['run-recovered'],
      units: [{
        ticketId: 1, runId: 'run-recovered', branch: 'fix/legacy-pr-delivery-recovery',
        succeeded: true, implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
        initialSha: 'a'.repeat(40), finalSha: null,
        worktreePath: '/tmp/specrails/worktrees/ticket-1',
      }],
    }))

    fireEvent.click(screen.getByTestId('rail-pr-inspect-local-result'))

    await waitFor(() => expect(mockRevealItemInDir).toHaveBeenCalledWith('/tmp/specrails/worktrees/ticket-1'))
    expect(mockToast.info).toHaveBeenCalledWith(
      'Preserved local result',
      { description: '/tmp/specrails/worktrees/ticket-1' },
    )
  })

  it('labels retryable push failures and partial/no-change results truthfully', () => {
    const retryable = renderStrip(snapshot({
      decision: 'pr_failed', implementationOutcome: 'succeeded', deliveryOutcome: 'retryable_failure', statusCode: 'push_failed',
    }))
    expect(screen.getByText('Implementation complete — update failed')).toBeInTheDocument()
    expect(screen.getByTestId('rail-pr-retry-push')).toHaveTextContent('Retry push')
    retryable.view.unmount()

    const partial = renderStrip(snapshot({
      implementationOutcome: 'partially_succeeded', deliveryOutcome: 'partial',
      units: [
        { ticketId: 1, branch: 'feat/1', succeeded: true, implementationOutcome: 'succeeded', deliveryOutcome: 'ready', initialSha: null, finalSha: 'aaa' },
        { ticketId: 2, branch: 'feat/2', succeeded: false, implementationOutcome: 'failed', deliveryOutcome: 'not_started', initialSha: null, finalSha: null, failureCode: 'loop_failed' },
      ],
    }))
    expect(screen.getByText('1 of 2 implementations ready')).toBeInTheDocument()
    expect(screen.getByTestId('rail-pr-create-partial')).toHaveTextContent('Create PR with 1')
    partial.view.unmount()

    renderStrip(snapshot({ decision: 'no_changes', implementationOutcome: 'succeeded', deliveryOutcome: 'no_changes', isContinuation: true }))
    expect(screen.getByText('No changes needed')).toBeInTheDocument()
    expect(screen.queryByTestId('rail-pr-create')).toBeNull()
    expect(menuItem('rail-pr-dismiss')).toBeInTheDocument()
  })

  it('shows Retry push for a recovered legacy settlement interruption, never the blocked card', () => {
    renderStrip(snapshot({
      decision: 'pr_failed', prUrl: 'https://github.com/o/r/pull/7', prState: 'local-only',
      implementationOutcome: 'succeeded', deliveryOutcome: 'retryable_failure',
      statusCode: 'settlement_interrupted', isContinuation: true,
    }))

    expect(screen.getByTestId('rail-pr-retry-push')).toHaveTextContent('Retry push')
    expect(menuItem('rail-pr-dismiss')).toBeInTheDocument()
    expect(screen.queryByText('Implementation complete — delivery needs attention')).not.toBeInTheDocument()
    expect(screen.queryByTestId('rail-pr-discard-local')).not.toBeInTheDocument()
  })

  it('shows implementation failure when contradictory delivery fields are also present', () => {
    renderStrip(snapshot({
      decision: 'implementation_failed', implementationOutcome: 'failed',
      deliveryOutcome: 'blocked', statusCode: 'commit_failed', runIds: ['run-1'],
    }))

    expect(screen.getByText('Implementation failed')).toBeInTheDocument()
    expect(screen.queryByText('Implementation complete — delivery needs attention')).not.toBeInTheDocument()
    expect(screen.queryByTestId('rail-pr-retry-push')).not.toBeInTheDocument()
    expect(menuItem('rail-pr-discard')).toBeInTheDocument()
  })

  it('shows explicit verified-SHA feedback after Retry push', async () => {
    const sha = 'a'.repeat(40)
    const act = vi.fn().mockResolvedValue({
      ok: true, status: 200, decision: 'pr_ready', deliveryVerified: true,
      verifiedSha: sha, remoteHeadSha: sha, pushed: true,
    } satisfies RailPrActResult)
    renderStrip(snapshot({
      decision: 'pr_failed', prUrl: 'https://github.com/o/r/pull/7', branch: 'feat/review',
      implementationOutcome: 'succeeded', deliveryOutcome: 'retryable_failure',
      statusCode: 'push_failed', deliverySha: sha,
    }), act)

    fireEvent.click(screen.getByTestId('rail-pr-retry-push'))

    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith(
      'Push verified · commit aaaaaaaa is in the PR',
    ))
    expect(screen.getByTestId('rail-pr-delivery-sha')).toHaveTextContent('commit aaaaaaaa')
  })

  it('uses Dismiss for a legacy continuation after startup repairs its durable bit', () => {
    renderStrip(snapshot({
      decision: 'pr_ready', prUrl: 'https://github.com/o/r/pull/7', branch: 'feat/review',
      implementationOutcome: 'succeeded', deliveryOutcome: 'delivered', isContinuation: true,
      statusCode: 'pr_ready', deliverySha: 'a'.repeat(40),
      units: [{
        ticketId: 1, runId: 'legacy-run', branch: 'feat/review', succeeded: true,
        implementationOutcome: 'succeeded', deliveryOutcome: 'ready',
        failureCode: 'settlement_interrupted', finalSha: 'a'.repeat(40), branchOwnership: 'borrowed-pr',
      }],
    }))

    expect(menuItem('rail-pr-dismiss')).toBeInTheDocument()
    expect(screen.queryByTestId('rail-pr-discard')).toBeNull()
  })

  it('does not mistake a fresh interrupted delivery with its own PR for a continuation', () => {
    renderStrip(snapshot({
      decision: 'pr_ready', prUrl: 'https://github.com/o/r/pull/8', branch: 'feat/fresh',
      implementationOutcome: 'succeeded', deliveryOutcome: 'delivered', isContinuation: false,
      statusCode: 'pr_ready', deliverySha: 'b'.repeat(40),
      units: [{
        ticketId: 1, runId: 'fresh-run', branch: 'feat/fresh', succeeded: true,
        implementationOutcome: 'succeeded', deliveryOutcome: 'ready',
        failureCode: 'settlement_interrupted', finalSha: 'b'.repeat(40), branchOwnership: 'created',
      }],
    }))

    expect(menuItem('rail-pr-discard')).toBeInTheDocument()
    expect(screen.queryByTestId('rail-pr-dismiss')).toBeNull()
  })

  it('warns and avoids a contradictory not-merged toast when PR verification misses the SHA', async () => {
    const sha = 'a'.repeat(40)
    const act = vi.fn().mockResolvedValue({
      ok: true, status: 200, decision: 'pr_failed', merged: false,
      deliveryVerified: false, verifiedSha: sha, remoteHeadSha: 'b'.repeat(40),
    } satisfies RailPrActResult)
    renderStrip(snapshot({
      decision: 'pr_ready', prUrl: 'https://github.com/o/r/pull/7', branch: 'feat/review',
      implementationOutcome: 'succeeded', deliveryOutcome: 'delivered',
      statusCode: 'pr_ready', deliverySha: sha,
    }), act)

    fireEvent.click(screen.getByTestId('rail-pr-poll'))

    await waitFor(() => expect(mockToast.warning).toHaveBeenCalledWith(
      'The delivery commit is no longer in the PR. Retry push is available again.',
    ))
    expect(mockToast.info).not.toHaveBeenCalledWith('Not merged yet')
  })

  it('labels retryable PR creation distinctly from a push retry or blocked delivery', () => {
    const draft = renderStrip(snapshot({
      decision: 'pr_draft', prState: 'pushed', branch: 'sr/acme/batch-x',
      implementationOutcome: 'succeeded', deliveryOutcome: 'retryable_failure', statusCode: 'delivery_failed',
    }))
    expect(screen.getByText('Branch pushed — PR pending')).toBeInTheDocument()
    expect(screen.getByTestId('rail-pr-create')).toHaveTextContent('Retry PR')
    expect(menuItem('rail-pr-merge-local')).toBeInTheDocument()
    expect(screen.queryByTestId('rail-pr-retry-push')).toBeNull()
    expect(screen.queryByTestId('rail-pr-discard-local')).toBeNull()
    expect(screen.queryByText('Implementation complete — delivery needs attention')).toBeNull()
    draft.view.unmount()

    renderStrip(snapshot({
      decision: 'pr_failed', prState: 'local-only',
      implementationOutcome: 'succeeded', deliveryOutcome: 'retryable_failure', statusCode: 'delivery_failed',
    }))
    expect(screen.getByText('Changes available locally')).toBeInTheDocument()
    expect(screen.getByTestId('rail-pr-create')).toHaveTextContent('Retry PR')
    expect(menuItem('rail-pr-merge-local')).toBeInTheDocument()
    expect(screen.queryByTestId('rail-pr-retry-push')).toBeNull()
    expect(screen.queryByTestId('rail-pr-discard-local')).toBeNull()
    expect(screen.queryByText('Implementation complete — delivery needs attention')).toBeNull()
  })

  it('prioritizes Retry PR when a partial result has a retryable PR-creation failure', () => {
    renderStrip(snapshot({
      decision: 'pr_failed', prState: 'local-only',
      implementationOutcome: 'partially_succeeded', deliveryOutcome: 'retryable_failure', statusCode: 'delivery_failed',
      units: [
        { ticketId: 1, branch: 'feat/1', succeeded: false, implementationOutcome: 'succeeded', deliveryOutcome: 'retryable_failure', initialSha: null, finalSha: 'abc' },
        { ticketId: 2, branch: 'feat/2', succeeded: false, implementationOutcome: 'failed', deliveryOutcome: 'not_started', initialSha: null, finalSha: null },
      ],
    }))

    expect(screen.getByText('Changes available locally')).toBeInTheDocument()
    expect(screen.getByTestId('rail-pr-create')).toHaveTextContent('Retry PR')
    expect(menuItem('rail-pr-merge-local')).toBeInTheDocument()
    expect(screen.queryByTestId('rail-pr-create-partial')).toBeNull()
    expect(screen.queryByTestId('rail-pr-discard-local')).toBeNull()
  })

  it('keeps partial evidence while switching to draft/published lifecycle actions', () => {
    const partialOutcome = {
      implementationOutcome: 'partially_succeeded' as const,
      deliveryOutcome: 'partial' as const,
      units: [
        { ticketId: 1, branch: 'feat/1', succeeded: true, implementationOutcome: 'succeeded' as const, deliveryOutcome: 'ready' as const, initialSha: null, finalSha: 'aaa' },
        { ticketId: 2, branch: 'feat/2', succeeded: false, implementationOutcome: 'failed' as const, deliveryOutcome: 'not_started' as const, initialSha: null, finalSha: null },
      ],
    }
    const draft = renderStrip(snapshot({
      ...partialOutcome, decision: 'pr_draft', prUrl: 'https://github.com/o/r/pull/7', prState: 'pr-created',
    }))
    expect(screen.getByText('1 of 2 implementations ready')).toBeInTheDocument()
    expect(screen.getByTestId('rail-pr-publish')).toHaveTextContent('Publish')
    expect(screen.queryByTestId('rail-pr-create-partial')).toBeNull()
    draft.view.unmount()

    renderStrip(snapshot({
      ...partialOutcome, decision: 'pr_ready', prUrl: 'https://github.com/o/r/pull/7', prState: 'pr-created',
    }))
    expect(screen.getByText('1 of 2 implementations ready')).toBeInTheDocument()
    expect(screen.getByTestId('rail-pr-poll')).toHaveTextContent('Verify PR')
    expect(screen.queryByTestId('rail-pr-create-partial')).toBeNull()
  })

  it('partial with zero delivery-ready units is blocked and never offers create/retry', () => {
    renderStrip(snapshot({
      decision: 'pr_failed', implementationOutcome: 'partially_succeeded', deliveryOutcome: 'partial',
      units: [
        { ticketId: 1, branch: 'feat/1', succeeded: false, implementationOutcome: 'succeeded', deliveryOutcome: 'blocked', initialSha: null, finalSha: null, failureCode: 'commit_failed' },
        { ticketId: 2, branch: 'feat/2', succeeded: false, implementationOutcome: 'failed', deliveryOutcome: 'not_started', initialSha: null, finalSha: null },
      ],
    }))
    expect(screen.getByText('Implementation complete — delivery needs attention')).toBeInTheDocument()
    expect(screen.queryByTestId('rail-pr-create-partial')).toBeNull()
    expect(screen.queryByTestId('rail-pr-create')).toBeNull()
    expect(screen.queryByTestId('rail-pr-retry-push')).toBeNull()
    expect(menuItem('rail-pr-discard')).toBeInTheDocument()
    expect(screen.queryByTestId('rail-pr-discard-local')).toBeNull()
  })

  it('fresh no-change confirms Mark done versus returning to backlog for refinement', async () => {
    const act = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    renderStrip(snapshot({ decision: 'no_changes', implementationOutcome: 'succeeded', deliveryOutcome: 'no_changes' }), act)

    fireEvent.click(screen.getByTestId('rail-pr-no-changes-done'))
    expect(screen.getByTestId('rail-pr-no-changes-done-confirm')).toHaveTextContent('specs will move to Done')
    fireEvent.click(screen.getByTestId('rail-pr-no-changes-done-confirm-btn'))
    await waitFor(() => expect(act).toHaveBeenCalledWith('acknowledge-no-changes', 'no_changes', 'del-1'))

    // the in-flight state clears only after the act promise settles — wait for
    // the button to re-enable or the next click lands on a disabled control
    await waitFor(() => expect(screen.getByTestId('rail-pr-refine')).toBeEnabled())
    fireEvent.click(screen.getByTestId('rail-pr-refine'))
    expect(screen.getByTestId('rail-pr-refine-confirm')).toHaveTextContent('return to the backlog')
    fireEvent.click(screen.getByTestId('rail-pr-refine-confirm-btn'))
    await waitFor(() => expect(act).toHaveBeenCalledWith('discard', 'no_changes', 'del-1'))
  })

  it('supports closed-PR reopen and consequence-specific continuation confirmations', async () => {
    const act = vi.fn().mockResolvedValue({ ok: true, status: 200, decision: 'pr_ready' })
    renderStrip(snapshot({ decision: 'pr_closed', prUrl: 'https://github.com/o/r/pull/9', prState: 'pr-created', isContinuation: true }), act)
    fireEvent.click(screen.getByTestId('rail-pr-reopen'))
    await waitFor(() => expect(act).toHaveBeenCalledWith('reopen', 'pr_closed', 'del-1'))

    await waitFor(() => expect(menuItem('rail-pr-dismiss')).toBeEnabled())
    fireEvent.click(menuItem('rail-pr-dismiss'))
    const dialog = screen.getByTestId('rail-pr-dismiss-confirm')
    expect(dialog).toHaveTextContent('existing PR')
    expect(act).toHaveBeenCalledTimes(1)
    fireEvent.click(within(dialog).getByTestId('rail-pr-dismiss-confirm-btn'))
    await waitFor(() => expect(act).toHaveBeenCalledWith('dismiss', 'pr_closed', 'del-1'))
  })

  it('blocked local-result discard is separately confirmed as destructive', async () => {
    const act = vi.fn().mockResolvedValue({ ok: true, status: 200, decision: 'discarded' })
    renderStrip(snapshot({
      decision: 'pr_failed', implementationOutcome: 'succeeded', deliveryOutcome: 'blocked', statusCode: 'commit_failed', isContinuation: true,
      units: [{
        ticketId: 1, branch: 'feat/1', succeeded: true,
        implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
        initialSha: null, finalSha: null, worktreePath: '/tmp/recoverable-ticket-1',
      }],
    }), act)
    fireEvent.click(screen.getByTestId('rail-pr-discard-local'))
    const dialog = screen.getByTestId('rail-pr-discard-local-confirm')
    expect(dialog).toHaveTextContent('recoverable local iteration')
    expect(act).not.toHaveBeenCalled()
    // Shared ConfirmDialog, destructive tone: ghost Cancel then a destructive primary.
    expect(within(dialog).getByTestId('rail-pr-discard-local-confirm-btn').className).toMatch(/bg-destructive/)
    expect(within(dialog).getByRole('button', { name: 'Cancel' }).className).not.toMatch(/border/)
    fireEvent.click(within(dialog).getByTestId('rail-pr-discard-local-confirm-btn'))
    await waitFor(() => expect(act).toHaveBeenCalledWith('discard', 'pr_failed', 'del-1'))
  })

  it('fresh blocked delivery with an attached PR uses truthful full discard semantics', () => {
    renderStrip(snapshot({
      decision: 'pr_failed', implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
      statusCode: 'branch_verification_failed', isContinuation: false,
      prUrl: 'https://github.com/o/r/pull/44', prNumber: 44, prState: 'pr-created',
    }))

    expect(menuItem('rail-pr-discard')).toHaveTextContent('Discard')
    expect(screen.queryByTestId('rail-pr-discard-local')).toBeNull()
    fireEvent.click(menuItem('rail-pr-discard'))
    const dialog = screen.getByTestId('rail-pr-discard-confirm')
    expect(dialog).toHaveTextContent('The PR will be closed without deleting its remote branch')
    expect(dialog).toHaveTextContent('specs will return to the Specs backlog')
  })

  it('discloses durable safety archives without mislabeling cleanup as incomplete', () => {
    renderStrip(snapshot({
      decision: 'pr_ready', prUrl: 'https://github.com/o/r/pull/45', prState: 'pr-created',
      safetyArchives: ['/worktrees/ticket-1.specrails-overlay-quarantine-a1/.mcp.json'],
      cleanupWarnings: [],
    }))

    const archives = screen.getByTestId('rail-pr-safety-archives')
    expect(archives).toHaveTextContent('Safety archive (1)')
    expect(archives).toHaveTextContent('ticket-1.specrails-overlay-quarantine-a1/.mcp.json')
    expect(screen.queryByText(/Cleanup is incomplete/)).toBeNull()
  })

  it('distinguishes local-only delivery from a pushed branch', () => {
    renderStrip(snapshot({ decision: 'pr_draft', prState: 'local-only', branch: 'feat/local' }))
    expect(screen.getByText('Changes available locally')).toBeInTheDocument()
  })
})

// ─── merge-local (remote-less acceptance) ─────────────────────────────────────

describe('merge-local action', () => {
  it('offers Integrate-locally on on_review, degraded draft and pr_failed — never once a PR exists', () => {
    for (const snap of [
      snapshot({ decision: 'on_review' }),
      snapshot({ decision: 'pr_draft', prUrl: null, prState: 'local-only' }),
      snapshot({ decision: 'pr_failed' }),
    ]) {
      const { unmount } = render(<RailPrDecisionStrip decision={snap} density="normal" act={vi.fn()} />)
      expect(menuItem('rail-pr-merge-local')).toBeInTheDocument()
      unmount()
    }
    for (const snap of [
      snapshot({ decision: 'pr_draft', prUrl: 'https://github.com/o/r/pull/7', prNumber: 7, prState: 'pr-created' }),
      snapshot({ decision: 'pr_ready', prUrl: 'https://github.com/o/r/pull/7', prNumber: 7, prState: 'pr-created' }),
      snapshot({ decision: 'implementation_failed' }),
    ]) {
      const { unmount } = render(<RailPrDecisionStrip decision={snap} density="normal" act={vi.fn()} />)
      expect(screen.queryByTestId('rail-pr-merge-local')).toBeNull()
      unmount()
    }
  })

  it('confirms before acting, then POSTs merge-local with the current decision', async () => {
    const act = vi.fn().mockResolvedValue({ ok: true, status: 200, decision: 'merged', merged: true })
    render(<RailPrDecisionStrip decision={snapshot({ decision: 'on_review' })} density="normal" act={act} />)
    fireEvent.click(menuItem('rail-pr-merge-local'))
    expect(act).not.toHaveBeenCalled() // confirm dialog first
    // Non-destructive confirm: default tone, focus starts on the primary.
    const confirmBtn = screen.getByTestId('rail-pr-merge-local-confirm-btn')
    expect(confirmBtn.className).not.toMatch(/bg-destructive/)
    await waitFor(() => expect(confirmBtn).toHaveFocus())
    fireEvent.click(confirmBtn)
    await waitFor(() => expect(act).toHaveBeenCalledWith('merge-local', 'on_review', 'del-1'))
    await waitFor(() => expect(mockToast.success).toHaveBeenCalled())
  })

  it('a blocked precondition surfaces the fix-it toast, never "already resolved"', async () => {
    const act = vi.fn().mockResolvedValue({
      ok: false, status: 409, error: 'merge_local_blocked', reason: 'dirty', base: 'main',
    })
    render(<RailPrDecisionStrip decision={snapshot({ decision: 'on_review' })} density="normal" act={act} />)
    fireEvent.click(menuItem('rail-pr-merge-local'))
    fireEvent.click(screen.getByTestId('rail-pr-merge-local-confirm-btn'))
    await waitFor(() => expect(mockToast.warning).toHaveBeenCalled())
    expect(mockToast.info).not.toHaveBeenCalled()
  })

  it('a merge conflict surfaces the merge_failed detail', async () => {
    const act = vi.fn().mockResolvedValue({
      ok: false, status: 502, error: 'merge_failed', detail: "merging 'feat/1': CONFLICT",
    })
    render(<RailPrDecisionStrip decision={snapshot({ decision: 'pr_failed' })} density="normal" act={act} />)
    fireEvent.click(menuItem('rail-pr-merge-local'))
    fireEvent.click(screen.getByTestId('rail-pr-merge-local-confirm-btn'))
    await waitFor(() => expect(mockToast.error).toHaveBeenCalled())
  })
})

describe('strip: one primary, readable detail, honest spinners', () => {
  it('shows the Refine spinner only for Refine, never for a Discard in flight', async () => {
    let finish!: (r: RailPrActResult) => void
    const act = vi.fn(() => new Promise<RailPrActResult>((resolve) => { finish = resolve }))
    renderStrip(snapshot({ decision: 'no_changes', implementationOutcome: 'succeeded', deliveryOutcome: 'no_changes' }), act)
    fireEvent.click(screen.getByTestId('rail-pr-refine'))
    fireEvent.click(screen.getByTestId('rail-pr-refine-confirm-btn'))
    await waitFor(() => expect(act).toHaveBeenCalled())
    expect(screen.getByTestId('rail-pr-refine').querySelector('.animate-spin')).not.toBeNull()
    finish({ ok: true, status: 200 })
    await waitFor(() => expect(screen.getByTestId('rail-pr-refine')).toBeEnabled())
  })

  it('carries the delivery help hint', () => {
    renderStrip(snapshot({ decision: 'on_review' }))
    expect(screen.getByTestId('rail-pr-strip').querySelector('[data-help-topic="prDecision"]')).not.toBeNull()
  })

  it('implementation_failed offers Relaunch as the one primary and a visible explanation', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 202 })) as unknown as typeof fetch
    setActiveProjectId('p1')
    renderStrip(snapshot({ decision: 'implementation_failed', railIndex: 2 }))
    expect(screen.getByTestId('rail-pr-detail-line')).toHaveTextContent(/implementation run failed/i)
    fireEvent.click(screen.getByTestId('rail-pr-relaunch'))
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(expect.stringMatching(/\/rails\/2\/relaunch$/), expect.objectContaining({ method: 'POST', body: JSON.stringify({ sourceId: 'del-1' }) })))
  })

  describe('resumable failed attempt', () => {
    const run = (over = {}) => ({ runId: 'run-1', status: 'failed', nextStep: 'fixer', recoverableSteps: [], active: false, canResume: true, canCancel: false, ...over })
    const routeFetch = (runs: unknown[]) => {
      global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const href = String(url)
        if (init?.method === 'POST') return new Response('{}', { status: 202 })
        if (href.includes('/agent-runtime/runs')) return new Response(JSON.stringify({ runs }), { status: 200 })
        return new Response('{}', { status: 200 })
      }) as unknown as typeof fetch
    }

    it('offers Resume as the primary instead of Relaunch when the run can resume', async () => {
      routeFetch([run()])
      renderStrip(snapshot({ decision: 'implementation_failed', railIndex: 2, runIds: ['run-1'] }))
      const resume = await screen.findByTestId('rail-pr-resume')
      expect(screen.queryByTestId('rail-pr-relaunch')).toBeNull()
      fireEvent.click(resume)
      await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(expect.stringMatching(/\/agent-runtime\/runs\/run-1\/resume$/), expect.objectContaining({ method: 'POST' })))
    })

    it('a continuation gets Resume as its primary, and no Relaunch when it cannot resume', async () => {
      routeFetch([run()])
      const { view } = renderStrip(snapshot({ decision: 'implementation_failed', runIds: ['run-1'], isContinuation: true } as never))
      expect(await screen.findByTestId('rail-pr-resume')).toBeInTheDocument()
      view.unmount()
      routeFetch([run({ canResume: false })])
      renderStrip(snapshot({ decision: 'implementation_failed', runIds: ['run-1'], isContinuation: true } as never))
      await act(async () => {})
      expect(screen.queryByTestId('rail-pr-relaunch')).toBeNull()
      expect(screen.queryByTestId('rail-pr-resume')).toBeNull()
    })

    it('disables Relaunch while the rail still has an active run', async () => {
      routeFetch([run({ canResume: false, active: true, status: 'running', canCancel: true })])
      renderStrip(snapshot({ decision: 'implementation_failed', runIds: ['run-1'] }))
      await waitFor(() => expect(screen.getByTestId('rail-pr-relaunch')).toBeDisabled())
      expect(screen.getByTestId('rail-pr-relaunch')).toHaveAttribute('title', 'The rail still has an active run')
    })

    it('never offers the plain rail Relaunch for a Flow to Spec run', async () => {
      routeFetch([run({ canResume: false })])
      renderStrip(snapshot({ decision: 'implementation_failed', runIds: ['run-1'], loopId: 'factory:flow-spec' }))
      await act(async () => {})
      expect(screen.queryByTestId('rail-pr-relaunch')).toBeNull()
    })
  })
})

