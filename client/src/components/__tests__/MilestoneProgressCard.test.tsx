import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '../../test-utils'
import userEvent from '@testing-library/user-event'
import { MilestoneAutoAdvanceToggle, MilestoneCard, MilestoneChainRow, MilestoneProgressBar, MilestoneRailRow } from '../project-builder/MilestoneProgressCard'
import type { MilestoneProgress, MilestoneRail, MilestoneChainSnapshot } from '../../lib/milestone-progress'

function progress(over: Partial<MilestoneProgress> = {}): MilestoneProgress {
  return {
    id: 'm1', n: 1, title: 'Walking skeleton', storedStatus: 'committed', state: 'running',
    counts: { total: 8, done: 0, onReview: 3, inProgress: 3, todo: 2, failed: 1 }, rails: [], chain: null, ...over,
  }
}
function rail(over: Partial<MilestoneRail> = {}): MilestoneRail {
  return { railIndex: 3, name: 'M1 · 1', ticketIds: [1, 2, 3], active: false, runId: null, startedAt: null, chunkIndex: 1, delivery: null, ...over }
}
const delivery = (decision: string) => ({ id: 'd-3', railIndex: 3, ticketIds: [1, 2, 3], decision, branch: 'feat/1', baseBranch: 'main', prUrl: null, prNumber: null, prState: 'none', createdAt: null })
function chain(over: Partial<MilestoneChainSnapshot> = {}): MilestoneChainSnapshot {
  return { id: 'c1', milestoneN: 1, mode: 'sequential', status: 'running', pauseReason: null, autoAdvance: true, nextChunk: 2, totalChunks: 3, currentRailIndex: 4, headBranch: 'feat/1-batch', launched: [], updatedAt: 'x', ...over }
}

describe('MilestoneProgressBar', () => {
  it('renders one segment per non-zero state with widths that add up', () => {
    render(<MilestoneProgressBar counts={{ total: 8, done: 2, onReview: 3, inProgress: 1, todo: 2, failed: 1 }} />)
    const bar = screen.getByTestId('milestone-progress-bar')
    const segs = Array.from(bar.querySelectorAll('[data-segment]')).map((el) => el.getAttribute('data-segment'))
    expect(segs).toEqual(['done', 'onReview', 'inProgress', 'failed', 'todo'])
    expect(bar.getAttribute('aria-label')).toBe('5 of 8 delivered · 2 done')
  })
})

describe('MilestoneCard', () => {
  it('reads a delivered milestone honestly — delivered / awaiting review, never done', () => {
    render(<MilestoneCard progress={progress({ state: 'delivered', counts: { total: 8, done: 0, onReview: 8, inProgress: 0, todo: 0, failed: 0 } })} />)
    expect(screen.getByTestId('milestone-state-pill')).toHaveTextContent('Delivered — awaiting review')
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
    expect(screen.getByTestId('milestone-chain-row')).toHaveTextContent('feat/1-batch')
    await user.click(screen.getByTestId('milestone-chain-cancel'))
    expect(onCancel).toHaveBeenCalledWith('c1')
    expect(screen.queryByTestId('milestone-chain-resume')).not.toBeInTheDocument()
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
    expect(onOpenRail).toHaveBeenCalledWith(3)
    expect(screen.queryByTestId('milestone-rail-review')).not.toBeInTheDocument()
  })
})
