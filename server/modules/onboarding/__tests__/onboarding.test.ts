import fs from 'fs'
import os from 'os'
import path from 'path'
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SAMPLE_LOOP_ID, SAMPLE_RUN_CAP_USD, SampleError, cheapestModel, chooseSamplePreset, firstFreeName, isStrictlyInside, normalizeSampleLocale,
  type PresetProviderCandidate, type SampleRecord,
} from '../domain'
import { createSample, currentSample, removeSample, type SampleDeps } from '../application'
import { SAMPLE_CATALOG, TIC_TAC_TOE } from '../catalog'
import { createSampleFiles, createSampleGit, createSampleSpecs, createSampleState } from '../adapters/runtime'
import { registerOnboardingRoutes } from '../adapters/http'
import { readStore, resolveTicketStoragePath } from '../../specs/runtime/ticket-store'

const claude = (over: Partial<PresetProviderCandidate> = {}): PresetProviderCandidate => ({
  id: 'claude', local: false, usable: true, authState: 'authenticated', defaultModel: 'sonnet',
  models: [{ value: 'sonnet', priceUsdPer1M: 12 }, { value: 'haiku', priceUsdPer1M: 6 }, { value: 'opus', priceUsdPer1M: 24 }, { value: 'fable', priceUsdPer1M: 60 }],
  ...over,
})
const codex = (over: Partial<PresetProviderCandidate> = {}): PresetProviderCandidate => ({
  id: 'codex', local: false, usable: true, authState: 'authenticated', defaultModel: 'gpt-6.1-sol',
  models: [{ value: 'gpt-5.6-sol', priceUsdPer1M: 35 }, { value: 'gpt-5.6-luna', priceUsdPer1M: 7 }],
  ...over,
})
const localEngine = (over: Partial<PresetProviderCandidate> = {}): PresetProviderCandidate => ({
  id: 'local-lan', local: true, usable: true, authState: 'unknown', defaultModel: 'qwen', models: [{ value: 'qwen3-coder', priceUsdPer1M: null }], ...over,
})

describe('sample launch preset', () => {
  it('applies Quick SDD, the cheapest model and the per-run soft cap', () => {
    const verdict = chooseSamplePreset([claude()])
    expect(verdict).toMatchObject({ ready: true, localPreset: null, preset: { provider: 'claude', model: 'haiku', local: false, loopId: SAMPLE_LOOP_ID, runCapUsd: SAMPLE_RUN_CAP_USD } })
    expect(SAMPLE_LOOP_ID).toBe('factory:sdd-quick-openspec')
  })

  it('picks the cheapest ready cloud provider and ignores unusable or signed-out ones', () => {
    expect(chooseSamplePreset([claude(), codex()])).toMatchObject({ preset: { provider: 'claude', model: 'haiku' } })
    expect(chooseSamplePreset([claude({ authState: 'unauthenticated' }), codex()])).toMatchObject({ preset: { provider: 'codex', model: 'gpt-5.6-luna' } })
    expect(chooseSamplePreset([claude({ usable: false }), codex()])).toMatchObject({ preset: { provider: 'codex' } })
  })

  it('falls back to the provider default when no model is priced', () => {
    expect(cheapestModel(claude({ models: [{ value: 'x', priceUsdPer1M: null }] }))).toBe('sonnet')
  })

  it('offers a configured local engine without a cap, alongside or instead of the cloud preset', () => {
    const both = chooseSamplePreset([claude(), localEngine()])
    expect(both).toMatchObject({ ready: true, preset: { provider: 'claude' }, localPreset: { provider: 'local-lan', model: 'qwen3-coder', local: true, runCapUsd: null } })
    const only = chooseSamplePreset([localEngine()])
    expect(only).toMatchObject({ ready: true, preset: { provider: 'local-lan', local: true, runCapUsd: null }, localPreset: null })
  })

  it('reports not ready, with the reason, when nothing can run', () => {
    expect(chooseSamplePreset([])).toEqual({ ready: false, reason: 'no_provider', preset: null, localPreset: null })
    expect(chooseSamplePreset([claude({ usable: false })])).toMatchObject({ ready: false, reason: 'no_provider' })
    expect(chooseSamplePreset([claude({ authState: 'unauthenticated' })])).toMatchObject({ ready: false, reason: 'not_signed_in' })
  })
})

