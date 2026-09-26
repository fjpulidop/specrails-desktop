import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
import { join } from 'node:path'
const fixture = vi.hoisted(() => ({ cli: null as string | null, node: null as string | null, v2: false, invalid: false, validation: [] as unknown[] }))
vi.mock('./agent-runtime-loader', () => ({ validateRequestedRoleEfforts: vi.fn(), findCoreAgentRuntimeCli: () => fixture.cli, loadCoreAgentRuntime: async () => ({ api: { capabilities: fixture.v2 ? { engineV2: 1, workflowDefinitions: 1 } : {} }, validateWorkflowDefinition: (value: unknown, options: unknown) => { fixture.validation.push(options); return fixture.invalid ? {ok:false,errors:[{path:'/entry',message:'missing node'}]} : {ok:true,version:'hash-v1',definition:{...value as object,version:'hash-v1'},graph:{nodes:[]}} }, validateRuntimeConfig: (value: unknown) => value, rolePromptDefaults: () => ({ architect: 'Factory architect', developer: 'Factory developer', reviewer: 'Factory reviewer' }) }) }))
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
  fixture.v2 = false; fixture.invalid = false; fixture.validation = []
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
      { repositoryId: 'courses', command: 'yarn', args: ['root'], cwd: '..' },
      { repositoryId: 'api', command: 'npm', args: ['test'] },
    ], repositories).map(check => check.cwd)).toEqual(['apps/busuu-courses', 'apps/busuu-courses/src', 'apps/busuu-courses/playwright', 'apps', undefined])
    expect(scopedHostChecks([{ repositoryId: 'courses', command: 'yarn', args: ['test'] }])).toEqual([{ repositoryId: 'courses', command: 'yarn', args: ['test'] }])
  })

  it('freezes the scoped cwd into the configuration Core receives', async () => {
    writeFileSync(contextPath, JSON.stringify({ runId: 'run-1', repositories: [{ id: 'front', scope: ['apps/web'] }] }))
    script(`console.log(JSON.stringify(${JSON.stringify(final())}));`)
    expect((await runAgentRuntimeInvocation(options())).failed).toBe(false)
    const frozen = JSON.parse(readFileSync(join(root, 'state', 'desktop-runtime-config.json'), 'utf8'))
    expect(frozen.verification).toEqual([{ repositoryId: 'front', command: 'npm', args: ['test'], cwd: 'apps/web' }])
  })
})

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


describe('Core definition process bridge', () => {
  const definition = () => ({schemaVersion:1,id:'authored',entry:'finish',nodes:{finish:{kind:'end',params:{outcome:'success'},ends:{}}}})
  const v2 = (status='succeeded',more:object={}) => final(status,{engineVersion:2,completion:{ok:true,verified:false,reasons:[]},usage:{durationMs:1234},...more})
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
