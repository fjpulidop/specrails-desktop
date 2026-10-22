import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { DefinitionRunProbe } from '../../loops/runtime/loop-definition-recovery'
import { harvestDeliveryEvidence, parseDerivation, projectDefinitionRuntimeEvidence, type DeliverySettleEvidence } from './delivery-evidence'
import { buildCanonicalPrBody, buildDerivationLine } from './pr-body'
import { packetDerivation } from './review-packet'

const report = {
  schemaVersion: 1, change: 'kanban-board', base: 'b'.repeat(40), head: 'c'.repeat(40), files: 5, explained: 4,
  unexplainedFiles: ['src/extra.ts'], tasks: 3, requirementsAdded: 2, requirementsModified: 1, confidence: 'high', transcriptTurnsUsed: 4, repositories: [],
}
function probe(scopes: NonNullable<DefinitionRunProbe['scopes']>): DefinitionRunProbe {
  return { runId: 'run-1', engineVersion: 2, status: 'succeeded', resumable: false, lease: null, recoverableSteps: [], pendingInterrupts: [], completion: null, scopes, coreRevision: 1, eventCursor: 1, probedAt: 't' }
}
const derive = (output: unknown, attemptId = 'a1') => ({ nodePath: 'derive', scopeId: 'root', kind: 'derive-change', status: 'succeeded', attemptId, output })

describe('derivation evidence', () => {
  it('projects the latest derive-change attempt from runtime status', () => {
    const rejected = { ...report, explained: 1, unexplainedFiles: ['a', 'b', 'c', 'd'] }
    const evidence = projectDefinitionRuntimeEvidence(probe([{ ...derive({ derivation: rejected }), status: 'failed' }, derive({ derivation: report, derivationPath: '/x' }, 'a2')]))
    expect(evidence?.derivation).toEqual({ change: 'kanban-board', files: 5, explained: 4, unexplainedFiles: ['src/extra.ts'], unexplainedOmitted: 0, confidence: 'high', requirementsAdded: 2, requirementsModified: 1, tasks: 3, transcriptTurnsUsed: 4 })
    expect(evidence).not.toHaveProperty('derivationPath')
  })

  it('bounds the unexplained list and tolerates malformed reports', () => {
    const many = parseDerivation({ ...report, files: 500, explained: 900, unexplainedFiles: Array.from({ length: 250 }, (_, i) => `f${i}`), unexplainedOmitted: 10, confidence: 'certain' })
    expect(many).toMatchObject({ explained: 500, unexplainedOmitted: 60, confidence: null })
    expect(many!.unexplainedFiles).toHaveLength(200)
    expect(parseDerivation({ change: 'x' })).toBeNull()
    expect(parseDerivation('nope')).toBeNull()
  })

  it('reads derivation.json from the node output path when the inline copy is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'derivation-'))
    const file = join(dir, 'derivation.json')
    writeFileSync(file, JSON.stringify(report))
    const harvested = harvestDeliveryEvidence({ readEvents: () => [] }, [{ ticketId: 7, runId: 'run-1', worktreePath: null, definitionStatus: probe([derive({ derivationPath: file })]) }])
    expect(harvested.units[0]!.runtime?.derivation).toMatchObject({ explained: 4, files: 5 })
    const missing = harvestDeliveryEvidence({ readEvents: () => [] }, [{ ticketId: 7, runId: 'run-1', worktreePath: null, definitionStatus: probe([derive({ derivationPath: join(dir, 'gone.json') })]) }])
    expect(missing.units[0]!.runtime?.derivation ?? null).toBeNull()
  })
})

describe('packet and PR body derivation', () => {
  const evidence = (derivation: unknown): DeliverySettleEvidence => ({ schemaVersion: 1, harvest: 'ok', harvestedAt: 't', units: [{ ticketId: 7, runId: 'r', sentinel: 'absent', sentinelDetail: null, verifyTail: null, confidence: null, runtime: { commands: [], checks: [], findings: [], review: null, ...(derivation ? { derivation: parseDerivation(derivation) } : {}) } }] })

  it('renders full coverage, unexplained files, and an unavailable report only for Flow deliveries', () => {
    expect(packetDerivation({ loop_id: 'factory:flow-spec' }, evidence({ ...report, explained: 5, unexplainedFiles: [] }))).toMatchObject({ status: 'available', explained: 5, files: 5, unexplainedFiles: [] })
    expect(packetDerivation({ loop_id: 'factory:flow-spec' }, evidence(report))).toMatchObject({ status: 'available', unexplainedFiles: ['src/extra.ts'] })
    expect(packetDerivation({ loop_id: 'factory:flow-spec' }, evidence(null))).toEqual({ status: 'unavailable' })
    expect(packetDerivation({ loop_id: 'factory:flow-spec' }, null)).toEqual({ status: 'unavailable' })
    expect(packetDerivation({ loop_id: 'factory:implement' }, evidence(null))).toBeNull()
  })

  it('adds one short derivation line to the PR body', () => {
    const derivation = parseDerivation(report)!
    expect(buildDerivationLine(derivation)).toBe('> Derived from a Flow session: OpenSpec change `kanban-board`, 4/5 changed files explained by its design (1 unexplained — see the review packet).')
    expect(buildDerivationLine({ ...derivation, explained: 5, unexplainedFiles: [] })).toBe('> Derived from a Flow session: OpenSpec change `kanban-board`, 5/5 changed files explained by its design.')
    const body = buildCanonicalPrBody({ loopName: 'Flow → Spec', baseBranch: 'main', tickets: [{ ticketId: 7, title: 'Kanban', description: null, branch: null }] as never, derivation })
    expect(body).toContain('> Derived from a Flow session')
    expect(buildCanonicalPrBody({ loopName: 'Implement', baseBranch: 'main', tickets: [{ ticketId: 7, title: 'K', description: null, branch: null }] as never })).not.toContain('Derived from a Flow session')
  })
})
