import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '../../../../test-utils'
import type { RailState } from '../../../rails/components/RailsBoard'
import type { SpecBulkHandlers } from '../../../specs/lib/bulk-actions'

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const jira = vi.hoisted(() => ({ moveSpecToStatus: vi.fn(), listStatuses: vi.fn() }))
vi.mock('../../../integrations/lib/jira-api', () => ({ jiraApi: jira }))

// The budget guard is its own unit; here we only need to see that a launch goes through it.
const guardState = vi.hoisted(() => ({ queries: [] as unknown[], guard: vi.fn((launch: () => void) => launch()) }))
vi.mock('../../../../hooks/useLaunchBudgetGuard', () => ({
  useLaunchBudgetGuard: (query: unknown) => {
    guardState.queries.push(query)
    return { guard: guardState.guard, dialog: <div data-testid="budget-guard-dialog" /> }
  },
}))

import { useSpecBulkActions, type BulkLaunchOutcome } from '../useSpecBulkActions'

const RAILS: RailState[] = [
  { id: 'rail-1', label: 'Rail 1', ticketIds: [], mode: 'implement', status: 'idle' },
  { id: 'rail-2', label: 'Rail 2', ticketIds: [], mode: 'implement', status: 'idle' },
  { id: 'rail-3', label: 'Rail 3', ticketIds: [], mode: 'implement', status: 'idle' },
]

const result = (ok: number[], failed: number[] = [], undoable = true) => ({ ok, failed, undoable })

function setup(over: Partial<Parameters<typeof useSpecBulkActions>[0]> = {}) {
  const store = {
    bulkDelete: vi.fn(async (ids: readonly number[]) => result([...ids])),
    bulkUpdateStatus: vi.fn(async (ids: readonly number[]) => result([...ids])),
    bulkUpdatePriority: vi.fn(async (ids: readonly number[]) => result([...ids])),
    bulkUpdateLabels: vi.fn(async (ids: readonly number[]) => result([...ids])),
  }
  const deps = {
    rails: RAILS,
    jiraConnected: true,
    allLabels: ['bug'],
    store,
    moveToRail: vi.fn(() => true),
    launchRail: vi.fn(async (): Promise<BulkLaunchOutcome> => 'launched'),
    gates: { blockerOf: () => null, hasPendingDecision: () => false, takesReviewSlot: () => true, reviewCapacity: Number.POSITIVE_INFINITY },
    forecastQueryOf: (rail: RailState) => ({ projectId: 'p1', loopId: 'factory:implement', provider: rail.id }),
    ...over,
  }
  let handlers!: SpecBulkHandlers
  function Harness() {
    const out = useSpecBulkActions(deps)
    handlers = out.handlers
    return <>{out.dialogs}</>
  }
  render(<Harness />)
  return { deps, store, get h() { return handlers } }
}

