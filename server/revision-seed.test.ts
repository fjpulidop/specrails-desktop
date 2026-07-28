import { describe, it, expect } from 'vitest'
import { SEED_DIFF_CAP, SEED_SPEC_BODY_CAP, buildRevisionSeed, type RevisionSeedInput } from './revision-seed'
import type { DeliverySettleEvidence } from './delivery-evidence'

function seed(over: Partial<RevisionSeedInput> = {}): string {
  return buildRevisionSeed({
    note: 'make the login button blue',
    specSnapshot: [{ ticketId: 1, title: 'Add login', description: 'Nobody can log in.\n\nAdd a form.', labels: ['auth'] }],
    ticketIds: [1],
    branches: ['feat/1-add-login'],
    baseBranch: 'main',
    branchDiffSummary: 'M\tsrc/auth.ts\nA\tsrc/auth.test.ts',
    evidence: null,
    revisionNumber: 1,
    ...over,
  })
}

function evidence(over: Partial<DeliverySettleEvidence['units'][number]> = {}): DeliverySettleEvidence {
  return {
    schemaVersion: 1, harvest: 'ok', harvestedAt: 'now',
    units: [{
      ticketId: 1, runId: 'run-1', sentinel: 'pass', sentinelDetail: null,
      verifyTail: null, confidence: null, ...over,
    }],
  }
}

describe('buildRevisionSeed', () => {
  it('leads with the instruction and forbids starting over', () => {
    const text = seed()
    expect(text).toContain('make the login button blue')
    expect(text).toContain('ALREADY been delivered')
    expect(text).toMatch(/Do NOT start over/i)
  })

  it('carries the FROZEN spec text, not a live re-read', () => {
    const text = seed()
    expect(text).toContain('#1 Add login')
    expect(text).toContain('Nobody can log in.')
    expect(text).toContain('frozen at launch')
  })

  it('points at the branch that carries the work', () => {
    const text = seed()
    expect(text).toContain('feat/1-add-login')
    expect(text).toContain('based on main')
    expect(text).toContain('M\tsrc/auth.ts')
  })

  it('degrades honestly when the launch captured no spec text', () => {
    const text = seed({ specSnapshot: null, ticketIds: [7, 8] })
    expect(text).toContain('#7')
    expect(text).toContain('#8')
    expect(text).toContain('spec text was not captured at launch')
  })

  it('degrades honestly when there is no diff summary', () => {
    const text = seed({ branchDiffSummary: null })
    expect(text).not.toContain('Already changed on that branch')
    expect(text).toContain('feat/1-add-login')
  })

  it('falls back to naming the base branch when no branch was recorded', () => {
    const text = seed({ branches: [], branchDiffSummary: null })
    expect(text).toContain('Base branch: main')
  })

  it('keeps its sections readable (blank-line separated, not a wall of text)', () => {
    expect(seed()).toContain('\n\n## What the user asked to change\n\n')
  })

  it('states plainly when no verification evidence exists', () => {
    expect(seed()).toContain('No verification evidence was captured')
  })

  it('reports a previous PASS as a report, not as a fact', () => {
    const text = seed({ evidence: evidence() })
    expect(text).toContain('reported its verification passed')
  })

  it('leads with a previous FAILURE and carries its reason', () => {
    const text = seed({ evidence: evidence({ sentinel: 'fail', sentinelDetail: 'typecheck broke' }) })
    const failIndex = text.indexOf('REPORTED FAILED')
    expect(failIndex).toBeGreaterThan(-1)
    expect(text).toContain('typecheck broke')
  })

  it('mentions a FAILURE before a PASS when a batch reported both', () => {
    const text = buildRevisionSeed({
      note: 'x', specSnapshot: null, ticketIds: [1, 2], branches: [], baseBranch: 'main',
      branchDiffSummary: null, revisionNumber: 1,
      evidence: {
        schemaVersion: 1, harvest: 'ok', harvestedAt: 'now',
        units: [
          { ticketId: 1, runId: 'r1', sentinel: 'pass', sentinelDetail: null, verifyTail: null, confidence: null },
          { ticketId: 2, runId: 'r2', sentinel: 'fail', sentinelDetail: 'lint', verifyTail: null, confidence: null },
        ],
      },
    })
    expect(text.indexOf('REPORTED FAILED')).toBeLessThan(text.indexOf('reported its verification passed'))
  })

  it('includes the reviewer score when one was captured', () => {
    const text = seed({
      evidence: evidence({ confidence: { changeName: 'c', overall: 72, aspects: {}, flags: [], raw: null } }),
    })
    expect(text).toContain('72/100')
  })

  it('says the previous run gave no verdict when the sentinel was absent', () => {
    expect(seed({ evidence: evidence({ sentinel: 'absent' }) })).toContain('did not report a verification verdict')
  })

  it('numbers the revision so the run knows it is not the first', () => {
    expect(seed({ revisionNumber: 3 })).toContain('revision 3')
  })

  it('bounds an overlong spec body and diff', () => {
    const text = seed({
      specSnapshot: [{ ticketId: 1, title: 't', description: 'x'.repeat(SEED_SPEC_BODY_CAP * 3), labels: [] }],
      branchDiffSummary: 'y'.repeat(SEED_DIFF_CAP * 3),
    })
    expect(text).toContain('…(truncated)')
    expect(text.length).toBeLessThan(SEED_SPEC_BODY_CAP + SEED_DIFF_CAP + 3000)
  })

  it('is deterministic for the same input', () => {
    expect(seed()).toBe(seed())
  })
})
