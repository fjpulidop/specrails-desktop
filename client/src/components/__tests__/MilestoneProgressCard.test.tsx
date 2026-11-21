import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '../../test-utils'
import userEvent from '@testing-library/user-event'
import { MilestoneAutoAdvanceToggle, MilestoneCard, MilestoneChainRow, MilestoneProgressBar, MilestoneRailRow } from '../../features/builder/components/project-builder/MilestoneProgressCard'
import type { MilestoneProgress, MilestoneRail, MilestoneChainSnapshot, ChainOffer, ChainPlanView, RailHold } from '../../features/builder/lib/milestone-progress'

function progress(over: Partial<MilestoneProgress> = {}): MilestoneProgress {
  return {
    id: 'm1', n: 1, title: 'Walking skeleton', storedStatus: 'committed', state: 'running',
    counts: { total: 8, done: 0, onReview: 3, inProgress: 3, todo: 2, failed: 1 }, rails: [], chain: null, ...over,
  }
}
function rail(over: Partial<MilestoneRail> = {}): MilestoneRail {
  return { railIndex: 3, name: 'M1 · 1', ticketIds: [1, 2, 3], active: false, hold: null, engine: null, runId: null, startedAt: null, chunkIndex: 1, delivery: null, ...over }
}
const delivery = (decision: string) => ({ id: 'd-3', railIndex: 3, ticketIds: [1, 2, 3], decision, branch: 'feat/1', baseBranch: 'main', prUrl: null, prNumber: null, prState: 'none', createdAt: null })
function chain(over: Partial<MilestoneChainSnapshot> = {}): MilestoneChainSnapshot {
  return { id: 'c1', milestoneN: 1, mode: 'sequential', status: 'running', pauseReason: null, autoAdvance: true, nextChunk: 2, totalChunks: 3, currentRailIndex: 4, headBranch: 'feat/1-implement', retryChunk: null, launched: [], createdAt: null, updatedAt: 'x', plan: null, nextEngine: null, ...over }
}

describe('MilestoneProgressBar', () => {
  it('renders one segment per non-zero state with widths that add up', () => {
    render(<MilestoneProgressBar counts={{ total: 8, done: 2, onReview: 3, inProgress: 1, todo: 2, failed: 1 }} />)
    const bar = screen.getByTestId('milestone-progress-bar')
    const segs = Array.from(bar.querySelectorAll('[data-segment]')).map((el) => el.getAttribute('data-segment'))
    expect(bar.querySelector('.animate-pulse, [class*="animate-pulse"]')).toBeNull()
    expect(segs).toEqual(['done', 'onReview', 'inProgress', 'failed', 'todo'])
    expect(bar.getAttribute('aria-label')).toBe('5 of 8 delivered · 2 done')
  })
})

