import { describe, expect, it, vi } from 'vitest'
import { createProjectSettingsService, SettingsValidationError, type ProjectSettings, type ProjectSettingsRepository } from '..'

const initial: ProjectSettings = {
  pipelineTelemetryEnabled: true, orchestratorModel: 'sonnet', orchestratorModelExplicit: false,
  prePrompt: '', freestylePrePrompt: '', integrationBranch: '', worktreeEnvPassthrough: [], allowSubagents: false, subagentRuntime: null, reviewerFamilySuggestionDismissed: false,
  reviewWipLimit: null,
  agentEnvMode: 'inherit',
  agentAuditRetentionDays: 30,
}
function setup() {
  const repository: ProjectSettingsRepository = {
    read: vi.fn(() => initial),
    update: vi.fn(patch => ({ ...initial, ...patch })),
  }
  return { repository, service: createProjectSettingsService(repository) }
}

describe('project settings use cases (no database or HTTP)', () => {
  it('reads through its project-bound port', () => {
    const { service, repository } = setup()
    expect(service.getSettings()).toEqual(initial)
    expect(repository.read).toHaveBeenCalledOnce()
  })

  it('normalizes names and excludes unknown and read-only fields from writes', () => {
    const { service, repository } = setup()
    service.updateSettings({ worktreeEnvPassthrough: [' TOKEN ', 'TOKEN', ''], prePrompt: 'hello',
      orchestratorModelExplicit: true, other: 'ignored' })
    expect(repository.update).toHaveBeenCalledExactlyOnceWith({ worktreeEnvPassthrough: ['TOKEN'], prePrompt: 'hello' })
  })

  it.each([
    [{ orchestratorModel: 'invalid' }, 'orchestratorModel'],
    [{ prePrompt: 7 }, 'prePrompt must be a string'],
    [{ freestylePrePrompt: false }, 'freestylePrePrompt must be a string'],
    [{ worktreeEnvPassthrough: 'TOKEN' }, 'must be an array'],
    [{ worktreeEnvPassthrough: [7] }, 'entries must be strings'],
    [{ worktreeEnvPassthrough: ['TOKEN=secret'] }, 'invalid environment variable name'],
    [{ worktreeEnvPassthrough: ['A'.repeat(129)] }, 'too long'],
    [{ worktreeEnvPassthrough: Array.from({ length: 65 }, (_, i) => `VAR_${i}`) }, 'at most 64'],
    [{ integrationBranch: 7 }, 'integrationBranch must be a string'],
    [{ integrationBranch: '--upload-pack=x' }, 'not a valid branch name'],
  ])('validates the whole patch before any write: %j', (invalid, message) => {
    const { service, repository } = setup()
    const action = () => service.updateSettings({ pipelineTelemetryEnabled: false, ...invalid })
    expect(action).toThrow(SettingsValidationError)
    expect(action).toThrow(message)
    expect(repository.update).not.toHaveBeenCalled()
  })

  it('preserves empty patches, legacy boolean coercion and empty branch clearing', () => {
    const { service, repository } = setup()
    service.updateSettings(undefined)
    expect(repository.update).toHaveBeenLastCalledWith({})
    service.updateSettings({ pipelineTelemetryEnabled: 0, integrationBranch: ' ', orchestratorModel: 'opus' })
    expect(repository.update).toHaveBeenLastCalledWith({ pipelineTelemetryEnabled: false, integrationBranch: ' ', orchestratorModel: 'opus' })
  })

  it('returns persisted normalization rather than echoing raw input', () => {
    const repository: ProjectSettingsRepository = { read: () => initial, update: () => ({ ...initial, integrationBranch: 'main' }) }
    expect(createProjectSettingsService(repository).updateSettings({ integrationBranch: ' main ' }).integrationBranch).toBe('main')
  })

  it('does not misclassify persistence errors as input errors', () => {
    const failure = new Error('disk full')
    const repository: ProjectSettingsRepository = { read: () => initial, update: () => { throw failure } }
    expect(() => createProjectSettingsService(repository).updateSettings({})).toThrow(failure)
  })
})

