import { describe, expect, it, vi } from 'vitest'
import { checkIntervalMs, parsePrUrl, pollPrMerges, startPrMergeWatch, watchedDeliveries, type PrMergeWatchState } from './pr-merge-watch'
import type { RailPrDeliveryRow } from './rail-pr-store'

const store = vi.hoisted(() => ({ rows: [] as RailPrDeliveryRow[], children: [] as RailPrDeliveryRow[] }))
vi.mock('./rail-pr-store', () => ({
  listActivePrDeliveries: () => store.rows,
  listChildPrDeliveries: (_db: unknown, parentId: string) => store.children.filter((row) => row.parent_delivery_id === parentId),
  getPrDelivery: (_db: unknown, id: string) => store.rows.find((row) => row.id === id),
}))

const NOW = Date.parse('2026-11-14T12:00:00Z')
const row = (over: Partial<RailPrDeliveryRow>): RailPrDeliveryRow => ({
  id: 'd1', decision: 'pr_ready', pr_url: 'https://github.com/o/r/pull/1', operation_token: null,
  execution_manifest: null, repository_path: null, published_at: '2026-11-14T11:55:00Z', created_at: '2026-11-14 11:00:00', ...over,
} as RailPrDeliveryRow)

/** gh api graphql: answer each aliased PR with the state in `states` (OPEN by default). */
function graphql(states: Record<string, string>) {
  return vi.fn(async (_cmd: string, args: string[]) => {
    const value = (name: string) => args.find((arg) => arg.startsWith(`${name}=`))!.slice(name.length + 1)
    const query = value('query'), owner = value('owner'), repo = value('repo')
    const repository: Record<string, { state: string }> = {}
    for (const [, n] of query.matchAll(/p(\d+): pullRequest/g)) repository[`p${n}`] = { state: states[`${owner}/${repo}#${n}`] ?? 'OPEN' }
    return { code: 0, stdout: JSON.stringify({ data: { repository } }), stderr: '' }
  })
}

function deps(states: Record<string, string>) {
  const run = graphql(states)
  const execute = vi.fn(async () => ({ status: 200, body: { ok: true } }))
  const lock = vi.fn(async <T,>(_path: string, fn: () => Promise<T>) => fn())
  const assertCurrent = vi.fn()
  let now = NOW
  return {
    run, execute, lock, assertCurrent, advance: (ms: number) => { now += ms },
    deps: { db: {} as never, project: { id: 'p1', slug: 'proj', path: '/repo' }, broadcast: vi.fn(), exec: { run } as never, execute: execute as never, lock, admission: () => ({ assertCurrent }), now: () => now, log: vi.fn() },
  }
}

