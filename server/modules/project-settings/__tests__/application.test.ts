import { describe, expect, it, vi } from 'vitest'
import { createProjectSettingsService, SettingsValidationError, type ProjectSettings, type ProjectSettingsRepository } from '..'

const initial: ProjectSettings = {
  pipelineTelemetryEnabled: true, orchestratorModel: 'sonnet', orchestratorModelExplicit: false,
  prePrompt: '', freestylePrePrompt: '', integrationBranch: '', worktreeEnvPassthrough: [],
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
