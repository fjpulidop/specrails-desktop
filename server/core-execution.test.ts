import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { checkCoreCompletion, coreVerificationContext, prepareCoreExecution } from './core-execution'
import type { RunExecutionManifest } from './multi-repo-execution-store'

vi.mock('./path-resolver', () => ({ resolveBundledNodeExe: () => process.execPath }))
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = realpathSync(mkdtempSync(join(os.tmpdir(), 'core-execution-'))); roots.push(root)
  const cwd = join(root, 'workspace'); const front = join(root, 'front'); const back = join(root, 'back')
  for (const dir of [cwd, front, back]) mkdirSync(dir)
  return { root, cwd, front, back }
}
function manifest(front: string, back: string): RunExecutionManifest {
  return { version: 1, groupId: 'group', projectId: 'project', primaryRepositoryId: 'front', artifactRepositoryId: 'back', selectedRepositoryIds: ['front', 'back'], repositories: [front, back].map((folder, i) => ({
    repositoryId: i ? 'back' : 'front', name: i ? 'Backend' : 'Frontend', sourcePath: folder + '-original', gitCommonDir: folder + '/.git', baseBranch: 'main', baseSha: 'a'.repeat(40), worktreePath: folder, branch: 'feature', worktreeId: 'tree-' + i,
  })) }
}
describe('Core execution context', () => {
  it('uses the registered primary identity for a project run without an explicit repository selector', () => {
    const { cwd, front } = fixture()
    const input = { cwd, repoDir: front, env: {}, run: { runId: 'factory-primary', projectId: 'project-123', spec: { id: 7, description: 'Ordinary single-repository factory run' } } }
    const prepared = prepareCoreExecution(input)
    const context = JSON.parse(readFileSync(prepared.contextPath, 'utf8'))
    expect(context).toMatchObject({ artifactRepositoryId: 'primary-project-123', repositories: [{ id: 'primary-project-123', path: front }] })
    expect(prepareCoreExecution(input).contextPath).toBe(prepared.contextPath)
  })
  it('keeps explicit selected and frozen spec identities ahead of the project primary fallback', () => {
    const { cwd, front } = fixture()
    const explicit = prepareCoreExecution({ cwd, repoDir: front, env: {}, run: { runId: 'explicit-repository', projectId: 'project-123', repositoryId: 'secondary' } })
    const frozen = prepareCoreExecution({ cwd, repoDir: front, env: {}, run: { runId: 'frozen-repository', projectId: 'project-123', spec: { id: 7, repositoryIds: ['secondary'] } } })
    expect(JSON.parse(readFileSync(explicit.contextPath, 'utf8')).artifactRepositoryId).toBe('secondary')
    expect(JSON.parse(readFileSync(frozen.contextPath, 'utf8')).artifactRepositoryId).toBe('secondary')
  })
  it('freezes shared backlog and selected worktrees independently from the artifact repository', () => {
    const { cwd, front, back } = fixture()
    const result = prepareCoreExecution({ cwd, repoDir: front, manifest: manifest(front, back), env: { SPECRAILS_GIT_AUTO: 'false', SPECRAILS_TICKETS_PATH: join(cwd, '.specrails', 'local-tickets.json') }, run: { runId: 'run-1', spec: { id: 7, title: 'Shared API', description: 'Implement and verify front and back', repositoryIds: ['front', 'back'] } } })
    const context = JSON.parse(readFileSync(result.contextPath, 'utf8'))
    expect(context).toMatchObject({ runId: 'run-1', backlogRoot: cwd, artifactRoot: back, artifactRepositoryId: 'back', ownership: { git: 'host', worktrees: 'host', backlog: 'host' }, specs: [{ id: 7, description: 'Implement and verify front and back', repositoryIds: ['front', 'back'] }] })
    expect(context.repositories.map((repo: { path: string }) => repo.path)).toEqual([front, back])
    expect(result.env.SPECRAILS_EXECUTION_CONTEXT).toBe(result.contextPath)
  })
  it('reuses identical input and rejects changed spec or repository scope for an existing run', () => {
    const { cwd, front } = fixture()
    const input = { cwd, repoDir: front, env: {}, run: { runId: 'run-1', spec: { id: 1, description: 'original' } } }
    const before = prepareCoreExecution(input)
    expect(prepareCoreExecution(input).contextPath).toBe(before.contextPath)
    expect(() => prepareCoreExecution({ ...input, run: { ...input.run, spec: { id: 1, description: 'changed' } } })).toThrow('context changed')
    expect(JSON.parse(readFileSync(before.contextPath, 'utf8')).specs[0].description).toBe('original')
  })
  it('isolates simultaneous runs and preserves every batch description', () => {
    const { cwd, front } = fixture()
    const input = { cwd, repoDir: front, env: {}, run: { runId: 'one', spec: { tickets: [{ id: 1, description: 'first' }, { id: 2, description: 'second' }] } } }
    const first = prepareCoreExecution(input)
    const second = prepareCoreExecution({ ...input, run: { ...input.run, runId: 'two' } })
    expect(first.contextPath).not.toBe(second.contextPath)
    expect(JSON.parse(readFileSync(first.contextPath, 'utf8')).specs.map((spec: { description: string }) => spec.description)).toEqual(['first', 'second'])
  })
  it('keeps the Desktop snapshot independent from the normalized Core journal context', () => {
    const { cwd, front } = fixture()
    const input = { cwd, repoDir: front, env: {}, run: { runId: 'run-1', spec: { id: 1, description: 'original' } } }
    const before = prepareCoreExecution(input)
    const context = JSON.parse(readFileSync(before.contextPath, 'utf8'))
    expect(context.backlogPath).toBe(join(cwd, '.specrails', 'local-tickets.json'))
    expect(before.contextPath).toContain('desktop-context.json')
    writeFileSync(join(cwd, '.specrails', 'pipeline', 'run-1', 'context.json'), JSON.stringify({ ...context, normalized: true }))
    expect(prepareCoreExecution(input).contextPath).toBe(before.contextPath)
    expect(JSON.parse(readFileSync(before.contextPath, 'utf8'))).toEqual(context)
  })
  it('canonicalizes ticket paths through symlinked ancestors before the tickets file exists', () => {
    const { root, cwd, front } = fixture()
    const alias = join(root, 'workspace-alias'); symlinkSync(cwd, alias, 'dir')
    const result = prepareCoreExecution({ cwd, repoDir: front, env: { SPECRAILS_TICKETS_PATH: join(alias, '.specrails', 'local-tickets.json') }, run: { runId: 'alias' } })
    expect(JSON.parse(readFileSync(result.contextPath, 'utf8'))).toMatchObject({ backlogRoot: cwd, backlogPath: join(cwd, '.specrails', 'local-tickets.json') })
  })
  it('rejects invalid identity and out-of-scope frozen specs before model execution', () => {
    const { cwd, front } = fixture()
    expect(() => prepareCoreExecution({ cwd, repoDir: front, env: {}, run: { runId: '../escape' } })).toThrow('run id')
    expect(() => prepareCoreExecution({ cwd, repoDir: front, env: {}, run: { runId: 'valid', repositoryId: 'front', spec: { id: 1, repositoryIds: ['back'] } } })).toThrow('outside the execution scope')
  })
})

