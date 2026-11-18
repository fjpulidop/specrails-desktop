import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { RetainedWorktreesSection } from '../RetainedWorktreesSection'
import {
  getRetainedSizes, getRetainedWorktrees, removeRetainedWorktrees,
  type RetainedWorktree, type RetainedWorktreesSnapshot,
} from '../../lib/retained-worktrees-api'
import { matchesFilters, retainedRunState } from '../../lib/retained-worktrees-model'

vi.mock('../../lib/retained-worktrees-api', () => ({
  getRetainedWorktrees: vi.fn(),
  getRetainedSizes: vi.fn(),
  removeRetainedWorktrees: vi.fn(),
}))

const MB = 1024 * 1024
const HEAD = 'a'.repeat(40)

function item(patch: Partial<RetainedWorktree> & { id: string }): RetainedWorktree {
  return {
    kind: 'rail', projectId: 'p1', projectName: 'Web app', railIndex: 0, ticketId: 12, ticketTitle: 'Login form', runId: 'r1',
    branch: `feat/${patch.id}`, worktreePath: `/wt/${patch.id}`, state: 'needs-review', pr: null, lastActivityAt: null, idleDays: 9,
    head: HEAD, trackedChanges: 0, untrackedFiles: 0, ignoredAtRisk: [], ignoredAtRiskCount: 0, unpushedCommits: 0,
    evaluation: { label: 'nothing-to-lose', reasons: [], removable: true, removeBlocker: null, branchDeletable: true },
    ...patch,
  }
}

const safe = item({ id: 'safe' })
const ahead = item({
  id: 'ahead', ticketId: 13, ticketTitle: 'Billing', unpushedCommits: 2, idleDays: 3,
  pr: { url: 'https://example.invalid/pr/4', number: 4, decision: 'pr_ready', deliveryState: 'pr-created' },
  evaluation: { label: 'waiting-for-you', reasons: ['unpushed-commits', 'open-delivery'], removable: true, removeBlocker: null, branchDeletable: false },
})
const dirty = item({
  id: 'dirty', projectId: 'p2', projectName: 'API', ticketId: 3, ticketTitle: 'Rate limit', trackedChanges: 2, ignoredAtRisk: ['.env.local'], ignoredAtRiskCount: 1,
  evaluation: { label: 'waiting-for-you', reasons: ['uncommitted-changes', 'ignored-files'], removable: false, removeBlocker: 'uncommitted-changes', branchDeletable: false },
})

const snapshot: RetainedWorktreesSnapshot = {
  generatedAt: '2026-11-18T10:00:00Z',
  projects: [{ projectId: 'p1', projectName: 'Web app' }, { projectId: 'p2', projectName: 'API' }],
  items: [safe, ahead, dirty],
}

const flush = async () => { await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }) }

beforeEach(() => {
  vi.mocked(getRetainedWorktrees).mockReset().mockResolvedValue(snapshot)
  vi.mocked(getRetainedSizes).mockReset().mockImplementation(async (refs) => refs.map(ref => ({ ...ref, size: { status: 'done' as const, bytes: (ref.id === 'safe' ? 300 : 50) * MB, scannedAt: 1 } })))
  vi.mocked(removeRetainedWorktrees).mockReset().mockResolvedValue([
    { projectId: 'p1', id: 'safe', status: 'removed', reason: null, branchDeleted: true, warnings: [] },
    { projectId: 'p1', id: 'ahead', status: 'kept', reason: 'changed', branchDeleted: false, warnings: ['worktree /wt/ahead: preserved'] },
  ])
})
afterEach(() => { cleanup() })

