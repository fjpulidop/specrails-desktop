import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const fixture = vi.hoisted(() => ({ cli: null as string | null, node: null as string | null }))
vi.mock('./agent-runtime-loader', () => ({ findCoreAgentRuntimeCli: () => fixture.cli }))
vi.mock('./path-resolver', () => ({ resolveBundledNodeExe: () => fixture.node }))
import { runAgentRuntimeInvocation, runtimeChangeName, selectAgentRuntime } from './agent-runtime-bridge'

let root: string, contextPath: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'runtime bridge with spaces '))
  contextPath = join(root, 'state', 'desktop-context.json')
  mkdirSync(join(root, 'state'))
  writeFileSync(contextPath, JSON.stringify({ runId: 'run-1' }))
  fixture.cli = join(root, 'cli.mjs')
})
afterEach(() => { rmSync(root, { recursive: true, force: true }); fixture.cli = null })
const options = () => ({ contextPath, cwd: root, env: { ...process.env, SPECRAILS_GIT_AUTO: 'false', API_SECRET: 'never-store-this' }, configPath: join(root, 'config.json'), change: 'test-change', timeoutMs: 3000 })
function script(code: string) { writeFileSync(fixture.cli!, code) }
function final(status = 'succeeded', overrides: object = {}) { return { type: 'runtime-result', runId: 'run-1', status, invocationUsage: { costUsd: null, inputTokens: 12, outputTokens: 4 }, ...overrides } }

describe('Core process bridge', () => {
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
  it('exposes pending approval without claiming success', async () => {
    script(`console.log(JSON.stringify(${JSON.stringify(final('paused'))}));process.exitCode=2;`)
    expect(await runAgentRuntimeInvocation(options())).toMatchObject({ failed: true, errorText: expect.stringContaining('approval') })
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
    const file = join(root, 'config.json')
    expect(selectAgentRuntime(file)).toBe(false)
    const config = { schemaVersion: 1, enabled: false, providers: [{ id: 'claude', kind: 'cli', cli: 'claude' }], agents: { architect: { provider: 'claude' }, developer: { provider: 'claude' }, reviewer: { provider: 'claude' } }, verification: [] }
    writeFileSync(file, JSON.stringify(config))
    expect(selectAgentRuntime(file)).toBe(false)
    writeFileSync(join(root, 'state', 'agent-runtime-request.json'), '{}')
    expect(selectAgentRuntime(file, contextPath)).toBe(true)
    writeFileSync(file, 'bad JSON')
    expect(() => selectAgentRuntime(file)).toThrow()
    expect(runtimeChangeName('RUN/with spaces')).toMatch(/^runtime-[a-f0-9]{20}$/)
    expect(runtimeChangeName('same')).toBe(runtimeChangeName('same'))
  })
})