describe('Core receipt bridge', () => {
  function writeStatus(cwd: string, status: unknown) {
    const runtime = join(cwd, '.specrails', 'runtime'); mkdirSync(runtime, { recursive: true })
    writeFileSync(join(runtime, 'pipeline.mjs'), `process.stdout.write(${JSON.stringify(JSON.stringify(status))})`)
  }
  const valid = { schemaVersion: 1, runId: 'run', phases: { reviewer: { status: 'done' } }, verification: { valid: true, receipt: { id: 'receipt', kind: 'full', commands: [{ repositoryId: 'front', command: 'npm', args: ['test'], cwd: '/repo', exitCode: 0 }] } } }
  it('offers validated commands with mandatory semantic review and final freshness validation', () => {
    const { cwd } = fixture(); writeStatus(cwd, valid)
    const text = coreVerificationContext('/context.json', cwd, process.env, 'run')
    expect(text).toContain('receipt')
    expect(text).toContain('every acceptance criterion')
    expect(text).toContain('validate again')
  })
  it.each([
    { ...valid, runId: 'another' },
    { ...valid, verification: { ...valid.verification, valid: false } },
    { ...valid, phases: { reviewer: { status: 'running' } } },
    { ...valid, verification: { ...valid.verification, receipt: { ...valid.verification.receipt, kind: 'scoped' } } },
    { ...valid, verification: { ...valid.verification, receipt: { ...valid.verification.receipt, commands: [] } } },
  ])('keeps ordinary verification for incomplete or mismatched evidence %#', (status) => {
    const { cwd } = fixture(); writeStatus(cwd, status)
    expect(coreVerificationContext('/context.json', cwd, process.env, 'run')).toBe('')
  })
})


