import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  AGENT_DEFAULTS_SETTING_KEY,
  AgentDefaultsValidationError,
  GLOBAL_DEFAULTS_PROFILE_NAME,
  applyAgentDefaultsPatch,
  buildAgentDefaultsCatalog,
  createLoopProfilePathResolver,
  ensureGlobalProfileSnapshot,
  mergeProfileWithAgentDefaults,
  readAgentDefaultsSettings,
  resolveAgentDefaults,
  synthesizeProfileFromDefaults,
} from './agent-defaults'
import { initDesktopDb, getDesktopSetting, setDesktopSetting } from './desktop-db'
import { getAdapter } from './providers'
import type { DbInstance } from './db'
import type { Profile, ResolvedProfile } from './profile-manager'

let db: DbInstance

beforeEach(() => {
  db = initDesktopDb(':memory:')
})

function seed(providers: Record<string, unknown>): void {
  setDesktopSetting(db, AGENT_DEFAULTS_SETTING_KEY, JSON.stringify({ version: 1, providers }))
}

describe('readAgentDefaultsSettings', () => {
  it('returns empty settings when nothing stored', () => {
    expect(readAgentDefaultsSettings(db)).toEqual({ version: 1, providers: {} })
  })

  it('survives garbage JSON (fail-open)', () => {
    setDesktopSetting(db, AGENT_DEFAULTS_SETTING_KEY, '{nope')
    expect(readAgentDefaultsSettings(db)).toEqual({ version: 1, providers: {} })
  })

  it('sanitizes malformed entries but keeps valid ones', () => {
    setDesktopSetting(db, AGENT_DEFAULTS_SETTING_KEY, JSON.stringify({
      version: 1,
      providers: {
        claude: {
          custom: true,
          pipelineModel: 'opus',
          pipelineEffort: 42,
          agentModels: { 'sr-architect': 'opus', 'BAD ID': 'x', 'sr-developer': 7 },
        },
        codex: 'not-an-object',
      },
    }))
    const parsed = readAgentDefaultsSettings(db)
    expect(parsed.providers.claude).toEqual({
      custom: true,
      pipelineModel: 'opus',
      agentModels: { 'sr-architect': 'opus' },
    })
    expect(parsed.providers.codex).toBeUndefined()
  })
})

describe('applyAgentDefaultsPatch', () => {
  it('persists a valid claude entry and echoes the canonical settings', () => {
    const next = applyAgentDefaultsPatch(db, {
      providers: {
        claude: {
          custom: true,
          pipelineModel: 'opus',
          pipelineEffort: 'high',
          agentModels: { 'sr-reviewer': 'haiku' },
        },
      },
    })
    expect(next.providers.claude).toEqual({
      custom: true,
      pipelineModel: 'opus',
      pipelineEffort: 'high',
      agentModels: { 'sr-reviewer': 'haiku' },
    })
    expect(JSON.parse(getDesktopSetting(db, AGENT_DEFAULTS_SETTING_KEY)!)).toEqual(next)
  })

  it('replaces per provider wholesale but preserves other providers', () => {
    applyAgentDefaultsPatch(db, { providers: { claude: { custom: true, pipelineModel: 'opus' } } })
    applyAgentDefaultsPatch(db, { providers: { codex: { custom: true, pipelineModel: 'gpt-5.5' } } })
    const next = applyAgentDefaultsPatch(db, { providers: { claude: { custom: true, pipelineEffort: 'low' } } })
    expect(next.providers.claude).toEqual({ custom: true, pipelineEffort: 'low' })
    expect(next.providers.codex).toEqual({ custom: true, pipelineModel: 'gpt-5.5' })
  })

  it.each([
    [{ nope: true }, 'invalid_body'],
    [{ providers: { nope: { custom: true } } }, 'unknown_provider'],
    [{ providers: { claude: 'x' } }, 'invalid_provider_config'],
    [{ providers: { claude: { custom: true, pipelineModel: 'not a model!!' } } }, 'invalid_model'],
    [{ providers: { claude: { custom: true, pipelineEffort: 'ultra' } } }, 'invalid_effort'],
    [{ providers: { gemini: { custom: true, pipelineEffort: 'high' } } }, 'invalid_effort'],
    [{ providers: { claude: { custom: true, agentModels: 'x' } } }, 'invalid_agent_models'],
    [{ providers: { codex: { custom: true, agentModels: { 'sr-architect': 'gpt-5.5' } } } }, 'per_agent_not_supported'],
    [{ providers: { claude: { custom: true, agentModels: { 'sr-unknown': 'opus' } } } }, 'unknown_agent'],
    [{ providers: { claude: { custom: true, agentModels: { 'sr-architect': '!!' } } } }, 'invalid_agent_model'],
  ])('rejects %j with %s', (body, code) => {
    try {
      applyAgentDefaultsPatch(db, body)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(AgentDefaultsValidationError)
      expect((err as AgentDefaultsValidationError).code).toBe(code)
    }
  })

  it('validates kimi effort against the pipeline model (K3-only tiers)', () => {
    expect(() =>
      applyAgentDefaultsPatch(db, {
        providers: { kimi: { custom: true, pipelineModel: 'kimi-for-coding', pipelineEffort: 'high' } },
      }),
    ).toThrowError(AgentDefaultsValidationError)
    const ok = applyAgentDefaultsPatch(db, {
      providers: { kimi: { custom: true, pipelineModel: 'k3', pipelineEffort: 'high' } },
    })
    expect(ok.providers.kimi.pipelineEffort).toBe('high')
  })
})