describe('domain helpers', () => {
  it('normalizes locales and finds the first free folder name', () => {
    expect(normalizeSampleLocale('pt-BR')).toBe('pt')
    expect(normalizeSampleLocale('xx')).toBe('en')
    expect(normalizeSampleLocale(undefined)).toBe('en')
    const taken = new Set(['a', 'a-2'])
    expect(firstFreeName('a', (c) => taken.has(c))).toBe('a-3')
    expect(firstFreeName('a', () => true, 3)).toBeNull()
    expect(isStrictlyInside('/home/u', '/home/u/x', '/')).toBe(true)
    expect(isStrictlyInside('/home/u', '/home/u', '/')).toBe(false)
    expect(isStrictlyInside('/home/u', '/home/user2/x', '/')).toBe(false)
  })

  it('ships three specs with every locale', () => {
    expect(TIC_TAC_TOE.specs).toHaveLength(3)
    for (const spec of TIC_TAC_TOE.specs) {
      for (const locale of ['en', 'es', 'fr', 'de', 'pt', 'it', 'zh', 'ja'] as const) {
        expect(spec.text[locale].title.length).toBeGreaterThan(3)
        expect(spec.text[locale].summary.length).toBeGreaterThan(3)
        expect(spec.text[locale].description.length).toBeGreaterThan(20)
      }
    }
    expect(Object.keys(TIC_TAC_TOE.files)).toEqual(expect.arrayContaining(['index.html', 'game.js', 'logic.js', 'package.json']))
  })
})

// ─── Application over the real adapters, in a temporary home ────────────────

let home: string
let registered: Map<string, { id: string; name: string; path: string }>
let settings: Map<string, string>
let deps: SampleDeps

function makeDeps(): SampleDeps {
  return {
    samples: SAMPLE_CATALOG,
    files: createSampleFiles(() => home),
    git: createSampleGit(),
    specs: createSampleSpecs(() => new Date('2026-10-25T10:00:00Z')),
    state: createSampleState({ get: (k) => settings.get(k), set: (k, v) => { settings.set(k, v) } }),
    projects: {
      register: ({ path: p, name }) => { const ref = { id: `p-${registered.size + 1}`, name, path: p }; registered.set(ref.id, ref); return ref },
      unregister: (id) => { registered.delete(id) },
      isRegistered: (id) => registered.has(id),
      get: (id) => registered.get(id) ?? null,
    },
    now: () => new Date('2026-10-25T10:00:00Z'),
  }
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-sample-')))
  registered = new Map()
  settings = new Map()
  deps = makeDeps()
})
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

