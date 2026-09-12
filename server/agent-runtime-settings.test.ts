import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerAgentRuntimeSettingsRoutes } from './agent-runtime-settings-router'
import { agentRuntimeConfigPath, defaultAgentRuntimeConfig, loadAgentRuntimeConfig, saveAgentRuntimeConfig, validateAgentRuntimeConfig, type RuntimeConfig } from './agent-runtime-settings'

const loader = vi.hoisted(() => ({ entry: 'runtime/index.js' as string | null, validate: vi.fn((input: unknown) => input), loadFailure: false }))
const layout = vi.hoisted(() => ({ suffix: '.specrails' }))
vi.mock('./agent-runtime-loader', () => ({ findCoreAgentRuntimeEntry: () => loader.entry, loadCoreAgentRuntime: async () => {
  if (loader.loadFailure) throw new Error('incompatible Core')
  return { validateRuntimeConfig: loader.validate }
} }))
vi.mock('./workspace-resolution', () => ({ resolveProjectExecution: (project: { path: string }) => ({ specrailsDir: path.join(project.path, layout.suffix) }) }))

let directory: string
let app: express.Express
const project = () => ({ id: 'example', path: directory, slug: 'example', provider: 'kimi' })
const config = (): RuntimeConfig => defaultAgentRuntimeConfig(project())
const enabledConfig = (): RuntimeConfig => ({ ...config(), enabled: true, verification: [{ repositoryId: 'primary-example', command: 'npm', args: ['test'] }] })
const url = '/api/projects/example/agent-runtime/config'
beforeEach(() => {
  vi.clearAllMocks(); loader.entry = 'runtime/index.js'; loader.loadFailure = false; layout.suffix = '.specrails'
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-settings-'))
  app = express(); app.use(express.json())
  const router = express.Router()
  registerAgentRuntimeSettingsRoutes({ router, ctx: () => ({ project: project() }) as never })
  app.use('/api/projects', router)
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }) })

