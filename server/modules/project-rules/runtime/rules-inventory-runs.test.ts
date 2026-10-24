import { describe, expect, it, vi } from 'vitest'
import { createRulesInventoryRuns } from './rules-inventory-runs'
import type { readProjectRules } from './rules-store'

const project = { id: 'p1', slug: 'rules', path: '/repo' }
const ok = { ok: true, exitCode: 0, output: 'done' }
const inventory = (status: string | null) => ({
  state: 'ok' as const, file: '/repo/.specrails/rules.json', modifiedAt: null,
  inventory: { generatedAt: null, gates: [], rules: [], counts: {}, dropped: 0, classification: status ? { status, provider: null, model: null, reason: null, classifiedAt: null } : null },
}) as unknown as ReturnType<typeof readProjectRules>

describe('rules inventory runs', () => {
  it('runs once after setup, records the run and never repeats it in this process', async () => {
    const run = vi.fn(async () => ok)
    const runs = createRulesInventoryRuns({ run, read: () => ({ state: 'missing' }), now: () => 't1' })
    await expect(runs.runAfterSetup(project, async () => true)).resolves.toBe('ran')
    expect(run).toHaveBeenCalledWith(project)
    expect(runs.lastRun('p1')).toEqual({ trigger: 'setup', ok: true, exitCode: 0, output: null, at: 't1' })
    await expect(runs.runAfterSetup(project, async () => true)).resolves.toBe('already_ran')
    expect(run).toHaveBeenCalledTimes(1)
    // A manual re-run is always allowed.
    await expect(runs.run(project, 'manual')).resolves.toEqual(ok)
    expect(runs.lastRun('p1')?.trigger).toBe('manual')
  })

  it('is gated on the Core capability and skips an inventory that is already classified', async () => {
    const run = vi.fn(async () => ok)
    const unsupported = createRulesInventoryRuns({ run, read: () => ({ state: 'missing' }) })
    await expect(unsupported.runAfterSetup(project, async () => false)).resolves.toBe('unsupported')
    const classified = createRulesInventoryRuns({ run, read: () => inventory('classified') })
    await expect(classified.runAfterSetup(project, async () => true)).resolves.toBe('up_to_date')
    expect(run).not.toHaveBeenCalled()
    // `init` writes an offline inventory: the after-setup run classifies it.
    const offline = createRulesInventoryRuns({ run, read: () => inventory('offline') })
    await expect(offline.runAfterSetup(project, async () => true)).resolves.toBe('ran')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('never overlaps a run in flight and keeps a failure for the panel without throwing', async () => {
    let release!: () => void
    const warn = vi.fn()
    const runs = createRulesInventoryRuns({ run: () => new Promise((resolve) => { release = () => resolve({ ok: false, exitCode: 3, output: 'x'.repeat(5000) }) }), read: () => ({ state: 'missing' }), log: { warn } })
    const manual = runs.run(project, 'manual')
    expect(runs.isRunning('p1')).toBe(true)
    await expect(runs.runAfterSetup(project, async () => true)).resolves.toBe('running')
    await expect(runs.run(project, 'manual')).resolves.toBeNull()
    release()
    await manual
    expect(runs.isRunning('p1')).toBe(false)
    expect(runs.lastRun('p1')).toMatchObject({ ok: false, exitCode: 3 })
    expect(runs.lastRun('p1')!.output!.length).toBe(2000)
    // The after-setup run had not happened: it still may.
    const failing = createRulesInventoryRuns({ run: async () => { throw new Error('Core is unavailable') }, read: () => ({ state: 'missing' }), log: { warn } })
    await expect(failing.runAfterSetup(project, async () => true)).resolves.toBe('failed')
    expect(failing.lastRun('p1')).toMatchObject({ trigger: 'setup', ok: false, output: 'Core is unavailable' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('after setup failed for p1'))
    const broken = createRulesInventoryRuns({ run: async () => ok, read: () => ({ state: 'missing' }), log: { warn } })
    await expect(broken.runAfterSetup(project, async () => { throw new Error('probe failed') })).resolves.toBe('failed')
    runs.forget('p1')
    expect(runs.lastRun('p1')).toBeNull()
  })
})