describe('createSample', () => {
  it('copies the repo, makes one git commit, installs the localized specs and registers the project', async () => {
    const result = await createSample(deps, { sampleId: 'tic-tac-toe', locale: 'es' })
    expect(result.reused).toBe(false)
    expect(result.record.path).toBe(path.join(home, 'Specrails Samples', 'tic-tac-toe'))
    for (const file of Object.keys(TIC_TAC_TOE.files)) expect(fs.existsSync(path.join(result.record.path, file))).toBe(true)

    const { execFileSync } = await import('child_process')
    const git = (...args: string[]) => execFileSync('git', args, { cwd: result.record.path, encoding: 'utf8' }).trim()
    expect(git('rev-list', '--count', 'HEAD')).toBe('1')
    expect(git('branch', '--show-current')).toBe('main')
    expect(git('status', '--porcelain')).toBe('')

    const store = readStore(resolveTicketStoragePath(result.record.path))
    const tickets = Object.values(store.tickets)
    expect(tickets).toHaveLength(3)
    expect(tickets.map((t) => t.title)).toContain('Añadir un botón Reiniciar')
    expect(tickets.every((t) => t.status === 'todo')).toBe(true)
    expect(result.record.specIds).toEqual(tickets.map((t) => t.id))

    expect(registered.get(result.project.id)?.path).toBe(result.record.path)
    expect(currentSample(deps)?.record.projectId).toBe(result.project.id)
    // The spec store is ignored by git, so launching never starts from a dirty tree.
    expect(git('check-ignore', '.specrails/local-tickets.json')).toBe('.specrails/local-tickets.json')
  })

  it('is idempotent: a second run reuses the sample and writes nothing', async () => {
    const first = await createSample(deps, { sampleId: 'tic-tac-toe', locale: 'en' })
    const second = await createSample(deps, { sampleId: 'tic-tac-toe', locale: 'en' })
    expect(second.reused).toBe(true)
    expect(second.project.id).toBe(first.project.id)
    expect(registered.size).toBe(1)
    expect(fs.readdirSync(path.join(home, 'Specrails Samples'))).toEqual(['tic-tac-toe'])
  })

  it('does not overwrite an existing folder: a collision takes the next free name', async () => {
    const taken = path.join(home, 'Specrails Samples', 'tic-tac-toe')
    fs.mkdirSync(taken, { recursive: true })
    fs.writeFileSync(path.join(taken, 'mine.txt'), 'keep')
    const result = await createSample(deps, { sampleId: 'tic-tac-toe', locale: 'en' })
    expect(result.record.path).toBe(`${taken}-2`)
    expect(fs.readFileSync(path.join(taken, 'mine.txt'), 'utf8')).toBe('keep')
  })

  it('refuses an explicit path that exists, or that is outside the home folder', async () => {
    const existing = path.join(home, 'there')
    fs.mkdirSync(existing)
    await expect(createSample(deps, { sampleId: 'tic-tac-toe', locale: 'en', targetPath: existing })).rejects.toMatchObject({ code: 'path_exists', status: 409 })
    await expect(createSample(deps, { sampleId: 'tic-tac-toe', locale: 'en', targetPath: path.join(os.tmpdir(), 'elsewhere-sample') })).rejects.toMatchObject({ code: 'outside_home' })
    await expect(createSample(deps, { sampleId: 'tic-tac-toe', locale: 'en', parentDir: '/etc' })).rejects.toMatchObject({ code: 'outside_home' })
    expect(registered.size).toBe(0)
  })

  it('creates at a user-chosen path inside the home folder', async () => {
    const chosen = path.join(home, 'play', 'my-game')
    const result = await createSample(deps, { sampleId: 'tic-tac-toe', locale: 'en', targetPath: chosen })
    expect(result.record.path).toBe(chosen)
    expect(fs.existsSync(path.join(chosen, '.git'))).toBe(true)
  })

  it('rejects an unknown sample', async () => {
    await expect(createSample(deps, { sampleId: 'nope', locale: 'en' })).rejects.toMatchObject({ code: 'unknown_sample', status: 404 })
  })

  it('rolls everything back when git or registration fails', async () => {
    const failingGit = makeDeps()
    failingGit.git = { initWithCommit: vi.fn().mockRejectedValue(new Error('no git')) }
    await expect(createSample(failingGit, { sampleId: 'tic-tac-toe', locale: 'en' })).rejects.toMatchObject({ code: 'git_failed' })
    expect(fs.existsSync(path.join(home, 'Specrails Samples', 'tic-tac-toe'))).toBe(false)

    const failingRegister = makeDeps()
    failingRegister.projects = { ...failingRegister.projects, register: () => { throw new Error('db locked') } }
    await expect(createSample(failingRegister, { sampleId: 'tic-tac-toe', locale: 'en' })).rejects.toMatchObject({ code: 'register_failed' })
    expect(fs.existsSync(path.join(home, 'Specrails Samples', 'tic-tac-toe'))).toBe(false)
    expect(settings.get('onboarding.sample')).toBeUndefined()
  })

  it('forgets a record whose project was removed by hand and creates a fresh sample', async () => {
    const first = await createSample(deps, { sampleId: 'tic-tac-toe', locale: 'en' })
    registered.delete(first.project.id)
    expect(currentSample(deps)).toBeNull()
    const second = await createSample(deps, { sampleId: 'tic-tac-toe', locale: 'en' })
    expect(second.reused).toBe(false)
    expect(second.record.path).toBe(`${first.record.path}-2`)
  })
})