describe('MilestoneCard', () => {
  it('reads a delivered milestone honestly — delivered / awaiting review, never done', () => {
    render(<MilestoneCard progress={progress({ state: 'delivered', counts: { total: 8, done: 0, onReview: 8, inProgress: 0, todo: 0, failed: 0 } })} />)
    expect(screen.getByTestId('milestone-state-pill')).toHaveTextContent('Delivered — awaiting review')
    // Awaiting review is the review state, never amber.
    expect(screen.getByTestId('milestone-state-pill')).toHaveAttribute('data-run-state', 'review')
    expect(screen.getByTestId('milestone-counts')).toHaveTextContent('8 of 8 delivered · 0 done')
    expect(screen.queryByText(/complete/i)).not.toBeInTheDocument()
    expect(screen.queryByTestId('milestone-failed-note')).not.toBeInTheDocument()
  })

  it('shows the failed-attempt note, the chain row and rails with their decision + Review', async () => {
    const onReview = vi.fn()
    const onResume = vi.fn()
    const user = userEvent.setup()
    render(
      <MilestoneCard
        progress={progress({
          chain: chain({ status: 'paused', pauseReason: 'launch_rejected:rail_limit_reached' }),
          rails: [rail({ delivery: delivery('on_review') }), rail({ railIndex: 4, name: 'M1 · 2', chunkIndex: 2, active: true, runId: 'r', startedAt: new Date(Date.now() - 65_000).toISOString() })],
        })}
        onReview={onReview}
        onResume={onResume}
      />,
    )
    expect(screen.getByTestId('milestone-failed-note')).toHaveTextContent('1 spec failed its last attempt')
    const chainRow = screen.getByTestId('milestone-chain-row')
    expect(chainRow).toHaveAttribute('data-status', 'paused')
    expect(chainRow).toHaveTextContent('Paused — the next rail could not launch (rail_limit_reached)')
    await user.click(screen.getByTestId('milestone-chain-resume'))
    expect(onResume).toHaveBeenCalledWith('c1')
    const rows = screen.getAllByTestId('milestone-rail-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('M1 · 1')
    expect(screen.getByTestId('pr-decision-pill')).toBeInTheDocument()
    await user.click(screen.getByTestId('milestone-rail-review'))
    expect(onReview).toHaveBeenCalledWith('d-3')
    expect(screen.getByTestId('milestone-rail-running')).toHaveTextContent(/Running · 1m/)
  })

  it('a chain paused at the rail limit explains how to free a rail', () => {
    render(<MilestoneCard progress={progress({ chain: chain({ status: 'paused', pauseReason: 'rail_limit_reached' }) })} onResume={vi.fn()} />)
    expect(screen.getByTestId('milestone-chain-row')).toHaveTextContent('Paused — every rail holds a PR awaiting your decision — merge or discard pending PRs to free a rail, then resume')
  })

  it('hides a completed chain once no rail is live; a cancelled chain is not shown either', () => {
    const { rerender } = render(<MilestoneCard progress={progress({ chain: chain({ status: 'completed' }) })} />)
    expect(screen.queryByTestId('milestone-chain-row')).not.toBeInTheDocument()
    rerender(<MilestoneCard progress={progress({ chain: chain({ status: 'cancelled' }) })} />)
    expect(screen.queryByTestId('milestone-chain-row')).not.toBeInTheDocument()
  })

  it('a planned milestone with no specs renders no bar', () => {
    render(<MilestoneCard progress={progress({ state: 'planned', counts: { total: 0, done: 0, onReview: 0, inProgress: 0, todo: 0, failed: 0 } })} />)
    expect(screen.queryByTestId('milestone-progress-bar')).not.toBeInTheDocument()
    expect(screen.getByTestId('milestone-state-pill')).toHaveTextContent('Planned')
  })
})

describe('MilestoneChainRow / MilestoneRailRow', () => {
  it('running chain shows k of n, the wait and the stacked branch; cancel is offered', async () => {
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(<MilestoneChainRow chain={chain()} onCancel={onCancel} />)
    expect(screen.getByTestId('milestone-chain-row')).toHaveTextContent('Sequential chain · rail 2 of 3')
    expect(screen.getByTestId('milestone-chain-row')).toHaveTextContent('waiting for rail 2 to settle')
    expect(screen.getByTestId('milestone-chain-row')).toHaveTextContent('feat/1-implement')
    await user.click(screen.getByTestId('milestone-chain-cancel'))
    expect(onCancel).toHaveBeenCalledWith('c1')
    expect(screen.queryByTestId('milestone-chain-resume')).not.toBeInTheDocument()
  })

  it('a chain paused on a failed spec asks where to resume: the failed step or the start', async () => {
    const onResume = vi.fn()
    const user = userEvent.setup()
    const failed = chain({ status: 'paused', pauseReason: 'chunk_stopped', retryChunk: 1, launched: [
      { chunk: 1, railIndex: 3, ticketIds: [1], runIds: ['r1'], deliveryId: 'd-3' },
      { chunk: 2, railIndex: 4, ticketIds: [2], runIds: ['r2'], deliveryId: 'd-4' },
    ] })
    render(<MilestoneChainRow chain={failed} onResume={onResume} />)
    await user.click(screen.getByTestId('milestone-chain-resume'))
    expect(onResume).not.toHaveBeenCalled()
    expect(screen.getByTestId('milestone-chain-resume-failed-step')).toHaveTextContent('From the step that failed')
    expect(screen.getByTestId('milestone-chain-resume-start')).toHaveTextContent('From the start')
    await user.click(screen.getByTestId('milestone-chain-resume-failed-step'))
    expect(onResume).toHaveBeenCalledWith('c1', 'failed_step')
    await user.click(screen.getByTestId('milestone-chain-resume'))
    await user.click(screen.getByTestId('milestone-chain-resume-start'))
    expect(onResume).toHaveBeenLastCalledWith('c1', 'start')
  })

  it('a pause that is not a failed spec resumes directly', async () => {
    const onResume = vi.fn()
    const user = userEvent.setup()
    render(<MilestoneChainRow chain={chain({ status: 'paused', pauseReason: 'head_missing' })} onResume={onResume} />)
    await user.click(screen.getByTestId('milestone-chain-resume'))
    expect(onResume).toHaveBeenCalledWith('c1')
    expect(screen.queryByTestId('milestone-chain-resume-failed-step')).not.toBeInTheDocument()
  })

  it('a wave checkpoint offers Launch next rail (resume), the auto-continue switch (PATCH) and Cancel', async () => {
    const onResume = vi.fn()
    const onSetAutoAdvance = vi.fn()
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(<MilestoneChainRow chain={chain({ status: 'awaiting_approval', autoAdvance: false, nextChunk: 1, headBranch: 'feat/1' })} onResume={onResume} onSetAutoAdvance={onSetAutoAdvance} onCancel={onCancel} />)
    const row = screen.getByTestId('milestone-chain-row')
    expect(row).toHaveAttribute('data-status', 'awaiting_approval')
    expect(screen.getByTestId('milestone-chain-checkpoint')).toHaveTextContent('Rail 1 of 3 delivered — launch rail 2?')
    expect(row).toHaveTextContent('feat/1')
    expect(screen.queryByTestId('milestone-chain-resume')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('milestone-chain-launch-next'))
    expect(onResume).toHaveBeenCalledWith('c1')
    const toggle = screen.getByTestId('milestone-chain-auto-advance')
    expect(toggle).toHaveAttribute('role', 'switch')
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    await user.click(toggle)
    expect(onSetAutoAdvance).toHaveBeenCalledWith('c1', true)
    await user.click(screen.getByTestId('milestone-chain-cancel'))
    expect(onCancel).toHaveBeenCalledWith('c1')
  })

  it('a running chain with auto-continue off says it stops after this rail; parallel chains never show the switch', () => {
    const { rerender } = render(<MilestoneChainRow chain={chain({ autoAdvance: false, nextChunk: 2 })} onSetAutoAdvance={vi.fn()} />)
    expect(screen.getByTestId('milestone-chain-checkpoint-note')).toHaveTextContent('stops after this rail')
    expect(screen.getByTestId('milestone-chain-auto-advance')).toHaveAttribute('aria-checked', 'false')
    rerender(<MilestoneChainRow chain={chain({ autoAdvance: true, nextChunk: 2 })} onSetAutoAdvance={vi.fn()} />)
    expect(screen.queryByTestId('milestone-chain-checkpoint-note')).not.toBeInTheDocument()
    expect(screen.getByTestId('milestone-chain-auto-advance')).toHaveAttribute('aria-checked', 'true')
    // The last rail has nothing to stop before.
    rerender(<MilestoneChainRow chain={chain({ autoAdvance: false, nextChunk: 3 })} onSetAutoAdvance={vi.fn()} />)
    expect(screen.queryByTestId('milestone-chain-checkpoint-note')).not.toBeInTheDocument()
    rerender(<MilestoneChainRow chain={chain({ mode: 'parallel', status: 'running' })} onSetAutoAdvance={vi.fn()} />)
    expect(screen.queryByTestId('milestone-chain-auto-advance')).not.toBeInTheDocument()
  })

  it('MilestoneAutoAdvanceToggle flips and disables', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(<MilestoneAutoAdvanceToggle checked={false} onChange={onChange} />)
    expect(screen.getByTestId('milestone-auto-advance')).toHaveTextContent('Continue automatically')
    await user.click(screen.getByTestId('milestone-auto-advance'))
    expect(onChange).toHaveBeenCalledWith(true)
    rerender(<MilestoneAutoAdvanceToggle checked onChange={onChange} disabled />)
    expect(screen.getByTestId('milestone-auto-advance')).toBeDisabled()
    expect(screen.getByTestId('milestone-auto-advance')).toHaveAttribute('aria-checked', 'true')
  })

  it('parallel + completed / cancelled copy', () => {
    const { rerender } = render(<MilestoneChainRow chain={chain({ mode: 'parallel', status: 'completed' })} />)
    expect(screen.getByTestId('milestone-chain-row')).toHaveTextContent('Parallel launch')
    expect(screen.getByTestId('milestone-chain-row')).toHaveTextContent('All rails launched')
    rerender(<MilestoneChainRow chain={chain({ status: 'cancelled' })} />)
    expect(screen.getByTestId('milestone-chain-row')).toHaveTextContent('Chain cancelled')
  })

  it('a rail without a delivery or run says so and opens the rail on click', async () => {
    const onOpenRail = vi.fn()
    const user = userEvent.setup()
    render(<MilestoneRailRow rail={rail({ name: null, chunkIndex: null })} now={Date.now()} onOpenRail={onOpenRail} />)
    expect(screen.getByText('Rail 4')).toBeInTheDocument()
    expect(screen.getByText('No delivery yet')).toBeInTheDocument()
    await user.click(screen.getByText('Rail 4'))
    expect(onOpenRail).toHaveBeenCalledWith(expect.objectContaining({ railIndex: 3 }))
    expect(screen.queryByTestId('milestone-rail-review')).not.toBeInTheDocument()
  })
})