describe('resolveAgentDefaults', () => {
  it('returns null when nothing stored / custom off / unknown provider', () => {
    expect(resolveAgentDefaults(db, 'claude')).toBeNull()
    seed({ claude: { custom: false, pipelineModel: 'opus' } })
    expect(resolveAgentDefaults(db, 'claude')).toBeNull()
    expect(resolveAgentDefaults(db, 'nope')).toBeNull()
  })

  it('resolves a validated view and drops stale catalog values (fail-open)', () => {
    seed({
      claude: {
        custom: true,
        pipelineModel: 'not a model!!',
        pipelineEffort: 'high',
        agentModels: { 'sr-architect': 'opus', 'sr-unknown': 'opus', 'sr-reviewer': '!!' },
      },
    })
    expect(resolveAgentDefaults(db, 'claude')).toEqual({
      pipelineModel: null,
      pipelineEffort: 'high',
      agentModels: { 'sr-architect': 'opus' },
    })
  })

  it('drops effort for providers without effort support and agent models without profile support', () => {
    seed({
      gemini: { custom: true, pipelineEffort: 'high' },
      codex: { custom: true, agentModels: { 'sr-architect': 'gpt-5.5' } },
    })
    expect(resolveAgentDefaults(db, 'gemini')).toBeNull()
    expect(resolveAgentDefaults(db, 'codex')).toBeNull()
  })
})

describe('mergeProfileWithAgentDefaults / synthesizeProfileFromDefaults', () => {
  const defaults = { pipelineModel: 'opus', pipelineEffort: null, agentModels: { 'sr-developer': 'sonnet', 'sr-reviewer': 'haiku' } }
  const profile: Profile = {
    schemaVersion: 1,
    name: 'default',
    orchestrator: { model: 'sonnet' },
    agents: [
      { id: 'sr-architect' },
      { id: 'sr-developer', model: 'opus' },
      { id: 'sr-reviewer' },
    ],
    routing: [{ default: true, agent: 'sr-developer' }],
  }

  it('fills ONLY agents without an explicit model', () => {
    const merged = mergeProfileWithAgentDefaults(profile, defaults)
    expect(merged.changed).toBe(true)
    expect(merged.profile.agents).toEqual([
      { id: 'sr-architect' }, // no global override for it → untouched
      { id: 'sr-developer', model: 'opus' }, // profile explicit wins
      { id: 'sr-reviewer', model: 'haiku' },
    ])
    expect(merged.profile.orchestrator.model).toBe('sonnet')
  })

  it('returns the same object untouched when nothing changes', () => {
    const noOverlap = { pipelineModel: null, pipelineEffort: null, agentModels: { 'sr-developer': 'haiku' } }
    const merged = mergeProfileWithAgentDefaults(profile, noOverlap)
    expect(merged.changed).toBe(false)
    expect(merged.profile).toBe(profile)
  })

  it('synthesizes a baseline-trio profile', () => {
    const adapter = getAdapter('claude')
    const synth = synthesizeProfileFromDefaults(adapter, defaults)
    expect(synth.name).toBe(GLOBAL_DEFAULTS_PROFILE_NAME)
    expect(synth.provider).toBe('claude')
    expect(synth.orchestrator.model).toBe('opus')
    expect(synth.agents).toEqual([
      { id: 'sr-architect' },
      { id: 'sr-developer', model: 'sonnet' },
      { id: 'sr-reviewer', model: 'haiku' },
    ])
    expect(synth.routing).toEqual([{ default: true, agent: 'sr-developer' }])
  })

  it('synthesized orchestrator falls back to the adapter default model', () => {
    const adapter = getAdapter('claude')
    const synth = synthesizeProfileFromDefaults(adapter, { ...defaults, pipelineModel: null })
    expect(synth.orchestrator.model).toBe(adapter.defaultModel())
  })
})