describe('removeSample', () => {
  it('unregisters but keeps the folder by default', async () => {
    const { record } = await createSample(deps, { sampleId: 'tic-tac-toe', locale: 'en' })
    expect(removeSample(deps, { deleteFolder: false })).toEqual({ removedProject: true, deletedFolder: false })
    expect(registered.size).toBe(0)
    expect(fs.existsSync(record.path)).toBe(true)
    expect(currentSample(deps)).toBeNull()
  })

  it('deletes the folder only when asked', async () => {
    const { record } = await createSample(deps, { sampleId: 'tic-tac-toe', locale: 'en' })
    expect(removeSample(deps, { deleteFolder: true })).toEqual({ removedProject: true, deletedFolder: true })
    expect(fs.existsSync(record.path)).toBe(false)
    expect(fs.existsSync(path.join(home, 'Specrails Samples'))).toBe(true)
  })

  it('never deletes a folder that is not a git repository or is outside the home folder', async () => {
    const { record } = await createSample(deps, { sampleId: 'tic-tac-toe', locale: 'en' })
    fs.rmSync(path.join(record.path, '.git'), { recursive: true, force: true })
    expect(() => removeSample(deps, { deleteFolder: true })).toThrowError(SampleError)
    expect(fs.existsSync(record.path)).toBe(true)
    expect(registered.size).toBe(1)

    const tampered: SampleRecord = { ...record, path: os.tmpdir() }
    settings.set('onboarding.sample', JSON.stringify(tampered))
    expect(() => removeSample(deps, { deleteFolder: true })).toThrowError(/home folder/)
    expect(fs.existsSync(os.tmpdir())).toBe(true)
  })

  it('answers not found when there is no sample', () => {
    expect(() => removeSample(deps, { deleteFolder: false })).toThrowError(/no sample/)
  })
})

describe('HTTP routes', () => {
  function app(providers: PresetProviderCandidate[] | Error) {
    const server = express()
    server.use(express.json())
    const router = express.Router()
    registerOnboardingRoutes(router, {
      ...deps,
      providers: async () => { if (providers instanceof Error) throw providers; return providers },
    })
    server.use('/api', router)
    return server
  }

  it('GET reports the catalog, the default folder and a ready preset with the cost envelope', async () => {
    const res = await request(app([claude()])).get('/api/onboarding/sample')
    expect(res.status).toBe(200)
    expect(res.body.catalog).toEqual([{ id: 'tic-tac-toe', name: 'tic-tac-toe', specCount: 3 }])
    expect(res.body.sample).toBeNull()
    expect(res.body.defaultParentDir).toBe(path.join(home, 'Specrails Samples'))
    expect(res.body.launch).toMatchObject({ ready: true, runCapUsd: 1, estimate: { minutes: [3, 5], usd: [0.3, 1] }, preset: { provider: 'claude', model: 'haiku', loopId: SAMPLE_LOOP_ID, runCapUsd: 1 } })
  })

  it('GET falls back to "not ready" (recorded run) when no provider works or detection fails', async () => {
    const none = await request(app([])).get('/api/onboarding/sample')
    expect(none.body.launch).toMatchObject({ ready: false, reason: 'no_provider', preset: null })
    const broken = await request(app(new Error('probe crashed'))).get('/api/onboarding/sample')
    expect(broken.status).toBe(200)
    expect(broken.body.launch.ready).toBe(false)
  })

  it('POST creates (201), then reuses (200); DELETE removes', async () => {
    const server = app([claude()])
    const created = await request(server).post('/api/onboarding/sample').send({ locale: 'de' })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ reused: false, project: { name: 'tic-tac-toe' }, sample: { sampleId: 'tic-tac-toe' } })
    expect(created.body.sample.specIds).toHaveLength(3)

    const again = await request(server).post('/api/onboarding/sample').send({})
    expect(again.status).toBe(200)
    expect(again.body.reused).toBe(true)

    const status = await request(server).get('/api/onboarding/sample')
    expect(status.body.sample.projectId).toBe(created.body.project.id)

    const removed = await request(server).delete('/api/onboarding/sample?deleteFolder=1')
    expect(removed.body).toEqual({ ok: true, removedProject: true, deletedFolder: true })
    expect(fs.existsSync(created.body.sample.path)).toBe(false)
    expect((await request(server).delete('/api/onboarding/sample')).status).toBe(404)
  })

  it('POST maps domain errors to their status', async () => {
    const res = await request(app([claude()])).post('/api/onboarding/sample').send({ path: '/etc/sample' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('outside_home')
    const unknown = await request(app([claude()])).post('/api/onboarding/sample').send({ sampleId: 'zzz' })
    expect(unknown.status).toBe(404)
  })
})