describe('MilestoneChainRow — the reconciled next step', () => {
  const offer = (kind: ChainOffer['kind'], over: Partial<ChainOffer> = {}): ChainOffer =>
    ({ kind, from: 'recommended', ticketId: 7, title: 'Animate the tabletop and screen transitions', runId: null, nextTicketId: null, ...over })
  const plan = (offers: ChainOffer[], over: Partial<ChainPlanView> = {}): ChainPlanView =>
    ({ action: null, offers, specs: [], settled: 2, total: 5, pausedTicketId: 6, pausedSpecSettled: true, ...over })

  it('the paused rail\'s spec is already delivered: the only offer is to continue with the next spec', async () => {
    const onResume = vi.fn()
    const user = userEvent.setup()
    render(<MilestoneChainRow chain={chain({ status: 'paused', pauseReason: 'head_discarded', retryChunk: 1, launched: [{ chunk: 2, railIndex: 3, ticketIds: [6], runIds: ['r'], deliveryId: 'd' }], plan: plan([offer('next')]) })} onResume={onResume} />)
    const primary = screen.getByTestId('milestone-chain-resume')
    expect(primary).toHaveAttribute('data-offer', 'next')
    expect(primary).toHaveTextContent('Continue with the next spec (#7 Animate the tabletop and screen transit…)')
    expect(primary).toHaveAttribute('title', '#6 is already delivered; nothing runs twice')
    // Honest reason kept, plus what reconciliation found.
    expect(screen.getByTestId('milestone-chain-row')).toHaveTextContent('the delivery the next rail builds on was discarded')
    expect(screen.getByTestId('milestone-chain-paused-delivered')).toHaveTextContent('#6 is already delivered')
    // No "from the failed step / from the start" menu for a spec that did not fail.
    expect(screen.queryByTestId('milestone-chain-resume-more')).not.toBeInTheDocument()
    expect(screen.queryByTestId('milestone-chain-resume-failed-step')).not.toBeInTheDocument()
    await user.click(primary)
    expect(onResume).toHaveBeenCalledWith('c1', 'recommended')
  })

  it('a genuinely failed spec offers the failed step first and a fresh retry as the alternative', async () => {
    const onResume = vi.fn()
    const user = userEvent.setup()
    render(<MilestoneChainRow chain={chain({ status: 'paused', pauseReason: 'chunk_failed', retryChunk: 1, plan: plan([
      offer('resume_failed_step', { ticketId: 6, from: 'failed_step', runId: 'fork-1' }),
      offer('retry_from_start', { ticketId: 6, from: 'start' }),
    ], { pausedSpecSettled: false }) })} onResume={onResume} />)
    const primary = screen.getByTestId('milestone-chain-resume')
    expect(primary).toHaveTextContent('Resume #6 from the failed step')
    expect(screen.queryByTestId('milestone-chain-paused-delivered')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('milestone-chain-resume-more'))
    expect(await screen.findByTestId('milestone-chain-offer-retry_from_start')).toHaveTextContent('Retry #6 from the start')
    await user.click(screen.getByTestId('milestone-chain-offer-retry_from_start'))
    expect(onResume).toHaveBeenCalledWith('c1', 'start')
  })

  it('names every other step honestly: integrate, follow or resume a run, retry, finish', () => {
    const cases: Array<[ChainOffer, string]> = [
      [offer('integrate', { ticketId: 6, nextTicketId: 7 }), 'Integrate #6 and continue'],
      [offer('rebuild', { ticketId: 3, from: 'start' }), 'Run #3 again on the updated base'],
      [offer('follow_run'), 'Follow the run of #7'],
      [offer('answer_run'), 'Follow the run of #7 (it needs your answer)'],
      [offer('resume_run'), 'Resume the run of #7'],
      [offer('retry', { ticketId: 6 }), 'Retry #6'],
      [offer('complete', { ticketId: null, title: null }), 'Finish the chain'],
    ]
    for (const [o, text] of cases) {
      const { unmount } = render(<MilestoneChainRow chain={chain({ status: 'paused', pauseReason: 'chunk_stopped', plan: plan([o]) })} onResume={vi.fn()} />)
      expect(screen.getByTestId('milestone-chain-resume')).toHaveTextContent(text)
      unmount()
    }
  })

  it('a checkpoint launches the reconciled next step', async () => {
    const onResume = vi.fn()
    const user = userEvent.setup()
    render(<MilestoneChainRow chain={chain({ status: 'awaiting_approval', plan: plan([offer('next')]) })} onResume={onResume} />)
    await user.click(screen.getByTestId('milestone-chain-launch-next'))
    expect(onResume).toHaveBeenCalledWith('c1', 'recommended')
  })

  it('a paused milestone reads Paused, not Ready to launch', () => {
    render(<MilestoneCard progress={progress({ state: 'paused' })} />)
    expect(screen.getByTestId('milestone-state-pill')).toHaveTextContent('Paused')
    expect(screen.getByTestId('milestone-state-pill')).toHaveAttribute('data-run-state', 'paused')
  })
})

