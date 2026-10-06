import { defaultLoopAgents } from '../../loops/runtime/loop-agents'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readRuntimeHistory } from './agent-runtime-history'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
import { join } from 'node:path'
const fixture = vi.hoisted(() => ({ cli: null as string | null, node: null as string | null, v2: false, invalid: false, validation: [] as unknown[], capabilities: {} as Record<string, number> }))
vi.mock('./agent-runtime-loader', () => ({ validateRequestedRoleEfforts: vi.fn(), findCoreAgentRuntimeCli: () => fixture.cli, loadCoreAgentRuntime: async () => ({ api: { capabilities: { ...(fixture.v2 ? { engineV2: 1, workflowDefinitions: 1 } : {}), ...fixture.capabilities } }, validateWorkflowDefinition: (value: unknown, options: unknown) => { fixture.validation.push(options); return fixture.invalid ? {ok:false,errors:[{path:'/entry',message:'missing node'}]} : {ok:true,version:'hash-v1',definition:{...value as object,version:'hash-v1'},graph:{nodes:[]}} }, validateRuntimeConfig: (value: unknown) => value, rolePromptDefaults: () => ({ architect: 'Factory architect', developer: 'Factory developer', reviewer: 'Factory reviewer' }) }) }))
vi.mock('./agent-runtime-package', () => ({ retainAgentRuntime: () => fixture.cli, resolveRetainedAgentRuntime: () => fixture.cli }))
vi.mock('../../../path-resolver', () => ({ resolveBundledNodeExe: () => fixture.node }))
import { loadRuntimeConfigFile, saveRuntimeRolePrompts } from './agent-runtime-settings'
import { runAgentRuntimeInvocation, runtimeChangeName, scopedHostChecks } from './agent-runtime-bridge'

let root: string, contextPath: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'runtime bridge with spaces '))
  vi.spyOn(os, 'homedir').mockImplementation(() => join(root, 'home'))
  contextPath = join(root, 'state', 'desktop-context.json')
  mkdirSync(join(root, 'state'))
  writeFileSync(contextPath, JSON.stringify({ runId: 'run-1', repositories: [{ id: 'front' }] }))
  writeFileSync(join(root, 'config.json'), JSON.stringify({ schemaVersion: 1, enabled: true, providers: [{ id: 'claude', kind: 'cli', cli: 'claude' }], agents: { architect: { provider: 'claude' }, developer: { provider: 'claude' }, reviewer: { provider: 'claude' } }, verification: [{ repositoryId: 'front', command: 'npm', args: ['test'] }, { repositoryId: 'back', command: './mvnw', args: ['test'] }] }))
  fixture.v2 = false; fixture.invalid = false; fixture.validation = []; fixture.capabilities = {}
  fixture.cli = join(root, 'cli.mjs')
})
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); fixture.cli = null })
const options = () => ({ contextPath, cwd: root, env: { ...process.env, SPECRAILS_GIT_AUTO: 'false', API_SECRET: 'never-store-this' }, configPath: join(root, 'config.json'), change: 'test-change', timeoutMs: 3000 })
function script(code: string) { writeFileSync(fixture.cli!, code) }
function final(status = 'succeeded', overrides: object = {}) { return { type: 'runtime-result', runId: 'run-1', status, invocationUsage: { costUsd: null, inputTokens: 12, outputTokens: 4 }, ...overrides } }

describe('host checks of a package inside a larger checkout', () => {
  it('run in the registered package, keep explicit package-relative cwd and leave unscoped repositories alone', () => {
    const repositories = [{ id: 'courses', scope: ['apps/busuu-courses'] }, { id: 'api' }]
    expect(scopedHostChecks([
      { repositoryId: 'courses', command: 'yarn', args: ['test'] },
      { repositoryId: 'courses', command: 'yarn', args: ['lint'], cwd: 'src' },
      { repositoryId: 'courses', command: 'yarn', args: ['e2e'], cwd: 'apps/busuu-courses/playwright' },
      { repositoryId: 'api', command: 'npm', args: ['test'] },
    ], repositories).map(check => check.cwd)).toEqual(['apps/busuu-courses', 'apps/busuu-courses/src', 'apps/busuu-courses/playwright', undefined])
    expect(scopedHostChecks([{ repositoryId: 'courses', command: 'yarn', args: ['test'] }])).toEqual([{ repositoryId: 'courses', command: 'yarn', args: ['test'] }])
  })

  it('rejects parent and sibling workspaces and absolute paths to the live checkout', () => {
    const repositories = [{ id: 'studio', path: root, scope: ['skills-studio'] }]
    for (const cwd of ['..', '../skills-service', 'skills-studio/../skills-service', join(root, 'skills-service')]) {
      expect(() => scopedHostChecks([{ repositoryId: 'studio', cwd }], repositories)).toThrow('escapes')
    }
    expect(scopedHostChecks([{ repositoryId: 'studio', cwd: join(root, 'skills-studio', 'tests') }], repositories)[0].cwd).toBe('skills-studio/tests')
    const shared = [{ id: 'studio', scope: ['skills-studio', 'skills-service'] }]
    expect(scopedHostChecks([{ repositoryId: 'studio', key: 'tests' }], shared)).toEqual([{ repositoryId: 'studio', key: 'tests-workspace-0', cwd: 'skills-studio' }, { repositoryId: 'studio', key: 'tests-workspace-1', cwd: 'skills-service' }])
    expect(() => scopedHostChecks([{ repositoryId: 'studio', cwd: '.' }], shared)).toThrow('explicit workspace')
  })

  it('freezes the scoped cwd into the configuration Core receives', async () => {
    writeFileSync(contextPath, JSON.stringify({ runId: 'run-1', repositories: [{ id: 'front', scope: ['apps/web'] }] }))
    script(`console.log(JSON.stringify(${JSON.stringify(final())}));`)
    expect((await runAgentRuntimeInvocation(options())).failed).toBe(false)
    const frozen = JSON.parse(readFileSync(join(root, 'state', 'desktop-runtime-config.json'), 'utf8'))
    expect(frozen.verification).toEqual([{ repositoryId: 'front', command: 'npm', args: ['test'], cwd: 'apps/web' }])
  })
})

