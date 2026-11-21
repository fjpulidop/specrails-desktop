import { describe, expect, it } from 'vitest'
import { continuationGuidance, failureEvidence, needsEnvFiles, presentFailureDiagnosis, type FailureDiagnosis } from '..'

const base: FailureDiagnosis = { kind: 'environment', confidence: 'high', phase: 'baseline', rounds: null, resetAt: null, detail: null, resumablePhase: null, blocker: null, source: 'core' }
const blocker = (reason: string, requiredAction: string) => ({ kind: 'environment', reason, command: 'php', args: ['artisan', 'test'], cwd: '.', requiredAction })

describe('environment-file blocker remedy', () => {
  it('recognises a missing .env / APP_KEY host blocker, and nothing else', () => {
    expect(needsEnvFiles({ ...base, blocker: blocker('No application encryption key has been specified.', 'cp .env.example .env in this worktree') })).toBe(true)
    expect(needsEnvFiles({ ...base, detail: 'Tests need APP_KEY' })).toBe(true)
    expect(needsEnvFiles({ ...base, blocker: blocker('The .env.testing file is missing', 'create it') })).toBe(true)
    expect(needsEnvFiles({ ...base, blocker: blocker('dotnet is not installed', 'install the .NET SDK') })).toBe(false)
    expect(needsEnvFiles({ ...base, detail: 'Edit server/environment.ts' })).toBe(false)
    expect(needsEnvFiles({ ...base, kind: 'tests_failed', detail: 'APP_KEY' })).toBe(false)
    expect(needsEnvFiles({ ...base, confidence: 'low', detail: 'APP_KEY' })).toBe(false)
  })

  it('offers "copy-env-files" first only while the project setting is off', () => {
    const diagnosis = { ...base, detail: 'Tests need APP_KEY' }
    expect(presentFailureDiagnosis(diagnosis, undefined, { envFilesEnabled: false }).remedies).toEqual(['copy-env-files', 'continue', 'fix-environment', 'open-logs', 'retry'])
    expect(presentFailureDiagnosis(diagnosis, undefined, { envFilesEnabled: true }).remedies).not.toContain('copy-env-files')
    expect(presentFailureDiagnosis(diagnosis).remedies).not.toContain('copy-env-files')
    expect(presentFailureDiagnosis({ ...base, detail: 'dotnet missing' }, undefined, { envFilesEnabled: false }).remedies).not.toContain('copy-env-files')
  })

  it('the continuation guidance names the copied files, never their values', () => {
    const text = continuationGuidance({ ...base, blocker: blocker('APP_KEY missing', 'cp .env.example .env') }, { envFilesCopied: ['.env', '.env.testing'] })!
    expect(text).toContain('copied the project\'s environment files into this worktree: .env, .env.testing')
    expect(text).toMatch(/never print their values, and never commit them/)
    expect(continuationGuidance({ ...base, blocker: blocker('APP_KEY missing', 'cp .env.example .env') })).not.toContain('copied the project')
  })
})

describe('failure analysis upload', () => {
  it('redacts every line before it can reach the provider', () => {
    const events = [{ event_type: 'log', payload: JSON.stringify({ line: 'APP_KEY=base64:FAKEFAKEFAKEFAKE= loaded' }) }]
    const evidence = failureEvidence({ job: { command: 'x', status: 'failed', provider: null, model: null }, diagnosis: null, events, redact: (line) => line.split('base64:FAKEFAKEFAKEFAKE=').join('[redacted]') })
    expect(evidence.lines.join('\n')).not.toContain('FAKEFAKE')
    expect(evidence.lines.join('\n')).toContain('[redacted]')
  })
})