describe('held rails — a live run that is not working (the reported "Running · 7m 26s" while paused)', () => {
  const started = '2026-11-21T14:52:45.000Z'
  const pausedAt = '2026-11-21T15:00:11.000Z' // 7m 26s later
  const held = (hold: RailHold, over: Partial<MilestoneRail> = {}) => rail({ railIndex: 3, name: 'M1 · #7', chunkIndex: 3, ticketIds: [7], active: true, runId: 'run-7', startedAt: started, hold, ...over })
  const later = Date.parse(pausedAt) + 30 * 60_000

  it('paused by you reads "Paused by you", never Running, with a frozen run time and an inline Resume', async () => {
    const onResumeRun = vi.fn()
    const user = userEvent.setup()
    render(<MilestoneRailRow rail={held({ kind: 'paused', since: pausedAt, byYou: true })} now={later} onResumeRun={onResumeRun} />)
    expect(screen.queryByTestId('milestone-rail-running')).not.toBeInTheDocument()
    const status = screen.getByTestId('milestone-rail-held')
    expect(status).toHaveAttribute('data-hold', 'pausedByYou')
    expect(status).toHaveTextContent('Paused by you')
    expect(status.getAttribute('title')).toContain('Ran 7m 26s before it stopped')
    expect(screen.getByTestId('milestone-rail-held').querySelector('[data-run-state]')).toHaveAttribute('data-run-state', 'paused')
    await user.click(screen.getByTestId('milestone-rail-resume'))
    expect(onResumeRun).toHaveBeenCalledWith('run-7')
  })

  it('each hold kind speaks the status vocabulary; a question opens the run to answer it', async () => {
    const cases: Array<[RailHold, string, string, 'resume' | 'answer' | null]> = [
      [{ kind: 'question', since: pausedAt }, 'Waiting for your answer', 'needs-input', 'answer'],
      [{ kind: 'approval', since: pausedAt }, 'Waiting for your approval', 'needs-input', 'answer'],
      [{ kind: 'provider_limit', since: pausedAt, resumeAt: '2026-11-21T18:00:00.000Z' }, 'Paused by the usage limit', 'blocked', null],
      [{ kind: 'budget', since: pausedAt }, 'Paused at the spending limit', 'paused', null],
      [{ kind: 'queued', since: pausedAt, waitingFor: 'run_slots', position: 1 }, 'Waiting for capacity', 'queued', null],
      [{ kind: 'restart', since: pausedAt }, 'Paused by a restart', 'paused', null],
      [{ kind: 'interrupted', since: pausedAt }, 'Interrupted', 'paused', null],
      [{ kind: 'paused', since: pausedAt }, 'Paused', 'paused', null],
    ]
    for (const [hold, label, state, action] of cases) {
      const onOpenRail = vi.fn()
      const { unmount } = render(<MilestoneRailRow rail={held(hold)} now={later} onOpenRail={onOpenRail} onResumeRun={vi.fn()} />)
      expect(screen.getByTestId('milestone-rail-held')).toHaveTextContent(label)
      expect(screen.getByTestId('milestone-rail-held').querySelector('[data-run-state]')).toHaveAttribute('data-run-state', state)
      expect(screen.queryByTestId('milestone-rail-running')).not.toBeInTheDocument()
      expect(!!screen.queryByTestId('milestone-rail-resume')).toBe(action === 'resume')
      expect(!!screen.queryByTestId('milestone-rail-answer')).toBe(action === 'answer')
      if (action === 'answer') {
        await userEvent.setup().click(screen.getByTestId('milestone-rail-answer'))
        expect(onOpenRail).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-7' }))
      }
      unmount()
    }
  })

  it('a working run keeps its live elapsed', () => {
    render(<MilestoneRailRow rail={held(null as never)} now={Date.parse(started) + 65_000} />)
    expect(screen.getByTestId('milestone-rail-running')).toHaveTextContent(/Running · 1m/)
  })

  it('the chain row says the rail it waits on is paused by you and offers Resume while the chain is still running', async () => {
    const onResume = vi.fn()
    const user = userEvent.setup()
    const c = chain({
      status: 'running', nextChunk: 3, totalChunks: 5,
      plan: {
        action: { kind: 'resume_run', ticketId: 7, runId: 'run-7', pauseKind: 'user' },
        offers: [{ kind: 'resume_run', from: 'recommended', ticketId: 7, title: 'M1 · #7', runId: 'run-7', nextTicketId: null }],
        specs: [{ ticketId: 7, title: 'M1 · #7', state: 'paused' }], settled: 2, total: 5, pausedTicketId: 7, pausedSpecSettled: false,
      },
    })
    render(<MilestoneCard progress={progress({ chain: c, rails: [held({ kind: 'paused', since: pausedAt, byYou: true })] })} onResume={onResume} />)
    const row = screen.getByTestId('milestone-chain-row')
    expect(row).toHaveAttribute('data-held', 'pausedByYou')
    expect(screen.getByTestId('milestone-chain-held')).toHaveTextContent('Rail 3 paused — paused by you')
    expect(row).not.toHaveTextContent('waiting for rail 3')
    const resume = screen.getByTestId('milestone-chain-resume')
    expect(resume).toHaveTextContent('Resume the run of #7')
    await user.click(resume)
    expect(onResume).toHaveBeenCalledWith('c1', 'recommended')
  })

  it('a chain waiting on a rail that asks a question says so and opens that run', async () => {
    const onOpenRail = vi.fn()
    const user = userEvent.setup()
    const c = chain({
      status: 'running', nextChunk: 3, totalChunks: 5,
      plan: {
        action: { kind: 'answer_run', ticketId: 7, runId: 'run-7', pauseKind: null },
        offers: [{ kind: 'answer_run', from: 'recommended', ticketId: 7, title: null, runId: 'run-7', nextTicketId: null }],
        specs: [], settled: 2, total: 5, pausedTicketId: 7, pausedSpecSettled: false,
      },
    })
    render(<MilestoneCard progress={progress({ chain: c, rails: [held({ kind: 'question', since: pausedAt })] })} onOpenRail={onOpenRail} onResume={vi.fn()} />)
    expect(screen.getByTestId('milestone-chain-held')).toHaveTextContent('Rail 3 waits for your answer')
    await user.click(screen.getByTestId('milestone-chain-answer'))
    expect(onOpenRail).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-7' }))
  })

  it('a chain whose rail works keeps the ordinary wait copy', () => {
    render(<MilestoneCard progress={progress({ chain: chain({ nextChunk: 3 }), rails: [held(null as never, { chunkIndex: 3 })] })} />)
    expect(screen.queryByTestId('milestone-chain-held')).not.toBeInTheDocument()
    expect(screen.getByTestId('milestone-chain-row')).not.toHaveAttribute('data-held')
  })
})

