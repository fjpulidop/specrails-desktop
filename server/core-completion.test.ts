import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCoreCompletion, readCoreCompletion } from './core-completion'
vi.mock('./path-resolver', () => ({ resolveBundledNodeExe: () => process.execPath }))
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
const valid = {
  schemaVersion: 1, runId: 'run', change: 'visual-style',
  completion: { implementation: 'complete', validation: 'with-exceptions', archive: 'done', delivery: 'pending-host', reasons: [] },
  phases: { reviewer: { status: 'done', durationMs: 1200, attempts: 2 } }, verification: { valid: true },
  acceptance: { valid: true, receipt: {
    criteria: [{ requirement: 'Hold HUD', status: 'exception', exception: { reason: 'No hold mechanic', impact: 'Use next preview', acceptedBy: 'user', approvalEvidence: 'Ticket decision' } }],
    checks: [{ name: 'Browser', status: 'unavailable', required: false, scope: 'Real frames', limitations: 'Not measured by Node benchmark', evidence: ['browser.log'] }], findings: ['HUD legible in peak captures'],
  } },
}
describe('runtime completion bridge', () => {
  it('preserves exception decisions, measurement limitations and nullable phase metrics', () => {
    const result = parseCoreCompletion(valid, 'run')!
    expect(result.completion.validation).toBe('with-exceptions')
    expect(result.exceptions[0]).toMatchObject({ acceptedBy: 'user', approvalEvidence: 'Ticket decision' })
    expect(result.checks[0]?.limitations).toContain('Node')
    expect(result.phases[0]).toMatchObject({ durationMs: 1200, attempts: 2 })
    expect(parseCoreCompletion({ ...valid, phases: { reviewer: { status: 'done' } } }, 'run')?.phases[0]?.durationMs).toBeNull()
  })
  it.each([
    { ...valid, runId: 'different' }, { ...valid, completion: undefined },
    { ...valid, verification: { valid: false } }, { ...valid, acceptance: { valid: false } },
    { ...valid, completion: { ...valid.completion, validation: 'invented' } },
  ])('rejects old, malformed, stale or mismatched status %#', input => {
    expect(parseCoreCompletion(input, 'run')).toBeNull()
  })
  it('executes the installed runtime for the exact context instead of reading agent text', async () => {
    const root = mkdtempSync(join(tmpdir(), 'core-completion-')); roots.push(root)
    mkdirSync(join(root, '.specrails/runtime'), { recursive: true })
    writeFileSync(join(root, '.specrails/runtime/pipeline.mjs'), `if(process.argv[2] !== 'status' || process.argv[4] !== '/context.json') process.exit(1); process.stdout.write(${JSON.stringify(JSON.stringify(valid))})`)
    expect((await readCoreCompletion({ cwd: root, contextPath: '/context.json', runId: 'run', env: process.env }))?.completion.delivery).toBe('pending-host')
    expect(await readCoreCompletion({ cwd: root, contextPath: '/wrong.json', runId: 'run', env: process.env })).toBeNull()
  })
})