describe('definition verification admission', () => {
  const definition = () => ({ schemaVersion: 1, id: 'quick', entry: 'check', nodes: {
    check: { kind: 'verify', params: { commands: 'configured' }, ends: { pass: 'done', fail: 'failed' } },
  } })
  function setup(checks: unknown[] = []) {
    fixture.v2 = true
    const config = JSON.parse(readFileSync(options().configPath, 'utf8'))
    config.verification = checks
    writeFileSync(options().configPath, JSON.stringify(config))
    writeFileSync(contextPath, JSON.stringify({ runId: 'run-1', repositories: [{ id: 'front', path: root, scope: ['studio'] }] }))
    mkdirSync(join(root, 'studio'))
    script(`console.log(JSON.stringify(${JSON.stringify(final())}));`)
  }

  it('detects workspace tests, freezes them and resumes without rediscovery', async () => {
    setup([{ repositoryId: 'back', command: 'npm', args: ['test'] }])
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'wrong parent tests' } }))
    writeFileSync(join(root, 'studio', 'package.json'), JSON.stringify({ scripts: { test: 'tsx --test lib/*.test.ts' } }))
    loadRuntimeConfigFile(options().configPath)
    const original = readFileSync(options().configPath, 'utf8')
    await runAgentRuntimeInvocation({ ...options(), engineVersion: 2, prepareDefinition: definition })
    const file = join(root, 'state', 'desktop-runtime-config.json'), frozen = readFileSync(file, 'utf8')
    expect(JSON.parse(frozen).verification).toEqual([{ repositoryId: 'front', command: 'npm', args: ['test'], cwd: 'studio' }])
    expect(readFileSync(options().configPath, 'utf8')).toBe(original)
    writeFileSync(join(root, 'studio', 'package.json'), '{}')
    await runAgentRuntimeInvocation({ ...options(), engineVersion: 2, resume: true })
    expect(readFileSync(file, 'utf8')).toBe(frozen)
  })

  it('rejects missing checks before spawning and never falls back to parent or sibling scripts', async () => {
    setup()
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'wrong parent tests' } }))
    mkdirSync(join(root, 'service'))
    writeFileSync(join(root, 'service', 'package.json'), JSON.stringify({ scripts: { test: 'wrong sibling tests' } }))
    const onSpawn = vi.fn()
    await expect(runAgentRuntimeInvocation({ ...options(), engineVersion: 2, prepareDefinition: definition, onSpawn })).rejects.toThrow('verification_checks_missing')
    expect(onSpawn).not.toHaveBeenCalled()
    expect(existsSync(join(root, 'state', 'desktop-runtime-config.json'))).toBe(false)
  })

  it('preserves explicit checks instead of adding detected scripts', async () => {
    setup([{ repositoryId: 'front', command: 'npm', args: ['run', 'custom'] }])
    writeFileSync(join(root, 'studio', 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }))
    await runAgentRuntimeInvocation({ ...options(), engineVersion: 2, prepareDefinition: definition })
    expect(JSON.parse(readFileSync(join(root, 'state', 'desktop-runtime-config.json'), 'utf8')).verification).toEqual([{ repositoryId: 'front', command: 'npm', args: ['run', 'custom'], cwd: 'studio' }])
  })

  it('forwards setup commands, scoped like checks, only when Core advertises setupCommands', async () => {
    setup([{ repositoryId: 'front', command: 'npm', args: ['test'] }])
    const config = JSON.parse(readFileSync(options().configPath, 'utf8'))
    config.setup = [{ repositoryId: 'front', command: 'npx', args: ['playwright', 'install', 'chromium'] }, { repositoryId: 'elsewhere', command: 'true', args: [] }]
    writeFileSync(options().configPath, JSON.stringify(config))
    writeFileSync(contextPath, JSON.stringify({ runId: 'run-1', repositories: [{ id: 'front', scope: ['apps/web'] }] }))
    const frozen = () => JSON.parse(readFileSync(join(root, 'state', 'desktop-runtime-config.json'), 'utf8'))

    fixture.capabilities = { setupCommands: 1 }
    const supported = vi.fn()
    await runAgentRuntimeInvocation({ ...options(), engineVersion: 2, prepareDefinition: definition, onLine: supported })
    expect(frozen().setup).toEqual([{ repositoryId: 'front', command: 'npx', args: ['playwright', 'install', 'chromium'], cwd: 'apps/web' }])
    expect(supported.mock.calls.map(call => call[0]).join('')).not.toContain('setup commands ignored')

    fixture.capabilities = {}
    rmSync(join(root, 'state', 'desktop-runtime-config.json'), { force: true })
    const unsupported = vi.fn()
    await runAgentRuntimeInvocation({ ...options(), engineVersion: 2, prepareDefinition: definition, onLine: unsupported })
    expect(frozen()).not.toHaveProperty('setup')
    expect(frozen().verification).toEqual([{ repositoryId: 'front', command: 'npm', args: ['test'], cwd: 'apps/web' }])
    expect(unsupported.mock.calls.map(call => call[0]).join('')).toContain('[runtime] setup commands ignored: the installed Core does not advertise setupCommands (1 configured)')
  })

  it('allows workflows that supply verification proposals later', async () => {
    setup()
    await runAgentRuntimeInvocation({ ...options(), engineVersion: 2, prepareDefinition: () => ({ ...definition(), nodes: {
      check: { kind: 'verify', params: { commands: 'configured', additionalCommandsFrom: 'architect' }, ends: {} },
    } }) })
    expect(JSON.parse(readFileSync(join(root, 'state', 'desktop-runtime-config.json'), 'utf8')).verification).toEqual([])
  })
})