describe('ensureGlobalProfileSnapshot', () => {
  it('is content-addressed: same content reuses the file, new content gets a new one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-defaults-'))
    const adapter = getAdapter('claude')
    const profile = synthesizeProfileFromDefaults(adapter, {
      pipelineModel: 'opus', pipelineEffort: null, agentModels: { 'sr-reviewer': 'haiku' },
    })
    const first = ensureGlobalProfileSnapshot('claude', profile, dir)
    const second = ensureGlobalProfileSnapshot('claude', profile, dir)
    expect(second).toBe(first)
    expect(JSON.parse(fs.readFileSync(first, 'utf8')).agents).toEqual(profile.agents)

    const changed = ensureGlobalProfileSnapshot('claude', { ...profile, orchestrator: { model: 'sonnet' } }, dir)
    expect(changed).not.toBe(first)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('createLoopProfilePathResolver', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-defaults-loop-'))
  })

  function resolver(overrides: Partial<Parameters<typeof createLoopProfilePathResolver>[0]> = {}) {
    return createLoopProfilePathResolver({
      desktopDb: db,
      profileRoot: () => '/fake/workspace',
      supportsProfiles: () => true,
      resolveProfile: () => null,
      snapshotDir: dir,
      ...overrides,
    })
  }

  it('is inert without per-agent global models', () => {
    expect(resolver()('claude')).toBeNull()
    seed({ claude: { custom: true, pipelineModel: 'opus' } }) // pipeline-only ⇒ ride run-level, not profile
    expect(resolver()('claude')).toBeNull()
  })

  it('is inert for non-profile providers and unsupported cores', () => {
    seed({ codex: { custom: true, agentModels: { 'sr-architect': 'gpt-5.5' } } })
    expect(resolver()('codex')).toBeNull()
    seed({ claude: { custom: true, agentModels: { 'sr-architect': 'opus' } } })
    expect(resolver({ supportsProfiles: () => false })('claude')).toBeNull()
  })

  it('synthesizes a snapshot when the project has no profile', () => {
    seed({ claude: { custom: true, agentModels: { 'sr-architect': 'opus' } } })
    const p = resolver()('claude')
    expect(p).toBeTruthy()
    const written = JSON.parse(fs.readFileSync(p!, 'utf8')) as Profile
    expect(written.name).toBe(GLOBAL_DEFAULTS_PROFILE_NAME)
    expect(written.agents.find((a) => a.id === 'sr-architect')?.model).toBe('opus')
  })

  it('merges gaps into an existing project profile and snapshots the merged copy', () => {
    seed({ claude: { custom: true, agentModels: { 'sr-architect': 'opus', 'sr-developer': 'haiku' } } })
    const base: ResolvedProfile = {
      name: 'default',
      profile: {
        schemaVersion: 1,
        name: 'default',
        orchestrator: { model: 'sonnet' },
        agents: [{ id: 'sr-architect', model: 'sonnet' }, { id: 'sr-developer' }, { id: 'sr-reviewer' }],
        routing: [{ default: true, agent: 'sr-developer' }],
      },
    }
    const p = resolver({ resolveProfile: () => base })('claude')
    expect(p).toBeTruthy()
    const written = JSON.parse(fs.readFileSync(p!, 'utf8')) as Profile
    expect(written.agents).toEqual([
      { id: 'sr-architect', model: 'sonnet' }, // profile explicit wins
      { id: 'sr-developer', model: 'haiku' },
      { id: 'sr-reviewer' },
    ])
  })

  it('stays out of the way when the project profile already pins every overridden agent', () => {
    seed({ claude: { custom: true, agentModels: { 'sr-architect': 'opus' } } })
    const base: ResolvedProfile = {
      name: 'default',
      profile: {
        schemaVersion: 1,
        name: 'default',
        orchestrator: { model: 'sonnet' },
        agents: [{ id: 'sr-architect', model: 'sonnet' }],
        routing: [{ default: true, agent: 'sr-developer' }],
      },
    }
    expect(resolver({ resolveProfile: () => base })('claude')).toBeNull()
  })

  it('never throws — a broken profileRoot resolves to null', () => {
    seed({ claude: { custom: true, agentModels: { 'sr-architect': 'opus' } } })
    const r = resolver({ profileRoot: () => { throw new Error('boom') } })
    expect(r('claude')).toBeNull()
  })
})

describe('buildAgentDefaultsCatalog', () => {
  it('describes every registered provider with honest capabilities', () => {
    const catalog = buildAgentDefaultsCatalog()
    const byId = Object.fromEntries(catalog.map((c) => [c.id, c]))
    expect(byId.claude.perAgentModels).toBe(true)
    expect(byId.claude.supportsEffort).toBe(true)
    expect(byId.claude.baselineAgents).toEqual(['sr-architect', 'sr-developer', 'sr-reviewer'])
    expect(byId.claude.effortsByModel[byId.claude.defaultModel]).toContain('high')
    expect(byId.codex.perAgentModels).toBe(false)
    expect(byId.codex.supportsEffort).toBe(true)
    expect(byId.gemini.supportsEffort).toBe(false)
    expect(byId.kimi.perAgentModels).toBe(true)
    // kimi effort tiers are model-scoped: K3 has them, others do not.
    expect(byId.kimi.effortsByModel['k3']).toEqual(['low', 'high', 'max'])
    expect(byId.kimi.effortsByModel['kimi-for-coding']).toEqual([])
  })
})