describe('background merge watch', () => {
  it('watches only open PRs out for review that no decision holds', () => {
    const rows = [
      row({ id: 'ready' }), row({ id: 'draft', decision: 'pr_draft' }), row({ id: 'review', decision: 'on_review' }),
      row({ id: 'nopr', pr_url: null }), row({ id: 'busy', operation_token: 'tok' }), row({ id: 'multi', execution_manifest: '{}', pr_url: null }),
    ]
    expect(watchedDeliveries(rows).map((entry) => entry.id)).toEqual(['ready', 'draft', 'multi'])
    expect(parsePrUrl('https://github.com/fjpulidop/deckdex_mtg/pull/154')).toEqual({ owner: 'fjpulidop', repo: 'deckdex_mtg', number: 154 })
    expect(parsePrUrl('https://gitlab.com/o/r/merge_requests/1')).toBeNull()
  })

  it('backs off by PR age: 3 min, 10 min, 30 min, 2 h', () => {
    expect(checkIntervalMs(5 * 60_000)).toBe(3 * 60_000)
    expect(checkIntervalMs(2 * 3_600_000)).toBe(10 * 60_000)
    expect(checkIntervalMs(3 * 86_400_000)).toBe(30 * 60_000)
    expect(checkIntervalMs(30 * 86_400_000)).toBe(2 * 3_600_000)
  })

  it('reads every due PR of a repository in ONE call and settles merged/closed ones through poll-merge; open PRs are never touched', async () => {
    store.rows = [
      row({ id: 'merged', pr_url: 'https://github.com/o/r/pull/1' }),
      row({ id: 'open', pr_url: 'https://github.com/o/r/pull/2' }),
      row({ id: 'closed', decision: 'pr_draft', pr_url: 'https://github.com/o/r/pull/3' }),
      row({ id: 'other', pr_url: 'https://github.com/o/lib/pull/7' }),
    ]
    const f = deps({ 'o/r#1': 'MERGED', 'o/r#3': 'CLOSED' })
    await expect(pollPrMerges(f.deps)).resolves.toBe(2)
    expect(f.run).toHaveBeenCalledTimes(2) // one per repository, not one per PR
    expect(f.run.mock.calls[0]![1]).toEqual(expect.arrayContaining(['api', 'graphql', 'owner=o', 'repo=r']))
    expect(f.execute).toHaveBeenCalledTimes(2)
    expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ project: { id: 'p1', slug: 'proj', path: '/repo' } }), { prDeliveryId: 'merged', action: 'poll-merge', expectedDecision: 'pr_ready' })
    expect(f.execute).toHaveBeenCalledWith(expect.anything(), { prDeliveryId: 'closed', action: 'poll-merge', expectedDecision: 'pr_draft' })
    expect(f.lock).toHaveBeenCalledWith('/repo', expect.any(Function))
    expect(f.assertCurrent).toHaveBeenCalled()
  })

  it('does not re-observe a PR before its back-off is due, and forgets deliveries that left review', async () => {
    store.rows = [row({ id: 'fresh' }), row({ id: 'old', pr_url: 'https://github.com/o/r/pull/9', published_at: '2026-10-01T00:00:00Z' })]
    const f = deps({})
    const state: PrMergeWatchState = { checkedAt: new Map() }
    await pollPrMerges(f.deps, state)
    expect(f.run).toHaveBeenCalledTimes(1)
    f.run.mockClear(); f.advance(4 * 60_000)
    await pollPrMerges(f.deps, state)
    // Only the fresh PR is due again (3 min); the month-old one waits 2 h.
    expect(f.run.mock.calls[0]![1].join(' ')).toMatch(/p1: pullRequest/)
    expect(f.run.mock.calls[0]![1].join(' ')).not.toMatch(/p9: pullRequest/)
    f.run.mockClear(); f.advance(60_000)
    await pollPrMerges(f.deps, state)
    expect(f.run).not.toHaveBeenCalled()
    store.rows = []
    await pollPrMerges(f.deps, state)
    expect(state.checkedAt.size).toBe(0)
  })

  it('a gh failure records no back-off; a delivery a decision claimed while gh ran is skipped', async () => {
    store.rows = [row({ id: 'raced' })]
    const f = deps({ 'o/r#1': 'MERGED' })
    f.run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'gh: not logged in' } as never)
    const state: PrMergeWatchState = { checkedAt: new Map() }
    await expect(pollPrMerges(f.deps, state)).resolves.toBe(0)
    expect(state.checkedAt.size).toBe(0)
    const answer = f.run.getMockImplementation()!
    f.run.mockImplementationOnce(async (cmd: string, args: string[]) => {
      store.rows[0] = { ...store.rows[0]!, operation_token: 'tok' } // the person pressed Verify meanwhile
      return answer(cmd, args)
    })
    await expect(pollPrMerges(f.deps, state)).resolves.toBe(0)
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('logs a failed decision and keeps going', async () => {
    store.rows = [row({ id: 'boom' }), row({ id: 'ok', pr_url: 'https://github.com/o/r/pull/2' })]
    const f = deps({ 'o/r#1': 'MERGED', 'o/r#2': 'MERGED' })
    f.execute.mockRejectedValueOnce(new Error('lock lost'))
    await expect(pollPrMerges(f.deps)).resolves.toBe(1)
    expect(f.deps.log).toHaveBeenCalledWith(expect.stringContaining('lock lost'))
  })

  it('watches a multi-repository generation through its repository PRs and settles the generation (no repo lock: it takes its own)', async () => {
    store.rows = [row({ id: 'group', execution_manifest: '{}', pr_url: null })]
    store.children = [
      row({ id: 'c1', parent_delivery_id: 'group', pr_url: 'https://github.com/o/app/pull/875', repository_path: '/repo/app' }),
      row({ id: 'c2', parent_delivery_id: 'group', decision: 'on_review', pr_url: null }),
    ]
    const f = deps({ 'o/app#875': 'MERGED' })
    await expect(pollPrMerges(f.deps)).resolves.toBe(1)
    expect(f.run).toHaveBeenCalledTimes(1)
    expect(f.run.mock.calls[0]![2]).toBe('/repo/app')
    expect(f.execute).toHaveBeenCalledWith(expect.anything(), { prDeliveryId: 'group', action: 'poll-merge', expectedDecision: 'pr_ready' })
    expect(f.lock).not.toHaveBeenCalled()
    // Still open: nothing happens.
    const open = deps({})
    await expect(pollPrMerges(open.deps)).resolves.toBe(0)
    expect(open.execute).not.toHaveBeenCalled()
    store.children = []
  })

  it('never overlaps ticks and stops cleanly', async () => {
    store.rows = [row({ id: 'merged' })]
    const f = deps({ 'o/r#1': 'MERGED' })
    const watch = startPrMergeWatch({ ...f.deps, intervalMs: 60_000 })
    const [a, b] = [watch.tick(), watch.tick()]
    expect(a).toBe(b)
    await a
    watch.stop()
    await expect(watch.tick()).resolves.toBe(0)
  })
})
