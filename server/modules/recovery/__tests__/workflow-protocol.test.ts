import { describe, expect, it } from 'vitest'
import { deriveFailureDiagnosis, parseStoredDiagnosis, presentFailureDiagnosis, rankRemedies, serializeDiagnosis, strongerModelFor } from '../domain'
import { claudeAdapter, codexAdapter } from '../../../providers'

const catalog = (provider: string) => provider === 'claude' ? claudeAdapter.modelCatalog() : provider === 'codex' ? codexAdapter.modelCatalog() : null
// The step error a benchmark run (claude/haiku, contradictory spec) ended with on a Core before contract 5.16.
const LEGACY = 'Required OpenSpec role workflow was not executed: plan must execute openspec-ff-change (missing instructions tasks)'

describe('workflow protocol diagnosis (Core contract 5.16)', () => {
  const core = { kind: 'workflow_protocol', confidence: 'high', phase: 'architect', resumablePhase: 'architect', role: 'plan', provider: 'claude', model: 'haiku', missingSteps: ['instructions tasks'],
    detail: 'The plan model (claude/haiku) skipped the required OpenSpec steps (instructions tasks) even after a corrective reminder.' }

  it('keeps Core\'s record, continues from the step and suggests the provider\'s default model for a small one', () => {
    const diagnosis = deriveFailureDiagnosis({ outcome: 'failed', core, stepId: 'architect' })
    expect(diagnosis).toMatchObject({ kind: 'workflow_protocol', confidence: 'high', source: 'core', role: 'plan', provider: 'claude', model: 'haiku', missingSteps: ['instructions tasks'] })
    expect(rankRemedies(diagnosis)).toEqual(['continue', 'open-logs', 'retry'])
    expect(presentFailureDiagnosis(diagnosis, catalog)).toMatchObject({ remedies: ['continue', 'open-logs', 'retry'], strongerModel: { provider: 'claude', model: 'sonnet', label: 'Claude Sonnet 5.5' } })
    // The stored record keeps the fields a later read presents.
    expect(parseStoredDiagnosis(serializeDiagnosis(diagnosis))).toMatchObject({ role: 'plan', model: 'haiku', missingSteps: ['instructions tasks'] })
  })

  it('diagnoses an older Core\'s fixed sentence instead of an unknown cause', () => {
    const diagnosis = deriveFailureDiagnosis({ outcome: 'failed', core: { kind: 'unknown', confidence: 'low', phase: 'architect' }, errorText: LEGACY, stepId: 'architect' })
    expect(diagnosis).toMatchObject({ kind: 'workflow_protocol', confidence: 'high', source: 'desktop', role: 'plan', missingSteps: ['instructions tasks'], resumablePhase: 'architect' })
    expect(presentFailureDiagnosis(diagnosis, catalog).strongerModel).toBeNull()
  })

  it('suggests a stronger model only when the catalog marks the model that ran as small', () => {
    expect(strongerModelFor('claude', 'haiku', catalog)).toEqual({ provider: 'claude', model: 'sonnet', label: 'Claude Sonnet 5.5' })
    expect(strongerModelFor('claude', 'claude-haiku-5-5', catalog)).toMatchObject({ model: 'sonnet' })
    expect(strongerModelFor('codex', 'gpt-6-luna', catalog)).toEqual({ provider: 'codex', model: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' })
    for (const [provider, model] of [['claude', 'opus'], ['claude', 'sonnet'], ['codex', 'gpt-6.1-terra'], ['local', 'qwen'], ['claude', null]] as const)
      expect(strongerModelFor(provider, model, catalog), `${provider}/${model}`).toBeNull()
  })
})