describe('useSpecBulkActions (CD4)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    guardState.queries.length = 0
    guardState.guard.mockImplementation((launch: () => void) => launch())
    jira.moveSpecToStatus.mockResolvedValue({ ok: true })
    jira.listStatuses.mockResolvedValue({ statuses: [{ name: 'To Do' }, { name: 'Done' }] })
  })

  it('runs the store handlers for a local status, labels, priority and delete, staying quiet when Undo is offered', async () => {
    const s = setup()
    await act(async () => { await s.h.onStatus([1, 2], { kind: 'local', status: 'done' }) })
    await act(async () => { await s.h.onLabel([1], 'bug', 'add') })
    await act(async () => { await s.h.onLabel([1], 'bug', 'remove') })
    await act(async () => { await s.h.onPriority([1, 2], 'high') })
    await act(async () => { await s.h.onDelete([3]) })
    expect(s.store.bulkUpdateStatus).toHaveBeenCalledWith([1, 2], 'done')
    expect(s.store.bulkUpdateLabels).toHaveBeenNthCalledWith(1, [1], { add: ['bug'] })
    expect(s.store.bulkUpdateLabels).toHaveBeenNthCalledWith(2, [1], { remove: ['bug'] })
    expect(s.store.bulkUpdatePriority).toHaveBeenCalledWith([1, 2], 'high')
    expect(s.store.bulkDelete).toHaveBeenCalledWith([3])
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('reports a partial failure in ONE toast with counts', async () => {
    const s = setup()
    s.store.bulkDelete.mockResolvedValueOnce(result([1, 2, 3], [4, 5]))
    await act(async () => { await s.h.onDelete([1, 2, 3, 4, 5]) })
    expect(toast.warning).toHaveBeenCalledTimes(1)
    expect(toast.warning).toHaveBeenCalledWith('3 of 5 done · 2 failed')
  })

  it('reports a total failure as an error', async () => {
    const s = setup()
    s.store.bulkUpdatePriority.mockResolvedValueOnce(result([], [1, 2], false))
    await act(async () => { await s.h.onPriority([1, 2], 'low') })
    expect(toast.error).toHaveBeenCalledWith('Couldn’t update 2 specs')
  })

  it('moves Jira-backed specs through the Jira outbox call, one per spec, with ONE summary', async () => {
    const s = setup()
    await act(async () => { await s.h.onStatus([5, 6, 7], { kind: 'jira', status: 'Code Review' }) })
    expect(jira.moveSpecToStatus.mock.calls.map((c) => c.slice(0, 2))).toEqual([[5, 'Code Review'], [6, 'Code Review'], [7, 'Code Review']])
    expect(s.store.bulkUpdateStatus).not.toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledWith('Moved 3 specs')
  })

  it('a Jira move that fails for some specs is reported once as partial', async () => {
    const s = setup()
    jira.moveSpecToStatus.mockImplementation(async (id: number) => { if (id === 6) throw new Error('403'); return { ok: true } })
    await act(async () => { await s.h.onStatus([5, 6, 7], { kind: 'jira', status: 'Done' }) })
    expect(toast.warning).toHaveBeenCalledWith('2 of 3 done · 1 failed')
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('lists the Jira board statuses', async () => {
    const s = setup()
    await expect(s.h.loadJiraStatuses()).resolves.toEqual(['To Do', 'Done'])
  })

  it('Add to rail uses the board’s own move per spec and reports one summary', () => {
    const s = setup()
    s.deps.moveToRail.mockImplementation((id: number) => id !== 2)
    act(() => s.h.onMoveToRail([1, 2, 3], 'rail-1'))
    expect(s.deps.moveToRail.mock.calls).toEqual([[1, 'rail-1', { quiet: true }], [2, 'rail-1', { quiet: true }], [3, 'rail-1', { quiet: true }]])
    expect(toast.warning).toHaveBeenCalledWith('2 of 3 done · 1 failed')
  })

  describe('Launch all', () => {
    const open = () => screen.getByRole('dialog')

    it('opens LaunchAllDialog with one rail per spec, and launches nothing until confirmed', () => {
      const s = setup()
      act(() => s.h.onLaunch([1, 2]))
      expect(open()).toHaveTextContent('2 rails')
      expect(open()).toHaveTextContent('2 specs')
      expect(s.deps.launchRail).not.toHaveBeenCalled()
      expect(s.deps.moveToRail).not.toHaveBeenCalled()
    })

    it('cancelling launches nothing', () => {
      const s = setup()
      act(() => s.h.onLaunch([1]))
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(s.deps.launchRail).not.toHaveBeenCalled()
    })

    it('confirming goes through the budget guard, then places each spec on its rail and launches it with the rail as it will be', async () => {
      const s = setup()
      act(() => s.h.onLaunch([1, 2]))
      fireEvent.click(screen.getByRole('button', { name: /Launch 2/ }))
      await waitFor(() => expect(s.deps.launchRail).toHaveBeenCalledTimes(2))
      expect(guardState.guard).toHaveBeenCalledTimes(1)
      expect(guardState.queries).toContainEqual({ projectId: 'p1', loopId: 'factory:implement', provider: 'rail-1' })
      expect(s.deps.moveToRail.mock.calls).toEqual([[1, 'rail-1', { quiet: true }], [2, 'rail-2', { quiet: true }]])
      const launched = s.deps.launchRail.mock.calls as unknown as [string, RailState][]
      expect(launched.map(([id, rail]) => [id, rail.ticketIds])).toEqual([['rail-1', [1]], ['rail-2', [2]]])
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('2 rails launched in parallel', undefined))
      expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('a guard that holds the launch (budget reached) keeps every spec where it is until released', async () => {
      const s = setup()
      let release: (() => void) | undefined
      guardState.guard.mockImplementation((launch: () => void) => { release = launch })
      act(() => s.h.onLaunch([1]))
      fireEvent.click(screen.getByRole('button', { name: /Launch 1/ }))
      expect(guardState.guard).toHaveBeenCalledTimes(1)
      expect(s.deps.launchRail).not.toHaveBeenCalled()
      expect(s.deps.moveToRail).not.toHaveBeenCalled()
      await act(async () => { release?.() })
      await waitFor(() => expect(s.deps.launchRail).toHaveBeenCalledTimes(1))
    })

    it('summarises partial outcomes in one toast (over budget, failed)', async () => {
      const outcomes: BulkLaunchOutcome[] = ['launched', 'budget', 'failed']
      const s = setup({ launchRail: vi.fn(async () => outcomes.shift() ?? 'failed') })
      act(() => s.h.onLaunch([1, 2, 3]))
      fireEvent.click(screen.getByRole('button', { name: /Launch 3/ }))
      await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1))
      expect(toast.success).toHaveBeenCalledWith('1 rail launched in parallel', { description: '1 over the daily budget · 1 failed' })
      expect(toast.error).not.toHaveBeenCalled()
    })

    it('says so when every launch fails', async () => {
      const s = setup({ launchRail: vi.fn(async (): Promise<BulkLaunchOutcome> => 'failed') })
      act(() => s.h.onLaunch([1]))
      fireEvent.click(screen.getByRole('button', { name: /Launch 1/ }))
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('No rails could be launched', { description: '1 failed' }))
    })

    it('mentions the specs that could not get a rail', async () => {
      const s = setup({ rails: [RAILS[0]] })
      act(() => s.h.onLaunch([1, 2, 3]))
      fireEvent.click(screen.getByRole('button', { name: /Launch 1/ }))
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('1 rail launched in parallel', { description: '2 have no free rail' }))
    })

    it('shows an info toast and no dialog when no spec can launch', () => {
      const s = setup({ gates: { blockerOf: () => 'On review', hasPendingDecision: () => false, takesReviewSlot: () => true, reviewCapacity: Infinity } })
      act(() => s.h.onLaunch([1, 2]))
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(toast.info).toHaveBeenCalledWith('None of the selected specs can launch right now', { description: '2 can’t launch yet' })
    })

    it('does not offer a budget forecast for a rail that has no single engine', () => {
      const s = setup({ forecastQueryOf: () => null })
      act(() => s.h.onLaunch([1]))
      expect(guardState.queries.at(-1)).toBeNull()
      void s
    })
  })
})