describe('allowSubagents', () => {
  it('accepts booleans only and passes them through', () => {
    const { service, repository } = setup()
    service.updateSettings({ allowSubagents: true })
    expect(repository.update).toHaveBeenCalledExactlyOnceWith({ allowSubagents: true })
    expect(() => service.updateSettings({ allowSubagents: 'yes' })).toThrow(SettingsValidationError)
    expect(() => service.updateSettings({ allowSubagents: 1 })).toThrow('allowSubagents must be a boolean')
  })
})

describe('subagentRuntime', () => {
  it('validates the provider, model and effort, and accepts null to clear', () => {
    const { service, repository } = setup()
    service.updateSettings({ subagentRuntime: { provider: 'claude', model: ' sonnet ', effort: null } })
    expect(repository.update).toHaveBeenLastCalledWith({ subagentRuntime: { provider: 'claude', model: 'sonnet', effort: null } })
    service.updateSettings({ subagentRuntime: null })
    expect(repository.update).toHaveBeenLastCalledWith({ subagentRuntime: null })
    for (const bad of [{ provider: 'Claude!', model: 'x' }, { provider: 'claude', model: '' }, { provider: 'claude', model: 'x', effort: 5 }, 'claude']) {
      expect(() => service.updateSettings({ subagentRuntime: bad })).toThrow(SettingsValidationError)
    }
  })
})


describe('reviewerFamilySuggestionDismissed', () => {
  it('accepts booleans only and passes them through', () => {
    const { service, repository } = setup()
    service.updateSettings({ reviewerFamilySuggestionDismissed: true })
    expect(repository.update).toHaveBeenCalledExactlyOnceWith({ reviewerFamilySuggestionDismissed: true })
    expect(() => service.updateSettings({ reviewerFamilySuggestionDismissed: 'true' })).toThrow('reviewerFamilySuggestionDismissed must be a boolean')
  })
})

describe('reviewWipLimit', () => {
  it('accepts an integer from 1 to 100 or null, and rejects anything else before writing', () => {
    const { service, repository } = setup()
    service.updateSettings({ reviewWipLimit: 5 })
    expect(repository.update).toHaveBeenLastCalledWith({ reviewWipLimit: 5 })
    service.updateSettings({ reviewWipLimit: null })
    expect(repository.update).toHaveBeenLastCalledWith({ reviewWipLimit: null })
    for (const bad of [0, -2, 2.5, 101, '5', true, Number.NaN]) {
      expect(() => service.updateSettings({ reviewWipLimit: bad })).toThrow(SettingsValidationError)
    }
    expect(repository.update).toHaveBeenCalledTimes(2)
  })
})

describe('agentEnvMode', () => {
  it('accepts inherit and minimal and rejects anything else before writing', () => {
    const { service, repository } = setup()
    service.updateSettings({ agentEnvMode: 'minimal' })
    expect(repository.update).toHaveBeenLastCalledWith({ agentEnvMode: 'minimal' })
    service.updateSettings({ agentEnvMode: 'inherit' })
    expect(repository.update).toHaveBeenLastCalledWith({ agentEnvMode: 'inherit' })
    vi.mocked(repository.update).mockClear()
    for (const bad of ['strict', '', null, true, 1]) {
      expect(() => service.updateSettings({ agentEnvMode: bad })).toThrow(SettingsValidationError)
    }
    expect(repository.update).not.toHaveBeenCalled()
  })
})

describe('agentAuditRetentionDays', () => {
  it('accepts whole days within 1-3650 and rejects anything else before writing', () => {
    const { service, repository } = setup()
    service.updateSettings({ agentAuditRetentionDays: 90 })
    expect(repository.update).toHaveBeenCalledExactlyOnceWith({ agentAuditRetentionDays: 90 })
    for (const value of [0, -1, 3651, 1.5, '30', null]) {
      expect(() => service.updateSettings({ agentAuditRetentionDays: value })).toThrow(SettingsValidationError)
    }
    expect(repository.update).toHaveBeenCalledOnce()
  })
})