describe('Core process bridge', () => {
  it('compacts a large successful Jest stream without changing raw events or its recorded outcome', async () => {
    const identity = { runId: 'run-1', nodePath: 'verify', scopeId: 'root', attemptId: 'attempt-1', attempt: 1, visit: 1 }
    const rows = 77_018
    script(`
      const identity = ${JSON.stringify(identity)};
      const send = event => console.log(JSON.stringify({...identity, ...event}));
      send({type:'runtime-efficiency-event',kind:'check-started',executionId:'check-1',repositoryId:'front',checkId:'test',label:'yarn'});
      for (let i=0;i<${rows};i++) send({type:'verification-output',text:'[verification front/yarn] '+(i%3===0 ? ' PASS app/example-'+i+'.spec.ts' : i%3===1 ? '    console.warn' : '      at warning (node_modules/example/index.js:20:10)')+'\\n'});
      send({type:'verification-output',text:'[verification front/yarn] Test Suites: 457 passed, 457 total\\n[verification front/yarn] Tests: 4230 passed, 4230 total\\n'});
      send({type:'runtime-efficiency-event',kind:'check-finished',executionId:'check-1',repositoryId:'front',checkId:'test',label:'yarn',exitCode:0,durationMs:189365,reason:null});
      send({type:'workflow-event',event:{type:'step_succeeded',stepId:'verify',...identity}});
      console.log(JSON.stringify(${JSON.stringify(final())}));
    `)
    const readable: string[] = []
    let rawCount = 0, runtimeCount = 0
    const result = await runAgentRuntimeInvocation({ ...options(), timeoutMs: 30_000, onLine: line => readable.push(line), onRawLine: () => rawCount++, onRuntimeEvent: () => runtimeCount++ })
    const log = readable.join('')
    expect(result.failed).toBe(false)
    expect(rawCount).toBe(rows + 5)
    expect(runtimeCount).toBe(rawCount)
    expect(log.length).toBeLessThan(16_000)
    expect(log).toContain('output omitted')
    expect(log).toContain('Verification evidence')
    expect(log).toContain('Test Suites: 457 passed, 457 total')
    expect(log).toContain('Tests: 4230 passed, 4230 total')
    expect(log).toContain('passed (exit 0, 189.4 s)')
    expect(log.indexOf('Test Suites:')).toBeLessThan(log.indexOf('[runtime] step_succeeded: verify'))
  }, 30_000)

  it('reserves late compiler and assertion facts after unknown output and flushes before the next step', async () => {
    const before = '[verification front/check] progress detail\n'.repeat(1600)
    const after = Array.from({ length: 1600 }, (_, index) => '[verification front/check] generic trailing detail ' + index + '\n').join('')
    const events = [
      { runId: 'run-1', type: 'verification-output', text: before },
      { runId: 'run-1', type: 'verification-output', text: '[verification front/check] src/feature.ts(10,3): error TS2551: Missing property\n[verification front/check] AssertionError: expected enabled guard\n[verification front/check] expected: true\n' },
      { runId: 'run-1', type: 'verification-output', text: after },
      { type: 'workflow-event', event: { type: 'step_succeeded', stepId: 'verify', outcome: 'fail' } },
      { type: 'workflow-event', event: { type: 'step_started', stepId: 'fixer' } },
    ]
    script(events.map(event => `console.log(JSON.stringify(${JSON.stringify(event)}));`).join('') + `console.log(JSON.stringify(${JSON.stringify(final('failed'))}));`)
    const readable: string[] = [], raw: string[] = [], order: string[] = []
    const result = await runAgentRuntimeInvocation({ ...options(), onLine: line => { readable.push(line); order.push(line) }, onRawLine: line => raw.push(line), onRuntimeEvent: event => {
      if (event.type === 'workflow-event') order.push('PROJECT ' + String((event.event as { type: string }).type))
    } })
    const log = readable.join('')
    expect(result.failed).toBe(true)
    expect(log.length).toBeLessThan(16_000)
    expect(log).toContain('output omitted')
    expect(log).toContain('src/feature.ts(10,3): error TS2551: Missing property')
    expect(log).toContain('AssertionError: expected enabled guard')
    expect(log).toContain('expected: true')
    expect(log.indexOf('generic trailing detail')).toBeLessThan(log.indexOf('[runtime] verification_failed: verify'))
    expect(order.findIndex(line => line.includes('generic trailing detail'))).toBeLessThan(order.indexOf('PROJECT step_succeeded'))
    expect(raw).toEqual([...events, final('failed')].map(event => JSON.stringify(event)))
  })

  it('isolates interleaved attempts and repeated checks and supports nested lifecycle payloads', async () => {
    const a = { runId: 'run-1', nodePath: 'map[0]/verify', scopeId: 'a', attemptId: 'a1', attempt: 1, visit: 1 }
    const b = { ...a, nodePath: 'map[1]/verify', scopeId: 'b', attemptId: 'b1' }
    const check = { repositoryId: 'front', checkId: 'tests', label: 'node' }
    const events = [
      { ...a, type: 'runtime-efficiency-event', kind: 'check-started', ...check, executionId: 'one' },
      { ...b, type: 'runtime-efficiency-event', payload: { kind: 'check-started', ...check, executionId: 'two' } },
      { ...a, type: 'verification-output', text: '[verification front/tests] noise\n'.repeat(200) },
      { ...b, type: 'verification-output', text: '[verification front/tests] AssertionError: branch two fails\n' },
      { ...a, type: 'runtime-efficiency-event', kind: 'check-finished', ...check, executionId: 'one', exitCode: 0, durationMs: 10 },
      { ...b, type: 'runtime-efficiency-event', payload: { kind: 'check-finished', ...check, executionId: 'two', exitCode: 1, durationMs: 20 } },
      { ...a, type: 'runtime-efficiency-event', kind: 'check-started', ...check, executionId: 'three' },
      { ...a, type: 'verification-output', text: '[verification front/tests] next command is visible\n' },
      { ...a, type: 'runtime-efficiency-event', kind: 'check-finished', ...check, executionId: 'three', exitCode: 0, durationMs: 30 },
      { ...b, type: 'runtime-efficiency-event', kind: 'check-reused', ...check, executionId: 'four', exitCode: 0, durationMs: 0 },
      { ...b, type: 'runtime-efficiency-event', kind: 'check-invalidated', ...check, executionId: 'four', reason: 'Candidate changed during verification' },
    ]
    script(events.map(event => `console.log(JSON.stringify(${JSON.stringify(event)}));`).join('') + `console.log(JSON.stringify(${JSON.stringify(final('failed'))}));`)
    const onLine = vi.fn(), onRawLine = vi.fn()
    await runAgentRuntimeInvocation({ ...options(), onLine, onRawLine })
    const log = onLine.mock.calls.map(call => call[0]).join('')
    expect(log).toContain('AssertionError: branch two fails')
    expect(log).toContain('next command is visible')
    expect(log).toContain('failed (exit 1, 0.0 s)')
    expect(log).toContain('reused (exit 0, 0.0 s)')
    expect(log).toContain('invalidated: Candidate changed during verification')
    expect(log.match(/started/g)).toHaveLength(3)
    expect(onLine.mock.calls.filter(call => String(call[0]).includes('branch two fails')).every(call => call[2]?.attemptId === 'b1')).toBe(true)
    expect(onLine.mock.calls.filter(call => String(call[0]).includes('output lines compacted')).every(call => call[2]?.attemptId === 'a1')).toBe(true)
    for (const event of events) expect(onRawLine).toHaveBeenCalledWith(JSON.stringify(event))
  })

  it('flushes bounded unknown output on process close without requiring lifecycle support', async () => {
    const event = { type: 'verification-output', text: '[verification old/tool] beginning\n' + '[verification old/tool] generic detail\n'.repeat(1000) + '[verification old/tool] final unknown failure detail\n' }
    script(`console.log(JSON.stringify(${JSON.stringify(event)}));console.log(JSON.stringify(${JSON.stringify(final('failed'))}));`)
    const onLine = vi.fn(), onRawLine = vi.fn()
    await runAgentRuntimeInvocation({ ...options(), onLine, onRawLine })
    const log = onLine.mock.calls.map(call => call[0]).join('')
    expect(log.length).toBeLessThan(16_000)
    expect(log).toContain('beginning')
    expect(log).toContain('final unknown failure detail')
    expect(log).toContain('output omitted')
    expect(onRawLine).toHaveBeenCalledWith(JSON.stringify(event))
  })

  it('bounds repeated assertion source blocks and flushes their late diagnostic after cancellation', async () => {
    const prefix = '[verification front/node] '
    const block = prefix + 'AssertionError: Input:\n' + [1, 2, 3, 4].map(index => prefix + '"source ' + index + '\\n" +\n').join('')
    const event = { type: 'verification-output', attemptId: 'cancelled-attempt', text: block.repeat(1000) + prefix + 'final cancellation diagnostic\n' }
    script(`console.log(JSON.stringify(${JSON.stringify(event)}));setTimeout(()=>process.kill(process.pid,'SIGTERM'),30);`)
    const onLine = vi.fn(), onRawLine = vi.fn()
    const result = await runAgentRuntimeInvocation({ ...options(), onLine, onRawLine })
    const log = onLine.mock.calls.map(call => call[0]).join('')
    expect(result.failed).toBe(true)
    expect(log.length).toBeLessThan(16_000)
    expect(log.match(/Assertion input shortened/g)).toHaveLength(1)
    expect(log).toContain('final cancellation diagnostic')
    expect(onLine.mock.calls.filter(call => String(call[0]).includes('final cancellation diagnostic')).every(call => call[2]?.attemptId === 'cancelled-attempt')).toBe(true)
    expect(onRawLine).toHaveBeenCalledWith(JSON.stringify(event))
  })

  it('retains totals and compiler facts with long valid repository IDs and command labels', async () => {
    const repositoryId = 'repository-'.repeat(11), label = 'verify-suite-'.repeat(19)
    const prefix = `[verification ${repositoryId}/${label}] `
    const event = { type: 'verification-output', text: (prefix + 'console detail\n').repeat(200) + prefix + 'src/a.ts(1,2): error TS2551: Missing field\n' + prefix + 'Tests: 4 passed, 4 total\n' }
    script(`console.log(JSON.stringify(${JSON.stringify(event)}));console.log(JSON.stringify(${JSON.stringify(final('failed'))}));`)
    const onLine = vi.fn(), onRawLine = vi.fn()
    await runAgentRuntimeInvocation({ ...options(), onLine, onRawLine })
    const log = onLine.mock.calls.map(call => call[0]).join('')
    expect(log.length).toBeLessThan(16_000)
    expect(log).toContain('Tests: 4 passed, 4 total')
    expect(log).toContain('src/a.ts(1,2): error TS2551: Missing field')
    expect(onRawLine).toHaveBeenCalledWith(JSON.stringify(event))
  })

  it('freezes global role definitions for new jobs and ignores later edits on resume', async () => {
    saveRuntimeRolePrompts({ developer: 'Use my project conventions' })
    script(`console.log(JSON.stringify(${JSON.stringify(final())}));`)
    expect((await runAgentRuntimeInvocation(options())).failed).toBe(false)
    const file = join(root, 'state', 'desktop-runtime-config.json')
    const frozen = readFileSync(file, 'utf8')
    expect(JSON.parse(frozen).rolePrompts).toEqual({ architect: 'Factory architect', developer: 'Use my project conventions', reviewer: 'Factory reviewer' })
    saveRuntimeRolePrompts({ developer: 'A later definition' })
    expect((await runAgentRuntimeInvocation({ ...options(), resume: true })).failed).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(frozen)
  })

  it('honors the launch provider without carrying models from a different provider into the frozen roles', async () => {
    const config = JSON.parse(readFileSync(options().configPath, 'utf8'))
    config.providers.push({ id: 'codex', kind: 'cli', cli: 'codex' })
    config.agents.architect.model = 'sonnet'
    writeFileSync(options().configPath, JSON.stringify(config))
    script(`console.log(JSON.stringify(${JSON.stringify(final())}));`)
    const onLine = vi.fn()
    expect((await runAgentRuntimeInvocation({ ...options(), defaultProvider: 'codex', providerOverride: { provider: 'codex', model: 'gpt-5.6-sol' }, onLine })).failed).toBe(false)
    const frozen = JSON.parse(readFileSync(join(root, 'state', 'desktop-runtime-config.json'), 'utf8'))
    expect(frozen.agents.developer).toMatchObject({ provider: 'codex', model: 'gpt-5.6-sol' })
    expect(frozen.agents.architect).toMatchObject({ provider: 'codex', model: 'gpt-5.6-sol' })
    expect(frozen.agents.reviewer).toMatchObject({ provider: 'codex', model: 'gpt-5.6-sol' })
    expect(onLine.mock.calls.map(call => call[0]).join('')).toContain('developer: codex/gpt-5.6-sol')
    await runAgentRuntimeInvocation({ ...options(), resume: true, defaultProvider: 'claude' })
    expect(JSON.parse(readFileSync(join(root, 'state', 'desktop-runtime-config.json'), 'utf8')).agents).toEqual(frozen.agents)
  })
  it('removes terminal escape sequences from readable verification output but preserves raw evidence', async () => {
    const event = { type: 'verification-output', text: '\u001b[32m67 passed\u001b[39m\n' }
    script(`console.log(JSON.stringify(${JSON.stringify(event)}));console.log(JSON.stringify(${JSON.stringify(final())}));`)
    const onLine = vi.fn(), onRawLine = vi.fn()
    await runAgentRuntimeInvocation({ ...options(), onLine, onRawLine })
    expect(onLine).toHaveBeenCalledWith('67 passed\n')
    expect(onRawLine).toHaveBeenCalledWith(JSON.stringify(event))
  })
  it('summarizes TAP successes, retains failures and preserves raw verification events', async () => {
    const text = '[verification front/npm] TAP version 13\n[verification front/npm] # Subtest: passing\n[verification front/npm] ok 1 - passing\n[verification front/npm]   ---\n[verification front/npm]   duration_ms: 0.1\n[verification front/npm]   ...\n[verification front/npm] # Subtest: broken\n[verification front/npm] not ok 2 - broken\n[verification front/npm]   ---\n[verification front/npm]   error: wrong result\n[verification front/npm]   ...\n[verification front/npm] # tests 2\n[verification front/npm] # pass 1\n[verification front/npm] # fail 1\n'
    const event = { type: 'verification-output', text }
    script(`console.log(JSON.stringify(${JSON.stringify(event)}));console.log(JSON.stringify(${JSON.stringify(final())}));`)
    const onLine = vi.fn(), onRawLine = vi.fn()
    await runAgentRuntimeInvocation({ ...options(), onLine, onRawLine })
    const readable = onLine.mock.calls.map(call => call[0]).join('')
    expect(readable).not.toContain('ok 1 - passing')
    expect(readable).not.toContain('duration_ms:')
    expect(readable).toContain('not ok 2 - broken')
    expect(readable).toContain('error: wrong result')
    expect(readable).toContain('# tests 2')
    expect(onRawLine).toHaveBeenCalledWith(JSON.stringify(event))
  })

  it('summarizes the Node spec reporter and bounds huge assertion source dumps', async () => {
    const text = '[verification front/npm] ✔ passing case (1ms)\n[verification front/npm] ✖ broken case (1ms)\n[verification front/npm] ℹ tests 2\n[verification front/npm] ℹ pass 1\n[verification front/npm] ℹ fail 1\n[verification front/npm] test at lib/reconcileProdGuard.test.ts:52\n[verification front/npm] AssertionError: expected Escape guard\n[verification front/npm] actual: ' + 'source'.repeat(5000) + '\n[verification front/npm] expected: /Escape/\n'
    const event = { type: 'verification-output', text }
    script(`console.log(JSON.stringify(${JSON.stringify(event)}));console.log(JSON.stringify(${JSON.stringify(final())}));`)
    const onLine = vi.fn(), onRawLine = vi.fn()
    await runAgentRuntimeInvocation({ ...options(), onLine, onRawLine })
    const readable = onLine.mock.calls.map(call => call[0]).join('')
    expect(readable).not.toContain('✔ passing case')
    expect(readable).toContain('✖ broken case')
    expect(readable).toContain('ℹ fail 1')
    expect(readable).toContain('reconcileProdGuard.test.ts:52')
    expect(readable).toContain('expected: /Escape/')
    expect(readable.length).toBeLessThan(3_000)
    expect(onRawLine).toHaveBeenCalledWith(JSON.stringify(event))
  })

  it('folds multiline assertion input across events without hiding stacks or other verification streams', async () => {
    const prefix = '[verification front/npm] '
    const events = [
      { type: 'verification-output', text: prefix + "AssertionError [ERR_ASSERTION]: Input:\n" + prefix + '"source line 1\\n" +\n' },
      { type: 'verification-output', text: '[verification back/npm] "an independent diagnostic"\n' },
      { type: 'verification-output', text: Array.from({ length: 400 }, (_, i) => prefix + '"source line ' + (i + 2) + '\\n" +\n').join('') },
      { type: 'verification-output', text: prefix + 'at TestContext.<anonymous> (/repo/guard.test.ts:52:10)\n' + prefix + 'expected: /Escape.*!confirmPending/\n' + prefix + 'ℹ fail 1\n' },
    ]
    script(events.map(event => `console.log(JSON.stringify(${JSON.stringify(event)}));`).join('') + `console.log(JSON.stringify(${JSON.stringify(final())}));`)
    const onLine = vi.fn(), onRawLine = vi.fn()
    await runAgentRuntimeInvocation({ ...options(), onLine, onRawLine })
    const readable = onLine.mock.calls.map(call => call[0]).join('')
    expect(readable).toContain('AssertionError')
    expect(readable).toContain('Assertion input shortened')
    expect(readable).toContain('an independent diagnostic')
    expect(readable).toContain('/repo/guard.test.ts:52:10')
    expect(readable).toContain('expected: /Escape.*!confirmPending/')
    expect(readable).toContain('ℹ fail 1')
    expect(readable).not.toContain('source line 400')
    expect(readable.length).toBeLessThan(1500)
    for (const event of events) expect(onRawLine).toHaveBeenCalledWith(JSON.stringify(event))
  })

  it('explains failed verification outcomes and role errors in the readable log', async () => {
    const events = [{ type: 'workflow-event', event: { type: 'step_succeeded', stepId: 'verify', outcome: 'fail' } },
      { type: 'workflow-event', event: { type: 'step_failed', stepId: 'architect', error: { message: 'missing instructions tasks' } } }]
    script(events.map(event => `console.log(JSON.stringify(${JSON.stringify(event)}));`).join('') + `console.log(JSON.stringify(${JSON.stringify(final())}));`)
    const onLine = vi.fn()
    await runAgentRuntimeInvocation({ ...options(), onLine })
    expect(onLine).toHaveBeenCalledWith('[runtime] verification_failed: verify\n')
    expect(onLine).toHaveBeenCalledWith('[runtime] step_failed: architect — missing instructions tasks\n')
  })

  it('shows bounded durable completion reasons in the readable failure log without changing settlement', async () => {
    const reason = 'Automatic correction made no candidate changes. Required canvas fallback is missing.'
    const event = { type: 'workflow-event', event: { type: 'workflow_failed', reasons: [null, '', reason, 'x'.repeat(10_000)] } }
    script(`console.log(JSON.stringify(${JSON.stringify(event)}));console.log(JSON.stringify(${JSON.stringify(final('failed', { completion: { ok: false, verified: false, reasons: [reason] } }))}));process.exitCode=1;`)
    const onLine = vi.fn(), onRawLine = vi.fn()
    expect(await runAgentRuntimeInvocation({ ...options(), onLine, onRawLine })).toMatchObject({ failed: true, errorText: reason })
    const readable = onLine.mock.calls.flat().filter(line => typeof line === 'string' && line.startsWith('[runtime] workflow_failed')).join('')
    expect(readable).toContain('[runtime] workflow_failed — ' + reason)
    expect(readable.length).toBeLessThan(4_040)
    expect(onRawLine).toHaveBeenCalledWith(JSON.stringify(event))
  })

  it('freezes only the selected repositories checks and resumes without rereading project settings', async () => {
    script(`console.log(JSON.stringify(${JSON.stringify(final())}));`)
    const original = readFileSync(options().configPath, 'utf8')
    expect((await runAgentRuntimeInvocation(options())).failed).toBe(false)
    const scopedPath = join(root, 'state', 'desktop-runtime-config.json')
    const scoped = readFileSync(scopedPath, 'utf8')
    expect(JSON.parse(scoped).verification).toEqual([{ repositoryId: 'front', command: 'npm', args: ['test'] }])
    expect(JSON.parse(readFileSync(options().configPath, 'utf8')).verification).toEqual(JSON.parse(original).verification)
    writeFileSync(options().configPath, 'changed project settings')
    expect((await runAgentRuntimeInvocation({ ...options(), resume: true })).failed).toBe(false)
    expect(readFileSync(scopedPath, 'utf8')).toBe(scoped)
  })
  it('launches PATH Node when a packaged sidecar has no bundled Node', async () => {
    const previous = Object.getOwnPropertyDescriptor(process, 'pkg')
    Object.defineProperty(process, 'pkg', { configurable: true, value: { entrypoint: '/snapshot/server/index.js' } })
    try {
      script(`console.log(JSON.stringify(${JSON.stringify(final())}));`)
      let executable: string | undefined
      const result = await runAgentRuntimeInvocation({ ...options(), onSpawn: (child) => { executable = child.spawnfile } })
      expect(executable).toBe('node')
      expect(result.failed).toBe(false)
    } finally {
      if (previous) Object.defineProperty(process, 'pkg', previous)
      else delete (process as NodeJS.Process & { pkg?: unknown }).pkg
    }
  })
  it('persists repository labels for multi-repository tools in readable and structured logs on resume', async () => {
    writeFileSync(contextPath, JSON.stringify({ runId: 'run-1', artifactRoot: root, repositories: [
      { id: 'front', name: 'Front', path: join(root, 'front') }, { id: 'back', name: 'Back', path: join(root, 'back') },
    ] }))
    const event = { type: 'agent-event', role: 'developer', event: { kind: 'tool-start', tool: 'Read', detail: 'app.ts', targetPaths: [join(root, 'back/app.ts')] } }
    script(`console.log(JSON.stringify(${JSON.stringify(event)}));console.log(JSON.stringify(${JSON.stringify(final())}));`)
    const onLine = vi.fn(), onRawLine = vi.fn()
    expect((await runAgentRuntimeInvocation({ ...options(), resume: true, onLine, onRawLine })).failed).toBe(false)
    expect(onLine).toHaveBeenCalledWith('[developer] [Back] Read app.ts\n')
    expect(JSON.parse(onRawLine.mock.calls[0][0])).toMatchObject({ repositories: [{ id: 'back', name: 'Back' }] })
  })
  it('runs the Core CLI with structured arguments, streams phases and preserves unknown billing', async () => {
    script(`console.log(JSON.stringify({type:'workflow-event',event:{type:'step_started',stepId:'architect'}})); console.log(JSON.stringify({type:'agent-event',role:'developer',event:{kind:'tool-start',tool:'Read',detail:'src/app.ts'}})); console.log(JSON.stringify({type:'agent-event',role:'developer',event:{kind:'text',text:'Implemented'}})); console.log(JSON.stringify(${JSON.stringify(final())}));`)
    const onLine = vi.fn(), onRawLine = vi.fn(), onSpawn = vi.fn()
    const result = await runAgentRuntimeInvocation({ ...options(), onLine, onRawLine, onSpawn })
    expect(result).toMatchObject({ failed: false, provider: 'agent-runtime', text: 'Implemented', cost: undefined, tokensIn: 12, tokensOut: 4, tokens: 16 })
    expect(onLine).toHaveBeenCalledWith('[runtime] step_started: architect\n')
    expect(onLine).toHaveBeenCalledWith('[developer] Read src/app.ts\n')
    expect(onRawLine).toHaveBeenCalledTimes(4)
    expect(onSpawn).toHaveBeenCalledOnce()
    const host = readFileSync(join(root, 'state', 'desktop-runtime-host.json'), 'utf8')
    expect(host).toContain('SPECRAILS_GIT_AUTO')
    expect(host).not.toContain('never-store-this')
  })
  it('passes resume approvals/recovery as argv and leaves the original host snapshot untouched', async () => {
    script(`if(!process.argv.includes('resume')||!process.argv.includes('--recover')||!process.argv.includes('developer'))process.exit(7); console.log(JSON.stringify(${JSON.stringify(final())}));`)
    const result = await runAgentRuntimeInvocation({ ...options(), resume: true, approve: ['archive'], recover: ['developer'], invalidate: ['verify'] })
    expect(result.failed).toBe(false)
  })
  it('passes an answer verbatim on resume only and tolerates trace spans in the event stream', async () => {
    script(`const i=process.argv.indexOf('--answer'); if(!process.argv.includes('resume')||i<0||process.argv[i+1]!=='Use Redis, keep the schema')process.exit(7); console.log(JSON.stringify({type:'span',span:{traceId:'t1',spanId:'s1',name:'architect',stepId:'architect',attempt:1,visit:2,startedAt:'a',endedAt:'b',status:'ok'}})); console.log(JSON.stringify(${JSON.stringify(final())}));`)
    const onLine = vi.fn(), onRawLine = vi.fn()
    const result = await runAgentRuntimeInvocation({ ...options(), resume: true, answer: 'Use Redis, keep the schema', onLine, onRawLine })
    expect(result.failed).toBe(false)
    expect(onRawLine).toHaveBeenCalledTimes(2)
    expect(onLine).not.toHaveBeenCalled()
    await expect(runAgentRuntimeInvocation({ ...options(), answer: 'no run yet' })).rejects.toThrow('Answers apply to runtime resume')
  })
  it.each([
    ['missing result', ''],
    ['nonzero exit', `console.log(JSON.stringify(${JSON.stringify(final())}));process.exitCode=4;`],
    ['wrong run', `console.log(JSON.stringify(${JSON.stringify(final('succeeded', { runId: 'other' }))}));`],
    ['invalid JSON', 'console.log("not JSON");'],
    ['null frame', 'console.log("null");'],
    ['duplicate result', `console.log(JSON.stringify(${JSON.stringify(final())}));console.log(JSON.stringify(${JSON.stringify(final())}));`],
    ['provider failure', `console.log(JSON.stringify(${JSON.stringify(final('failed', { error: 'auth failed' }))}));`],
  ])('fails closed on %s', async (_name, code) => {
    script(code)
    expect((await runAgentRuntimeInvocation(options())).failed).toBe(true)
  })
  it('exposes pending approval or the architect question without claiming success', async () => {
    script(`console.log(JSON.stringify(${JSON.stringify(final('paused'))}));process.exitCode=2;`)
    expect(await runAgentRuntimeInvocation(options())).toMatchObject({ failed: true, errorText: expect.stringContaining('approval') })
    script(`console.log(JSON.stringify(${JSON.stringify(final('paused', { pendingQuestion: { stepId: 'architect', question: '  Which cache backend?  ' } }))}));process.exitCode=2;`)
    expect(await runAgentRuntimeInvocation(options())).toMatchObject({ failed: true, errorText: 'Workflow awaits an answer in Agent Runtime settings: Which cache backend?' })
    script(`console.log(JSON.stringify(${JSON.stringify(final('paused', { pendingQuestion: { stepId: 'architect', question: '' } }))}));process.exitCode=2;`)
    expect((await runAgentRuntimeInvocation(options())).errorText).toContain('approval')
  })
  it('reports the failed workflow completion reason instead of a generic Core exit error', async () => {
    const reason = 'Verification remains failed and the correction made no candidate changes. Queue-modal test is outside the approved scope.'
    script(`console.log(JSON.stringify(${JSON.stringify(final('failed', { completion: { ok: false, verified: false, reasons: [reason] } }))}));process.exitCode=1;`)
    expect(await runAgentRuntimeInvocation(options())).toMatchObject({ failed: true, errorText: reason, text: reason })
  })

  it.each(['failed', 'succeeded'])('retains the real step error for a %s result without overriding terminal success', async status => {
    const reason = 'assess must execute openspec-verify-change (missing load_skill, instructions apply)'
    const event = { type: 'workflow-event', event: { type: 'step_failed', stepId: 'reviewer', error: { message: reason } } }
    script(`console.log(JSON.stringify(${JSON.stringify(event)}));console.log(JSON.stringify(${JSON.stringify(final(status, { completion: { ok: status === 'succeeded', verified: true, reasons: [] } }))}));process.exitCode=${status === 'failed' ? 1 : 0};`)
    const result = await runAgentRuntimeInvocation(options())
    expect(result.failed).toBe(status === 'failed')
    expect(result.errorText).toBe(status === 'failed' ? reason : undefined)
    expect(readRuntimeHistory(contextPath)?.error).toBe(status === 'failed' ? reason : undefined)
  })

  it('clears a recovered step error within its own scope while retaining another failed branch', async () => {
    const events = [
      { type: 'step_failed', nodePath: 'reviewer', scopeId: 'a', error: { message: 'Unresolved review in branch a' } },
      { type: 'step_failed', nodePath: 'reviewer', scopeId: 'b', error: { message: 'Recovered review in branch b' } },
      { type: 'step_succeeded', nodePath: 'reviewer', scopeId: 'b' },
    ]
    script(events.map(event => `console.log(JSON.stringify(${JSON.stringify({ type: 'workflow-event', event })}));`).join('') + `console.log(JSON.stringify(${JSON.stringify(final('failed', { completion: { ok: false, verified: true, reasons: [] } }))}));process.exitCode=1;`)
    expect(await runAgentRuntimeInvocation(options())).toMatchObject({ failed: true, errorText: 'Unresolved review in branch a' })
    expect(readRuntimeHistory(contextPath)?.error).toBe('Unresolved review in branch a')
  })
  it('terminates a hung child and retains recovery metadata', async () => {
    script('setInterval(()=>{},1000)')
    expect(await runAgentRuntimeInvocation({ ...options(), timeoutMs: 100 })).toMatchObject({ failed: true, errorText: expect.stringContaining('timed out') })
    expect(readFileSync(join(root, 'state', 'desktop-runtime-host.json'), 'utf8')).toContain('schemaVersion')
  })
  it('ignores log observer exceptions but terminates if process ownership cannot be registered', async () => {
    script(`console.log(JSON.stringify({type:'verification-output',text:'test'}));console.log(JSON.stringify(${JSON.stringify(final())}));`)
    expect((await runAgentRuntimeInvocation({ ...options(), onLine: () => { throw Error('observer') } })).failed).toBe(false)
    script('setInterval(()=>{},1000)')
    expect(await runAgentRuntimeInvocation({ ...options(), onSpawn: () => { throw Error('registration') } })).toMatchObject({ failed: true, errorText: 'registration' })
  })
  it('refuses a changed frozen host scope or unavailable runtime before spawning', async () => {
    script(`console.log(JSON.stringify(${JSON.stringify(final())}));`)
    await runAgentRuntimeInvocation(options())
    await expect(runAgentRuntimeInvocation({ ...options(), env: { SPECRAILS_GIT_AUTO: 'true' } })).rejects.toThrow('scope changed')
    fixture.cli = null
    await expect(runAgentRuntimeInvocation(options())).rejects.toThrow('unavailable')
  })
})