it('preserves explicit acceptance criteria in single and batch frozen contexts', () => {
  const { cwd, front } = fixture()
  const first = prepareCoreExecution({ cwd, repoDir: front, env: {}, run: { runId: 'criteria-single', spec: { id: 1, description: 'Visuals', acceptanceCriteria: ['Readable at peak'] } } })
  expect(JSON.parse(readFileSync(first.contextPath, 'utf8')).specs[0].acceptanceCriteria).toEqual(['Readable at peak'])
  const batch = prepareCoreExecution({ cwd, repoDir: front, env: {}, run: { runId: 'criteria-batch', spec: { tickets: [{ id: 1, acceptanceCriteria: ['First'] }, { id: 2, acceptanceCriteria: ['Second'] }] } } })
  expect(JSON.parse(readFileSync(batch.contextPath, 'utf8')).specs.map((spec: { acceptanceCriteria: string[] }) => spec.acceptanceCriteria)).toEqual([['First'], ['Second']])
})

describe('Core implementation completion gate', () => {
  const complete = {
    schemaVersion: 1, runId: 'run', resumePhase: 'ship',
    phases: Object.fromEntries(['architect', 'developer', 'reviewer', 'archive'].map(phase => [phase, { status: 'done' }])),
    completion: { implementation: 'complete', validation: 'verified', archive: 'done', delivery: 'pending-host' },
    verification: { valid: true, receipt: { kind: 'full', commands: [{ exitCode: 0 }] } },
  }
  function check(status: unknown) {
    const { cwd } = fixture()
    const runtime = join(cwd, '.specrails', 'runtime'); mkdirSync(runtime, { recursive: true })
    writeFileSync(join(runtime, 'pipeline.mjs'), `process.stdout.write(${JSON.stringify(JSON.stringify(status))})`)
    return checkCoreCompletion('/context.json', cwd, process.env, 'run')
  }
  it('accepts verified implementation before host-owned delivery', () => {
    expect(check(complete)).toEqual({ valid: true })
  })
  it('preserves Core-approved acceptance exceptions', () => {
    expect(check({ ...complete, completion: { ...complete.completion, validation: 'with-exceptions' } })).toEqual({ valid: true })
  })
  it('supports the Core 5.1 phases and receipt contract', () => {
    const { completion: _completion, ...legacy } = complete
    expect(check(legacy)).toEqual({ valid: true })
  })
  it('accepts a full receipt that explicitly records repositories without automated checks', () => {
    expect(check({ ...complete, verification: { valid: true, receipt: { kind: 'full', commands: [], unverifiedRepositories: ['docs'] } } })).toEqual({ valid: true })
    expect(check({ ...complete, verification: { valid: true, receipt: { kind: 'full', commands: [{ exitCode: 0 }], unverifiedRepositories: ['docs'] } } })).toEqual({ valid: true })
    expect(check({ ...complete, verification: { valid: true, receipt: { kind: 'full', commands: [], unverifiedRepositories: [] } } }).valid).toBe(false)
  })
  it('rejects the archived Tetris case when the final environment check is blocked', () => {
    const result = check({
      ...complete, resumePhase: 'reviewer',
      completion: { ...complete.completion, validation: 'blocked' },
      verification: { ...complete.verification, valid: false, reasons: ['Verification environment changed: npm'] },
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('validation=blocked')
    expect(result.reason).toContain('Verification environment changed: npm')
  })
  it.each([
    { ...complete, runId: 'another' },
    { ...complete, schemaVersion: 2 },
    { ...complete, completion: { ...complete.completion, implementation: 'incomplete' } },
    { ...complete, completion: { ...complete.completion, validation: 'pending' } },
    { ...complete, completion: { ...complete.completion, archive: 'pending' } },
    { ...complete, phases: { ...complete.phases, developer: { status: 'running' } } },
    { ...complete, resumePhase: 'reviewer' },
    { ...complete, verification: { ...complete.verification, valid: false } },
    { ...complete, verification: { valid: true, receipt: { kind: 'scoped', commands: [{ exitCode: 0 }] } } },
    { ...complete, verification: { valid: true, receipt: { kind: 'full', commands: [] } } },
    { ...complete, verification: { valid: true, receipt: { kind: 'full', commands: [{ exitCode: 1 }] } } },
    { ...complete, verification: undefined },
    null,
  ])('rejects incomplete or inconsistent runtime evidence %#', status => {
    expect(check(status).valid).toBe(false)
  })
  it.each(['missing', 'invalid-json', 'exit-error'])('fails closed when runtime status is %s', mode => {
    const { cwd } = fixture()
    if (mode !== 'missing') {
      const runtime = join(cwd, '.specrails', 'runtime'); mkdirSync(runtime, { recursive: true })
      writeFileSync(join(runtime, 'pipeline.mjs'), mode === 'invalid-json' ? 'console.log("broken")' : 'process.exit(1)')
    }
    expect(checkCoreCompletion('/context.json', cwd, process.env, 'run').valid).toBe(false)
  })
})