describe('engines on the chain and rail rows', () => {
  const CLAUDE = { provider: 'claude', model: 'sonnet', reasoningEffort: null }
  const CODEX = { provider: 'codex', model: 'gpt-6.2-sol', reasoningEffort: null }
  const launched = (chunk: number, engine: typeof CLAUDE | null) => ({ chunk, railIndex: chunk + 2, ticketIds: [chunk + 4], runIds: [`r${chunk}`], deliveryId: null, engine })

  it('a rail row names the engine its run uses', () => {
    render(<MilestoneRailRow rail={rail({ engine: CODEX })} now={0} />)
    expect(screen.getByTestId('milestone-rail-engine')).toHaveTextContent('Codex · GPT-6.2 Sol')
  })

  it('the chain row shows the next rail\'s engine before it launches, and says when the configuration changed', () => {
    const { rerender } = render(<MilestoneChainRow chain={chain({ nextChunk: 3, totalChunks: 5, launched: [launched(1, CLAUDE), launched(2, CLAUDE)], nextEngine: { ...CLAUDE, source: 'launch' } })} />)
    expect(screen.getByTestId('milestone-chain-next-engine')).toHaveTextContent('Next rail: Claude · Claude Sonnet')
    expect(screen.getByTestId('milestone-chain-next-engine')).toHaveAttribute('data-changed', 'false')
    rerender(<MilestoneChainRow chain={chain({ nextChunk: 3, totalChunks: 5, launched: [launched(1, CLAUDE), launched(2, CLAUDE)], nextEngine: { ...CODEX, source: 'usual' } })} />)
    expect(screen.getByTestId('milestone-chain-next-engine')).toHaveTextContent('The next rail uses the new configuration: Codex · GPT-6.2 Sol')
    expect(screen.getByTestId('milestone-chain-next-engine')).toHaveAttribute('data-source', 'usual')
    // Every spec launched and nothing to relaunch: no next-rail line.
    rerender(<MilestoneChainRow chain={chain({ nextChunk: 2, totalChunks: 2, launched: [launched(1, CLAUDE), launched(2, CODEX)], nextEngine: { ...CODEX, source: 'usual' } })} />)
    expect(screen.queryByTestId('milestone-chain-next-engine')).not.toBeInTheDocument()
  })
})