describe('programmatic selection', () => {
  it('uses an explicit config or pinned admission, never silently ignores malformed config', () => {
    const file = join(root, 'selection-config.json')
    expect(loadRuntimeConfigFile(file).enabled).toBe(true)
    const config = { schemaVersion: 1, enabled: false, providers: [{ id: 'claude', kind: 'cli', cli: 'claude' }], agents: { architect: { provider: 'claude' }, developer: { provider: 'claude' }, reviewer: { provider: 'claude' } }, verification: [] }
    writeFileSync(file, JSON.stringify(config))
    expect(loadRuntimeConfigFile(file).enabled).toBe(true)
    writeFileSync(join(root, 'state', 'agent-runtime-request.json'), '{}')
    expect(loadRuntimeConfigFile(file).enabled).toBe(true)
    writeFileSync(file, 'bad JSON')
    expect(() => loadRuntimeConfigFile(file).enabled).toThrow()
    expect(runtimeChangeName('RUN/with spaces')).toMatch(/^runtime-[a-f0-9]{20}$/)
    expect(runtimeChangeName('same')).toBe(runtimeChangeName('same'))
  })
})


describe('Core definition process bridge', () => {
  const definition = () => ({schemaVersion:1,id:'authored',entry:'finish',nodes:{finish:{kind:'end',params:{outcome:'success'},ends:{}}}})
  const v2 = (status='succeeded',more:object={}) => final(status,{engineVersion:2,completion:{ok:true,verified:false,reasons:[]},usage:{durationMs:1234},...more})
  it('resolves inherit loop definitions to the engine defaults plus global overrides and freezes the result', async () => {
    fixture.v2 = true
    script(`console.log(JSON.stringify(${JSON.stringify(v2())}));`)
    saveRuntimeRolePrompts({ architect: 'Global architect override' })
    const recipe = defaultLoopAgents()
    recipe.roles = { ...recipe.roles, plan: { provider: 'inherit', access: 'read', artifacts: 'all', prompt: 'inherit:reviewer' } }
    await runAgentRuntimeInvocation({ ...options(), engineVersion: 2, prepareDefinition: definition, loopConfig: recipe, providerOverride: { provider: 'kimi' } })
    const config = JSON.parse(readFileSync(join(root, 'state', 'desktop-runtime-config.json'), 'utf8'))
    expect(config.rolePrompts.architect).toBe('Global architect override')
    expect(config.rolePrompts.reviewer).toBe('Factory reviewer')
    expect(config.roles.plan.prompt).toBe('Factory reviewer')
    expect(JSON.stringify(config)).not.toContain('"inherit:')
  })
  it('freezes loop agents independently of project/global prompts and resumes the original snapshot', async () => {
    fixture.v2 = true
    script(`console.log(JSON.stringify(${JSON.stringify(v2())}));`)
    saveRuntimeRolePrompts({ architect: 'Unrelated global instructions' })
    const recipe = defaultLoopAgents()
    recipe.agents.developer = { provider: 'codex', model: 'loop-model' }
    recipe.rolePrompts!.architect = 'The loop owns this definition'
    const originalProject = readFileSync(options().configPath, 'utf8')
    await runAgentRuntimeInvocation({ ...options(), engineVersion: 2, prepareDefinition: definition, loopConfig: recipe, providerOverride: { provider: 'kimi', model: 'mission-model', effort: 'high' } })
    const filename = join(root, 'state', 'desktop-runtime-config.json')
    const frozen = readFileSync(filename, 'utf8'), config = JSON.parse(frozen)
    expect(config.agents.developer).toEqual(recipe.agents.developer)
    expect(config.agents.architect).toMatchObject({ provider: 'kimi', model: 'mission-model', effort: 'high' })
    expect(config.agents.reviewer.provider).toBe('kimi')
    expect(config.fixer.provider).toBe('kimi')
    expect(config.roles['loop-decider'].provider).toBe('kimi')
    expect(config.rolePrompts.architect).toBe('The loop owns this definition')
    expect(config.verification).toEqual([{ repositoryId: 'front', command: 'npm', args: ['test'] }])
    expect(readFileSync(options().configPath, 'utf8')).toBe(originalProject)
    expect(JSON.parse(readFileSync(join(root, 'state', 'desktop-runtime-selection.json'), 'utf8')).origins.developer).toBe('loop-role')
    recipe.rolePrompts!.architect = 'A later edit'
    writeFileSync(options().configPath, 'invalid later project settings')
    expect((await runAgentRuntimeInvocation({ ...options(), engineVersion: 2, resume: true })).failed).toBe(false)
    expect(readFileSync(filename, 'utf8')).toBe(frozen)
    await expect(runAgentRuntimeInvocation({ ...options(), resume: true, loopConfig: recipe })).rejects.toThrow('frozen')
  })
  it('does not manufacture a missing decision agent for a loop-owned recipe', async () => {
    fixture.v2 = true
    const recipe = defaultLoopAgents()
    delete recipe.roles
    await expect(runAgentRuntimeInvocation({ ...options(), engineVersion: 2, prepareDefinition: () => ({ ...definition(), roles: ['loop-decider'] }), loopConfig: recipe })).rejects.toThrow('loop must define its loop-decider')
  })
  it('freezes an explicit workflow decision engine and refuses to replace it during resume', async () => {
    fixture.v2 = true
    script(`console.log(JSON.stringify(${JSON.stringify(v2())}));`)
    const bindings = { 'converted-decider': { provider: 'claude', model: 'selected-decision-model', access: 'read' as const, artifacts: 'none' as const } }
    const prepared = vi.fn(() => ({ ...definition(), roles: ['converted-decider'] }))
    // Migrate the legacy fixture's connection fields before comparing writes.
    loadRuntimeConfigFile(options().configPath)
    const source = readFileSync(options().configPath, 'utf8')
    await runAgentRuntimeInvocation({ ...options(), engineVersion: 2, prepareDefinition: prepared, workflowRoleBindings: bindings })
    const file = join(root, 'state', 'desktop-runtime-config.json'), frozen = readFileSync(file, 'utf8')
    expect(JSON.parse(frozen).roles['converted-decider']).toEqual(bindings['converted-decider'])
    expect(prepared).toHaveBeenCalledWith(expect.objectContaining({ roles: bindings }))
    expect(JSON.parse(readFileSync(join(root, 'state', 'desktop-runtime-selection.json'), 'utf8')).origins['converted-decider']).toBe('explicit-workflow-selection')
    expect(readFileSync(options().configPath, 'utf8')).toBe(source)
    await expect(runAgentRuntimeInvocation({ ...options(), engineVersion: 2, resume: true, workflowRoleBindings: bindings })).rejects.toThrow('frozen workflow definition and role bindings')
    writeFileSync(options().configPath, 'later invalid project configuration')
    expect((await runAgentRuntimeInvocation({ ...options(), engineVersion: 2, resume: true })).failed).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(frozen)
  })
  it('validates against frozen project config and passes only canonical definition; resume retains it',async()=>{
    fixture.v2=true
    script(`import{readFileSync}from'node:fs';const i=process.argv.indexOf('--definition');if(i>=0&&JSON.parse(readFileSync(process.argv[i+1],'utf8')).version!=='hash-v1')process.exit(9);console.log(JSON.stringify(${JSON.stringify(v2())}));`)
    const prepared=vi.fn(definition)
    const result=await runAgentRuntimeInvocation({...options(),engineVersion:2,prepareDefinition:prepared})
    expect(result).toMatchObject({runtimeStatus:'succeeded',completion:{ok:true,verified:false},durationMs:1234,failed:false})
    expect(fixture.validation).toEqual([{configPath:join(root,'state','desktop-runtime-config.json'),structural:false}])
    expect(prepared).toHaveBeenCalledWith(expect.objectContaining({agents:expect.any(Object)}))
    const file=join(root,'state','desktop-workflow-definition.json'), frozen=readFileSync(file,'utf8')
    writeFileSync(options().configPath,'changed')
    expect((await runAgentRuntimeInvocation({...options(),engineVersion:2,resume:true})).failed).toBe(false)
    expect(readFileSync(file,'utf8')).toBe(frozen);expect(fixture.validation).toHaveLength(1)
  })
  it('rejects an undeclared launch role before freezing host files or spawning Core', async () => {
    fixture.v2 = true
    const onSpawn = vi.fn()
    await expect(runAgentRuntimeInvocation({ ...options(), engineVersion: 2, prepareDefinition: definition, onSpawn,
      workflowRoleBindings: { 'not-declared': { provider: 'claude', access: 'read', artifacts: 'none' } },
    })).rejects.toThrow('declared custom roles')
    expect(onSpawn).not.toHaveBeenCalled()
    expect(() => readFileSync(join(root, 'state', 'desktop-runtime-host.json'))).toThrow()
    expect(() => readFileSync(join(root, 'state', 'desktop-runtime-config.json'))).toThrow()
  })
  it.each([
    { ok: false, verified: true, requiresVerified: false },
    { ok: true, verified: false, requiresVerified: true },
  ])('rejects a successful exit without the frozen completion policy: %j', async policy => {
    fixture.v2 = true
    script(`console.log(JSON.stringify(${JSON.stringify(v2('succeeded', { completion: { ok: policy.ok, verified: policy.verified, reasons: [] } }))}));`)
    const result = await runAgentRuntimeInvocation({ ...options(), engineVersion: 2,
      prepareDefinition: () => ({ ...definition(), delivery: { requiresVerified: policy.requiresVerified } }),
    })
    expect(result).toMatchObject({ failed: true, runtimeStatus: 'blocked', errorText: expect.stringContaining('acceptance') })
  })
  it('fails unsupported/invalid definitions before spawning',async()=>{
    const onSpawn=vi.fn()
    await expect(runAgentRuntimeInvocation({...options(),engineVersion:2,prepareDefinition:definition,onSpawn})).rejects.toThrow('engine_unsupported')
    fixture.v2=true;fixture.invalid=true
    await expect(runAgentRuntimeInvocation({...options(),engineVersion:2,prepareDefinition:definition,onSpawn})).rejects.toThrow('definition_invalid')
    expect(onSpawn).not.toHaveBeenCalled()
  })
  it('accepts exit two as a recoverable pause and threads explicit interrupt approval',async()=>{
    fixture.v2=true
    script(`console.log(JSON.stringify(${JSON.stringify(v2('paused',{pendingInterrupts:[{id:'approval1',nodePath:'archive',kind:'approval'}]}))}));process.exitCode=2;`)
    expect(await runAgentRuntimeInvocation({...options(),engineVersion:2,prepareDefinition:definition})).toMatchObject({runtimeStatus:'paused',failed:false,pendingInterrupts:[{id:'approval1'}]})
    let args:string[]=[]
    script(`console.log(JSON.stringify(${JSON.stringify(v2())}));`)
    await runAgentRuntimeInvocation({...options(),engineVersion:2,resume:true,approve:['approval1'],interruptId:'approval1',onSpawn:child=>{args=child.spawnargs}})
    expect(args).toEqual(expect.arrayContaining(['--approve','approval1','--interrupt-id','approval1']))
  })
  it('rejects success without acceptance evidence, contradictory exit, cross-run events and failed durable observers',async()=>{
    fixture.v2=true
    writeFileSync(join(root, 'state', 'desktop-workflow-definition.json'), JSON.stringify(definition()))
    for(const [frame,code]of [[final(),0],[v2(),1],[v2('succeeded',{runId:'other'}),0]] as const){
      script(`console.log(JSON.stringify(${JSON.stringify(frame)}));process.exitCode=${code};`)
      expect((await runAgentRuntimeInvocation({...options(),engineVersion:2,resume:true})).runtimeStatus).toBe('failed')
    }
    script(`console.log(JSON.stringify(${JSON.stringify(v2())}));`)
    expect(await runAgentRuntimeInvocation({...options(),engineVersion:2,resume:true,onRuntimeEvent:()=>{throw new Error('database unavailable')}})).toMatchObject({runtimeStatus:'failed',errorText:'database unavailable'})
  })
})

it('excludes host checks configured for unselected registered workspaces', () => {
  const repositories = [{ id: 'skills', scope: ['studio'], registeredScope: ['studio', 'service'] }]
  expect(scopedHostChecks([{ repositoryId: 'skills', cwd: 'studio', key: 'studio-tests' }, { repositoryId: 'skills', cwd: 'service', key: 'service-tests' }], repositories)).toEqual([{ repositoryId: 'skills', cwd: 'studio', key: 'studio-tests' }])
})
