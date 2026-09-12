import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
import { join } from 'node:path'
const fixture = vi.hoisted(() => ({ cli: null as string | null, node: null as string | null }))
vi.mock('./agent-runtime-loader', () => ({ findCoreAgentRuntimeCli: () => fixture.cli, loadCoreAgentRuntime: async () => ({ rolePromptDefaults: () => ({ architect: 'Factory architect', developer: 'Factory developer', reviewer: 'Factory reviewer' }) }) }))
vi.mock('./path-resolver', () => ({ resolveBundledNodeExe: () => fixture.node }))
import { loadRuntimeConfigFile, saveRuntimeRolePrompts } from './agent-runtime-settings'
import { runAgentRuntimeInvocation, runtimeChangeName } from './agent-runtime-bridge'

let root: string, contextPath: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'runtime bridge with spaces '))
  vi.spyOn(os, 'homedir').mockImplementation(() => join(root, 'home'))
  contextPath = join(root, 'state', 'desktop-context.json')
  mkdirSync(join(root, 'state'))
  writeFileSync(contextPath, JSON.stringify({ runId: 'run-1', repositories: [{ id: 'front' }] }))
  writeFileSync(join(root, 'config.json'), JSON.stringify({ schemaVersion: 1, enabled: true, providers: [{ id: 'claude', kind: 'cli', cli: 'claude' }], agents: { architect: { provider: 'claude' }, developer: { provider: 'claude' }, reviewer: { provider: 'claude' } }, verification: [{ repositoryId: 'front', command: 'npm', args: ['test'] }, { repositoryId: 'back', command: './mvnw', args: ['test'] }] }))
  fixture.cli = join(root, 'cli.mjs')
})
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); fixture.cli = null })
const options = () => ({ contextPath, cwd: root, env: { ...process.env, SPECRAILS_GIT_AUTO: 'false', API_SECRET: 'never-store-this' }, configPath: join(root, 'config.json'), change: 'test-change', timeoutMs: 3000 })
function script(code: string) { writeFileSync(fixture.cli!, code) }
function final(status = 'succeeded', overrides: object = {}) { return { type: 'runtime-result', runId: 'run-1', status, invocationUsage: { costUsd: null, inputTokens: 12, outputTokens: 4 }, ...overrides } }

describe('Core process bridge', () => {
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
    expect((await runAgentRuntimeInvocation({ ...options(), defaultProvider: 'codex', selectedModel: 'gpt-5.6-sol', onLine })).failed).toBe(false)
    const frozen = JSON.parse(readFileSync(join(root, 'state', 'desktop-runtime-config.json'), 'utf8'))
    for (const role of Object.values(frozen.agents)) expect(role).toMatchObject({ provider: 'codex', model: 'gpt-5.6-sol' })
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