describe('RetainedWorktreesSection', () => {
  it('reads nothing until its pane is shown', async () => {
    render(<RetainedWorktreesSection active={false} />)
    await flush()
    expect(getRetainedWorktrees).not.toHaveBeenCalled()
  })

  it('lists retained worktrees per project with labels, facts, reasons and lazily measured sizes', async () => {
    render(<RetainedWorktreesSection active />)
    await flush()
    const projects = screen.getAllByTestId('retained-project')
    expect(projects.map(project => within(project).getByText(/Web app|API/).textContent)).toEqual(['Web app', 'API'])
    const rows = screen.getAllByTestId('retained-worktree')
    expect(rows).toHaveLength(3)
    expect(within(rows[0]).getByText('Nothing to lose')).toBeInTheDocument()
    expect(within(rows[0]).getByText('300 MB')).toBeInTheDocument()
    expect(rows[1].textContent).toContain('PR #4 · ready')
    expect(rows[1].textContent).toContain('2 commits only on this branch')
    expect(rows[1].textContent).toContain('its delivery still waits for your decision')
    expect(rows[2].textContent).toContain('.env.local')
    expect(getRetainedSizes).toHaveBeenCalledWith(expect.arrayContaining([{ projectId: 'p2', id: 'dirty' }]), expect.anything())
    expect(screen.getByText(/3 worktrees · 400 MB/)).toBeInTheDocument()
  })

  it('cannot select a worktree whose removal would lose work', async () => {
    render(<RetainedWorktreesSection active />)
    await flush()
    const box = within(screen.getAllByTestId('retained-worktree')[2]).getByRole('checkbox')
    expect(box).toBeDisabled()
    expect(box).toHaveAttribute('title', "Can't remove it here: it has uncommitted changes")
  })

  it('filters by label', async () => {
    render(<RetainedWorktreesSection active />)
    await flush()
    fireEvent.click(screen.getByTestId('retained-filter-safe'))
    expect(screen.getAllByTestId('retained-worktree')).toHaveLength(1)
  })

  it('confirms what goes, sends the confirmed heads and shows the outcome', async () => {
    render(<RetainedWorktreesSection active />)
    await flush()
    const rows = screen.getAllByTestId('retained-worktree')
    fireEvent.click(within(rows[0]).getByRole('checkbox'))
    fireEvent.click(within(rows[1]).getByRole('checkbox'))
    fireEvent.click(screen.getByLabelText('Also delete branches that hold nothing new'))
    fireEvent.click(screen.getByTestId('retained-remove'))
    const dialog = await screen.findByTestId('retained-confirm')
    expect(dialog.textContent).toContain('Remove 2 worktrees?')
    expect(dialog.textContent).toContain('350 MB')
    expect(dialog.textContent).toContain('1 branches that hold nothing new are deleted too')
    fireEvent.click(screen.getByTestId('retained-confirm-button'))
    await flush()
    expect(removeRetainedWorktrees).toHaveBeenCalledWith([
      { projectId: 'p1', id: 'safe', head: HEAD, deleteBranch: true },
      { projectId: 'p1', id: 'ahead', head: HEAD, deleteBranch: false },
    ])
    const results = screen.getByTestId('retained-results')
    expect(results.textContent).toContain('Removed: 1 · Branches deleted: 1 · Kept: 1')
    expect(results.textContent).toContain('Kept because it changed after you confirmed.')
    expect(getRetainedWorktrees).toHaveBeenCalledTimes(2)
  })
})

describe('retained worktree model', () => {
  it('speaks the run-state vocabulary', () => {
    expect(retainedRunState(safe)).toBe('done')
    expect(retainedRunState(ahead)).toBe('review')
    expect(retainedRunState(item({ id: 'x', evaluation: { label: 'waiting-for-you', reasons: ['run-active'], removable: false, removeBlocker: 'run-active', branchDeletable: false } }))).toBe('working')
  })

  it('hides by idle days and by known size only', () => {
    const filters = { label: 'all' as const, minIdleDays: 10, minSizeMb: 0 }
    expect(matchesFilters(safe, undefined, filters)).toBe(false)
    expect(matchesFilters(safe, undefined, { ...filters, minIdleDays: 0, minSizeMb: 100 })).toBe(true)
    expect(matchesFilters(safe, { status: 'done', bytes: 10 * MB, scannedAt: 1 }, { ...filters, minIdleDays: 0, minSizeMb: 100 })).toBe(false)
  })
})