describe('runtime project configuration', () => {
  it('reads absent settings without creating files or loading a provider', async () => {
    const response = await request(app).get(url).expect(200)
    expect(response.body).toMatchObject({ configured: false, runtimeAvailable: true, config: { enabled: false, agents: { architect: { provider: 'kimi' } } } })
    expect(response.body.config.providers.map((p: { cli: string }) => p.cli)).toEqual(['claude', 'codex', 'gemini', 'kimi'])
    expect(fs.readdirSync(directory)).toEqual([])
    expect(loader.validate).not.toHaveBeenCalled()
    expect(loadAgentRuntimeConfig(project())).toBeNull()
    expect(defaultAgentRuntimeConfig({ path: directory, provider: 'unknown' }).agents.developer.provider).toBe('claude')
  })

  it('persists local providers and arbitrary future models without retrieving credentials', async () => {
    const payload = config()
    payload.enabled = true
    payload.providers.push({ id: 'local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', apiKeyEnv: 'LOCAL_AI_KEY' })
    payload.agents.developer = { provider: 'local', model: 'my-local-model:latest', maxTurns: 8 }
    payload.limits = { maxAttempts: 3, maxTokens: 20000, timeoutMs: 60000, maxCostUsd: 2.5 }
    payload.verification = [{ repositoryId: 'primary-example', command: 'npm', args: ['test'], cwd: 'client', env: { CI: 'true' }, timeoutMs: 10000 }]
    payload.approvalBeforeArchive = true
    const response = await request(app).put(url).send(payload).expect(200)
    expect(response.body).toEqual({ configured: true, runtimeAvailable: true, config: payload })
    expect(loader.validate).toHaveBeenCalledWith(payload)
    expect(loadAgentRuntimeConfig(project())).toEqual(payload)
    expect(fs.readdirSync(path.dirname(agentRuntimeConfigPath(project())))).toEqual(['agent-runtime.json'])
    const read = await request(app).get(url).expect(200)
    expect(read.body.config).toEqual(payload)
  })

  it('supports offline disabled configuration and rejects enabling missing or incompatible Core without overwriting it', async () => {
    loader.entry = null
    await request(app).put(url).send(config()).expect(200)
    expect(loader.validate).not.toHaveBeenCalled()
    const before = fs.readFileSync(agentRuntimeConfigPath(project()), 'utf8')
    await request(app).put(url).send(enabledConfig()).expect(503).expect(({ body }) => expect(body.error).toBe('runtime_unavailable'))
    expect(fs.readFileSync(agentRuntimeConfigPath(project()), 'utf8')).toBe(before)
    loader.entry = 'runtime/index.js'; loader.loadFailure = true
    await request(app).put(url).send(enabledConfig()).expect(503).expect(({ body }) => expect(body.error).toBe('runtime_incompatible'))
    expect(fs.readFileSync(agentRuntimeConfigPath(project()), 'utf8')).toBe(before)
    await request(app).put(url).send(config()).expect(200)
    expect(loadAgentRuntimeConfig(project())?.enabled).toBe(false)
  })

  it('enables the runtime without any verification command: the architect proposes checks at run time', async () => {
    const result = await request(app).put(url).send({ ...config(), enabled: true }).expect(200)
    expect(result.body.config).toMatchObject({ enabled: true, verification: [] })
    expect(loader.validate).toHaveBeenCalledOnce()
    expect(loadAgentRuntimeConfig(project())).toMatchObject({ enabled: true, verification: [] })
    loader.entry = null
    await request(app).put(url).send({ ...config(), enabled: false }).expect(200)
    expect(loadAgentRuntimeConfig(project())?.enabled).toBe(false)
  })

  it('suggests each repository\'s own checks offline, without a model call or writing configuration', async () => {
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'example', scripts: { test: 'vitest run', typecheck: 'tsc --noEmit', build: 'tsc' } }))
    fs.writeFileSync(path.join(directory, 'pnpm-lock.yaml'), '')
    const response = await request(app).get('/api/projects/example/agent-runtime/verification-suggestions').expect(200)
    expect(response.body.repositories).toEqual([{ id: 'primary-example', name: 'example' }].map((entry) => ({ ...entry, name: expect.any(String) })))
    expect(response.body.suggestions).toEqual([
      { repositoryId: 'primary-example', command: 'pnpm', args: ['test'], reason: 'package.json test script "test"' },
      { repositoryId: 'primary-example', command: 'pnpm', args: ['run', 'typecheck'], reason: 'package.json type check script "typecheck"' },
    ])
    expect(loader.validate).not.toHaveBeenCalled()
    expect(fs.existsSync(agentRuntimeConfigPath(project()))).toBe(false)
  })

  it.each([
    ['wrong version', (c: any) => { c.schemaVersion = 2 }],
    ['unknown field', (c: any) => { c.apiKey = 'sensitive-submitted-value' }],
    ['provider credentials', (c: any) => { c.providers = [{ id: 'local', kind: 'openai-compatible', baseUrl: 'https://user:sensitive-submitted-value@host/v1' }] }],
    ['URL query credential', (c: any) => { c.providers.push({ id: 'api', kind: 'openai-compatible', baseUrl: 'https://host/v1?key=sensitive-submitted-value' }) }],
    ['invalid URL', (c: any) => { c.providers.push({ id: 'api', kind: 'openai-compatible', baseUrl: 'http://' }) }],
    ['URL NUL', (c: any) => { c.providers.push({ id: 'api', kind: 'openai-compatible', baseUrl: 'http://host/\0' }) }],
    ['bad environment name', (c: any) => { c.providers.push({ id: 'api', kind: 'openai-compatible', baseUrl: 'http://host', apiKeyEnv: 'sensitive-submitted-value' }) }],
    ['duplicate IDs', (c: any) => { c.providers.push(c.providers[0]) }],
    ['unknown provider', (c: any) => { c.agents.architect.provider = 'missing' }],
    ['missing API model', (c: any) => { c.providers.push({ id: 'local', kind: 'openai-compatible', baseUrl: 'http://host' }); c.agents.developer.provider = 'local' }],
    ['empty model', (c: any) => { c.agents.developer.model = '  ' }],
    ['model option injection', (c: any) => { c.agents.developer.model = '--dangerous' }],
    ['negative budget', (c: any) => { c.limits = { maxTokens: -1 } }],
    ['unsafe integer budget', (c: any) => { c.limits = { maxTokens: Number.MAX_SAFE_INTEGER + 1 } }],
    ['unsafe turns', (c: any) => { c.agents.developer.maxTurns = Number.MAX_SAFE_INTEGER + 1 }],
    ['empty command', (c: any) => { c.verification = [{ repositoryId: 'primary', command: ' ', args: [] }] }],
    ['empty cwd', (c: any) => { c.verification = [{ repositoryId: 'primary', command: 'npm', args: [], cwd: ' ' }] }],
    ['unsafe timeout', (c: any) => { c.verification = [{ repositoryId: 'primary', command: 'npm', args: [], timeoutMs: Number.MAX_SAFE_INTEGER + 1 }] }],
    ['NUL argument', (c: any) => { c.verification = [{ repositoryId: 'primary', command: 'npm', args: ['\0'] }] }],
    ['saved verification secret', (c: any) => { c.verification = [{ repositoryId: 'primary', command: 'npm', args: [], env: { API_KEY: 'sensitive-submitted-value' } }] }],
    ['NUL environment', (c: any) => { c.verification = [{ repositoryId: 'primary', command: 'npm', args: [], env: { CI: '\0' } }] }],
    ['loosened review score', (c: any) => { c.review = { minScore: 69 } }],
    ['loosened security aspect', (c: any) => { c.review = { aspects: { security: 74 } } }],
    ['loosened coverage aspect', (c: any) => { c.review = { aspects: { test_coverage: 59.5 } } }],
    ['review score above 100', (c: any) => { c.review = { minScore: 101 } }],
    ['unknown review aspect', (c: any) => { c.review = { aspects: { vibes: 90 } } }],
    ['unknown low-confidence policy', (c: any) => { c.architect = { onLowConfidence: 'guess' } }],
  ])('rejects %s and preserves the last valid file', async (_name, mutate) => {
    saveAgentRuntimeConfig(project(), config())
    const before = fs.readFileSync(agentRuntimeConfigPath(project()), 'utf8')
    const invalid = config(); mutate(invalid)
    const response = await request(app).put(url).send(invalid).expect(400)
    expect(response.body.error).toBe('invalid_runtime_config')
    expect(JSON.stringify(response.body)).not.toContain('sensitive-submitted-value')
    expect(fs.readFileSync(agentRuntimeConfigPath(project()), 'utf8')).toBe(before)
  })

  it('uses the relocated artifact root and cleans temporary files after failed replacement', async () => {
    layout.suffix = 'workspace/.specrails'
    const payload = config()
    saveAgentRuntimeConfig(project(), payload)
    const file = agentRuntimeConfigPath(project())
    expect(file).toBe(path.join(directory, 'workspace', '.specrails', 'agent-runtime.json'))
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('locked on Windows') })
    await request(app).put(url).send(enabledConfig()).expect(500)
    expect(loadAgentRuntimeConfig(project())).toEqual(payload)
    expect(fs.readdirSync(path.dirname(file))).toEqual(['agent-runtime.json'])
  })

  it('fails closed on corrupt saved JSON and reports read errors without file content', async () => {
    const file = agentRuntimeConfigPath(project())
    fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, '{sensitive-submitted-value')
    await request(app).get(url).expect(422).expect(({ body }) => expect(body.message).not.toContain('sensitive-submitted-value'))
    fs.unlinkSync(file); fs.mkdirSync(file)
    await request(app).get(url).expect(500).expect(({ body }) => expect(body.error).toBe('runtime_config_read_failed'))
  })

  it('accepts review thresholds that tighten Core\'s gate and the architect low-confidence policy', async () => {
    const payload: RuntimeConfig = { ...config(), review: { minScore: 70, aspects: { security: 75, type_correctness: 60, pattern_adherence: 80, test_coverage: 60, architectural_alignment: 100 } }, architect: { onLowConfidence: 'proceed' } }
    const response = await request(app).put(url).send(payload).expect(200)
    expect(response.body.config).toEqual(payload)
    expect(loadAgentRuntimeConfig(project())).toEqual(payload)
    expect(validateAgentRuntimeConfig({ ...config(), review: {}, architect: {} })).toMatchObject({ review: {}, architect: {} })
    expect(() => validateAgentRuntimeConfig({ ...config(), review: { minScore: 69.9 } })).toThrow('review.minScore must be at least 70 (Core\'s own review gate)')
    expect(() => validateAgentRuntimeConfig({ ...config(), review: { aspects: { security: 70 } } })).toThrow('review.aspects.security must be at least 75')
  })

  it('returns isolated validated config values and rejects nonobjects', () => {
    const input = config(); const validated = validateAgentRuntimeConfig(input)
    validated.agents.architect.provider = 'codex'
    expect(input.agents.architect.provider).toBe('kimi')
    expect(() => validateAgentRuntimeConfig(null)).toThrow('Invalid runtime configuration')
  })

  const coreSchema = path.resolve(__dirname, '../../specrails-core/schemas/agent-runtime.schema.json')
  it.skipIf(!fs.existsSync(coreSchema))('keeps the vendored schema identical to the neighboring Core source', () => {
    expect(JSON.parse(fs.readFileSync(path.join(__dirname, 'schemas/agent-runtime.schema.json'), 'utf8'))).toEqual(JSON.parse(fs.readFileSync(coreSchema, 'utf8')))
  })
})
