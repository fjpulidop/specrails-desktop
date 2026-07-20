import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initDb, type DbInstance } from './db'
import {
  createProfilesRouter,
  providerSupportsAgentStudioAutomation,
} from './profiles-router'
import type { ProjectContext } from './project-registry'
import { installConfigPath } from './install-config-path'

// ─── Helpers ─────────────────────────────────────────────────────────────────

let projectPath: string
let db: DbInstance
let app: express.Express

function writeAgent(id: string, model = 'sonnet'): void {
  const dir = path.join(projectPath, '.claude', 'agents')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${id}.md`),
    `---\nname: ${id}\ndescription: "test"\nmodel: ${model}\ncolor: blue\nmemory: project\n---\n\n# Body\n`,
    'utf8',
  )
}

function baseProfile(name = 'default') {
  return {
    schemaVersion: 1,
    name,
    description: 'test',
    orchestrator: { model: 'sonnet' },
    agents: [
      { id: 'sr-architect', required: true },
      { id: 'sr-developer', required: true },
      { id: 'sr-reviewer', required: true },
      { id: 'sr-merge-resolver', required: true },
    ],
    routing: [{ default: true, agent: 'sr-developer' }],
  }
}

function mountApp(projectOverrides: Record<string, unknown> = {}): void {
  app = express()
  app.use(express.json())
  const ctx: ProjectContext = {
    project: {
      id: 'proj-test',
      slug: 'proj-test',
      name: 'Test',
      path: projectPath,
      provider: 'claude',
      providers: ['claude'],
      last_active: null,
      setup_session: null,
      agent_job_id: null,
      ...projectOverrides,
    } as never,
    db,
    queueManager: {} as never,
    chatManager: {} as never,
    setupManager: {} as never,
    proposalManager: {} as never,
    agentRefineManager: {
      startRefine: vi.fn(),
      sendTurn: vi.fn(),
    } as never,
    specLauncherManager: {} as never,
    ticketWatcher: {} as never,
    broadcast: vi.fn(),
    railJobs: new Map(),
  }
  app.use('/api/projects/:projectId/profiles', (req, _res, next) => {
    ;(req as never as { projectCtx: ProjectContext }).projectCtx = ctx
    next()
  }, createProfilesRouter())
}

beforeEach(() => {
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-router-'))
  db = initDb(':memory:')
  mountApp()
})

afterEach(() => {
  fs.rmSync(projectPath, { recursive: true, force: true })
  db.close()
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /profiles', () => {
  it('returns an empty array when no profiles exist', async () => {
    const res = await request(app).get('/api/projects/proj-test/profiles')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ profiles: [] })
  })

  it('lists profiles sorted by name', async () => {
    const dir = path.join(projectPath, '.specrails', 'profiles')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'default.json'), JSON.stringify(baseProfile('default')))
    fs.writeFileSync(path.join(dir, 'alpha.json'), JSON.stringify(baseProfile('alpha')))
    const res = await request(app).get('/api/projects/proj-test/profiles')
    expect(res.status).toBe(200)
    expect(res.body.profiles.map((p: { name: string }) => p.name)).toEqual(['alpha', 'default'])
  })
})

describe('multi-provider profile context and storage', () => {
  function kimiBody(name = 'kimi-default', model = 'private-kimi-alias') {
    return {
      schemaVersion: 1,
      name,
      provider: 'kimi',
      orchestrator: { model },
      agents: [
        { id: 'sr-architect', model, required: true },
        { id: 'sr-developer', model, required: true },
        { id: 'sr-reviewer', model, required: true },
      ],
      routing: [{ default: true, agent: 'sr-developer' }],
    }
  }

  beforeEach(() => {
    mountApp({ provider: 'claude', providers: ['claude', 'kimi'] })
  })

  it('returns installed provider catalogs without a Claude model fallback', async () => {
    const res = await request(app).get('/api/projects/proj-test/profiles/context')
    expect(res.status).toBe(200)
    expect(res.body.primaryProvider).toBe('claude')
    expect(res.body.providers).toEqual(['claude', 'kimi'])
    expect(res.body.catalogs.kimi).toMatchObject({
      defaultModel: 'k3',
      baselineAgents: ['sr-architect', 'sr-developer', 'sr-reviewer'],
      customModelAliases: true,
    })
    expect(res.body.catalogs.kimi.models.map((model: { value: string }) => model.value))
      .toContain('k3')
  })

  it('keeps Claude default and Kimi default separate and filters list/CRUD by provider', async () => {
    const claude = await request(app)
      .post('/api/projects/proj-test/profiles?provider=claude')
      .send({ ...baseProfile('default'), provider: 'claude' })
    const kimi = await request(app)
      .post('/api/projects/proj-test/profiles?provider=kimi')
      .send(kimiBody())
    expect(claude.status).toBe(201)
    expect(kimi.status).toBe(201)

    const claudeList = await request(app)
      .get('/api/projects/proj-test/profiles?provider=claude')
    const kimiList = await request(app)
      .get('/api/projects/proj-test/profiles?provider=kimi')
    expect(claudeList.body.profiles.map((profile: { name: string }) => profile.name)).toEqual(['default'])
    expect(kimiList.body.profiles).toEqual([
      expect.objectContaining({ name: 'kimi-default', provider: 'kimi', isDefault: true }),
    ])

    const fetched = await request(app)
      .get('/api/projects/proj-test/profiles/kimi-default?provider=kimi')
    expect(fetched.status).toBe(200)
    expect(fetched.body.profile.orchestrator.model).toBe('private-kimi-alias')

    const wrongProvider = await request(app)
      .get('/api/projects/proj-test/profiles/kimi-default?provider=claude')
    expect(wrongProvider.status).toBe(404)
    expect(fs.readdirSync(path.join(projectPath, '.specrails', 'profiles')).sort()).toEqual([
      'claude--default.json',
      'kimi--kimi-default.json',
    ])
  })

  it('rejects query/body provider disagreement', async () => {
    const res = await request(app)
      .post('/api/projects/proj-test/profiles?provider=claude')
      .send(kimiBody())
    expect(res.status).toBe(400)
    expect(res.body.details[0]).toContain("does not match requested provider")
  })

  it('keeps version counters and history isolated when Claude and Kimi share a role id', async () => {
    const id = 'custom-shared'
    const claudeV1 = '---\nname: custom-shared\ndescription: Claude v1\n---\n\nClaude body v1.'
    const claudeV2 = '---\nname: custom-shared\ndescription: Claude v2\n---\n\nClaude body v2.'
    const kimiV1 = '---\nname: custom-shared\ndescription: Kimi v1\n---\n\nKimi body v1.'
    const kimiV2 = '---\nname: custom-shared\ndescription: Kimi v2\n---\n\nKimi body v2.'

    const claudeCreate = await request(app)
      .post('/api/projects/proj-test/profiles/catalog?provider=claude')
      .send({ id, body: claudeV1 })
    const kimiCreate = await request(app)
      .post('/api/projects/proj-test/profiles/catalog?provider=kimi')
      .send({ id, body: kimiV1 })
    expect(claudeCreate.body.version).toBe(1)
    expect(kimiCreate.body.version).toBe(1)

    const claudePatch = await request(app)
      .patch(`/api/projects/proj-test/profiles/catalog/${id}?provider=claude`)
      .send({ body: claudeV2 })
    const kimiPatch = await request(app)
      .patch(`/api/projects/proj-test/profiles/catalog/${id}?provider=kimi`)
      .send({ body: kimiV2 })
    expect(claudePatch.body.version).toBe(2)
    expect(kimiPatch.body.version).toBe(2)

    const claudeVersions = await request(app)
      .get(`/api/projects/proj-test/profiles/catalog/${id}/versions?provider=claude`)
    const kimiVersions = await request(app)
      .get(`/api/projects/proj-test/profiles/catalog/${id}/versions?provider=kimi`)
    expect(claudeVersions.body.versions.map((row: { body: string }) => row.body))
      .toEqual([claudeV2, claudeV1])
    expect(kimiVersions.body.versions.map((row: { body: string }) => row.body))
      .toEqual([kimiV2, kimiV1])
  })

  it('validates Kimi Skill frontmatter before create or update writes', async () => {
    const invalidCreate = await request(app)
      .post('/api/projects/proj-test/profiles/catalog?provider=kimi')
      .send({
        id: 'custom-review',
        body: '---\nname: custom-wrong\ndescription: Review code\ntype: prompt\n---\n\nDo it.',
      })
    expect(invalidCreate.status).toBe(400)
    expect(invalidCreate.body).toMatchObject({ error: 'invalid_kimi_skill' })
    const file = path.join(
      projectPath,
      '.kimi-code',
      'skills',
      'custom-review',
      'SKILL.md',
    )
    expect(fs.existsSync(file)).toBe(false)

    const original = '---\nname: custom-review\ndescription: Review code\ntype: prompt\n---\n\nDo it.'
    const created = await request(app)
      .post('/api/projects/proj-test/profiles/catalog?provider=kimi')
      .send({ id: 'custom-review', body: original })
    expect(created.status).toBe(201)
    expect(fs.readFileSync(file, 'utf8')).toBe(original)

    const invalidUpdate = await request(app)
      .patch('/api/projects/proj-test/profiles/catalog/custom-review?provider=kimi')
      .send({
        body: '---\nname: custom-review\ndescription: ""\ntype: agent\n---\n\nBad.',
      })
    expect(invalidUpdate.status).toBe(400)
    expect(invalidUpdate.body.details[0]).toContain('description')
    expect(fs.readFileSync(file, 'utf8')).toBe(original)

    const invalidType = await request(app)
      .patch('/api/projects/proj-test/profiles/catalog/custom-review?provider=kimi')
      .send({
        body: '---\nname: custom-review\ndescription: Review code\ntype: agent\n---\n\nBad.',
      })
    expect(invalidType.status).toBe(400)
    expect(invalidType.body.details[0]).toContain('type "agent"')
    expect(fs.readFileSync(file, 'utf8')).toBe(original)
  })

  it.each([
    {
      label: 'malformed YAML',
      id: 'custom-malformed',
      body: '---\nname: custom-malformed\ndescription: [unterminated\ntype: prompt\n---\nBody.',
      detail: 'Invalid frontmatter',
    },
    {
      label: 'a numeric description',
      id: 'custom-number-description',
      body: '---\nname: custom-number-description\ndescription: 123\ntype: prompt\n---\nBody.',
      detail: '"description"',
    },
    {
      label: 'a non-mapping YAML root',
      id: 'custom-list-root',
      body: '---\n- name: custom-list-root\n- description: Review code\n---\nBody.',
      detail: 'mapping at the top level',
    },
    {
      label: 'a numeric type',
      id: 'custom-number-type',
      body: '---\nname: custom-number-type\ndescription: Review code\ntype: 42\n---\nBody.',
      detail: 'type "42"',
    },
    {
      label: 'a reference-only type',
      id: 'custom-reference',
      body: '---\nname: custom-reference\ndescription: Review code\ntype: reference\n---\nBody.',
      detail: 'cannot be activated',
    },
    {
      label: 'duplicate YAML keys',
      id: 'custom-duplicate',
      body: '---\nname: custom-duplicate\ndescription: First\ndescription: Second\n---\nBody.',
      detail: 'duplicated mapping key',
    },
    {
      label: 'an empty executable body',
      id: 'custom-empty-body',
      body: '---\nname: custom-empty-body\ndescription: Review code\ntype: prompt\n---\n',
      detail: 'empty body',
    },
  ])('rejects $label through the execution parser without writing', async ({
    id,
    body,
    detail,
  }) => {
    const res = await request(app)
      .post('/api/projects/proj-test/profiles/catalog?provider=kimi')
      .send({ id, body })

    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: 'invalid_kimi_skill' })
    expect(res.body.details[0]).toContain(detail)
    expect(fs.existsSync(path.join(
      projectPath,
      '.kimi-code',
      'skills',
      id,
      'SKILL.md',
    ))).toBe(false)
  })

  it('accepts full YAML block scalars, arguments, and provider extension keys', async () => {
    const id = 'custom-rich-yaml'
    const body = [
      '---',
      `name: "${id}"`,
      'description: >-',
      '  Reviews YAML with punctuation: colons, commas, and # characters.',
      'type: flow',
      'arguments:',
      '  - target',
      '  - severity',
      'x-kimi:',
      '  category: review',
      '  enabled: true',
      '---',
      'Review $target at $severity.',
    ].join('\n')

    const res = await request(app)
      .post('/api/projects/proj-test/profiles/catalog?provider=kimi')
      .send({ id, body })

    expect(res.status).toBe(201)
    expect(fs.readFileSync(path.join(
      projectPath,
      '.kimi-code',
      'skills',
      id,
      'SKILL.md',
    ), 'utf8')).toBe(body)

    const catalog = await request(app)
      .get('/api/projects/proj-test/profiles/catalog?provider=kimi')
    expect(catalog.status).toBe(200)
    expect(catalog.body.agents).toContainEqual(expect.objectContaining({
      id,
      description: 'Reviews YAML with punctuation: colons, commas, and # characters.',
    }))
  })

  it.each([
    ['/catalog/test', { draftBody: 'draft', sampleTask: 'test it' }],
    ['/catalog/generate', { name: 'custom-kimi', description: 'generate it' }],
    ['/catalog/custom-kimi/refine', { instruction: 'refine it' }],
  ])('rejects unsafe Kimi Studio automation at %s before work starts', async (endpoint, body) => {
    const res = await request(app)
      .post(`/api/projects/proj-test/profiles${endpoint}?provider=kimi`)
      .send(body)
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({
      error: 'provider_tool_policy_unsupported',
      provider: 'kimi',
      requiredPolicies: ['none', 'read-only'],
    })
  })

  it('keeps existing safe Studio automation enabled for Claude, Codex, and Gemini only', () => {
    expect(providerSupportsAgentStudioAutomation('claude')).toBe(true)
    expect(providerSupportsAgentStudioAutomation('codex')).toBe(true)
    expect(providerSupportsAgentStudioAutomation('gemini')).toBe(true)
    expect(providerSupportsAgentStudioAutomation('kimi')).toBe(false)
  })
})

describe('POST /profiles', () => {
  it('creates a valid profile and returns 201', async () => {
    const res = await request(app)
      .post('/api/projects/proj-test/profiles')
      .send(baseProfile('default'))
    expect(res.status).toBe(201)
    expect(res.body.profile.name).toBe('default')
    expect(fs.existsSync(path.join(projectPath, '.specrails', 'profiles', 'default.json'))).toBe(true)
  })

  it('rejects a profile with schemaVersion != 1', async () => {
    const bad = { ...baseProfile('x'), schemaVersion: 2 }
    const res = await request(app).post('/api/projects/proj-test/profiles').send(bad)
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('validation')
  })

  it('rejects any profile when baseline is missing', async () => {
    const bad = baseProfile('custom-bad')
    bad.agents = bad.agents.filter((a) => a.id !== 'sr-reviewer')
    const res = await request(app).post('/api/projects/proj-test/profiles').send(bad)
    expect(res.status).toBe(400)
  })

  it('accepts a custom profile with baseline + optional agents + empty routing', async () => {
    const custom = baseProfile('lean')
    custom.routing = []
    const res = await request(app).post('/api/projects/proj-test/profiles').send(custom)
    expect(res.status).toBe(201)
  })

  it('returns 409 when the name already exists', async () => {
    await request(app).post('/api/projects/proj-test/profiles').send(baseProfile('dup'))
    const res = await request(app).post('/api/projects/proj-test/profiles').send(baseProfile('dup'))
    expect(res.status).toBe(409)
  })

  it('rejects a profile whose default routing rule targets a non-sr-developer agent', async () => {
    const bad = baseProfile('custom-bad-default')
    bad.agents.push({ id: 'custom-foo' })
    bad.routing = [{ default: true, agent: 'custom-foo' }]
    const res = await request(app).post('/api/projects/proj-test/profiles').send(bad)
    expect(res.status).toBe(400)
  })
})

describe('GET /profiles/:name', () => {
  it('returns the profile body', async () => {
    await request(app).post('/api/projects/proj-test/profiles').send(baseProfile('default'))
    const res = await request(app).get('/api/projects/proj-test/profiles/default')
    expect(res.status).toBe(200)
    expect(res.body.profile.name).toBe('default')
  })

  it('returns 404 for an unknown profile', async () => {
    const res = await request(app).get('/api/projects/proj-test/profiles/ghost')
    expect(res.status).toBe(404)
  })
})

describe('PATCH /profiles/:name', () => {
  it('updates a profile', async () => {
    await request(app).post('/api/projects/proj-test/profiles').send(baseProfile('default'))
    const updated = baseProfile('default')
    updated.description = 'changed'
    const res = await request(app)
      .patch('/api/projects/proj-test/profiles/default')
      .send(updated)
    expect(res.status).toBe(200)
    expect(res.body.profile.description).toBe('changed')
  })

  it('rejects body.name / path mismatch', async () => {
    await request(app).post('/api/projects/proj-test/profiles').send(baseProfile('default'))
    const res = await request(app)
      .patch('/api/projects/proj-test/profiles/default')
      .send(baseProfile('renamed'))
    expect(res.status).toBe(400)
  })
})

describe('DELETE /profiles/:name', () => {
  it('deletes a non-default profile', async () => {
    await request(app).post('/api/projects/proj-test/profiles').send(baseProfile('extra'))
    const res = await request(app).delete('/api/projects/proj-test/profiles/extra')
    expect(res.status).toBe(200)
  })

  it('refuses to delete the default profile', async () => {
    await request(app).post('/api/projects/proj-test/profiles').send(baseProfile('default'))
    const res = await request(app).delete('/api/projects/proj-test/profiles/default')
    expect(res.status).toBe(400)
  })
})

describe('POST /profiles/:name/duplicate', () => {
  it('duplicates with a new name', async () => {
    await request(app).post('/api/projects/proj-test/profiles').send(baseProfile('default'))
    const res = await request(app)
      .post('/api/projects/proj-test/profiles/default/duplicate')
      .send({ name: 'copy' })
    expect(res.status).toBe(201)
    expect(res.body.profile.name).toBe('copy')
  })

  it('rejects missing new name', async () => {
    await request(app).post('/api/projects/proj-test/profiles').send(baseProfile('default'))
    const res = await request(app)
      .post('/api/projects/proj-test/profiles/default/duplicate')
      .send({})
    expect(res.status).toBe(400)
  })
})

describe('POST /profiles/:name/rename', () => {
  it('renames a profile', async () => {
    await request(app).post('/api/projects/proj-test/profiles').send(baseProfile('old'))
    const res = await request(app)
      .post('/api/projects/proj-test/profiles/old/rename')
      .send({ name: 'renamed' })
    expect(res.status).toBe(200)
    expect(res.body.profile.name).toBe('renamed')
  })
})

describe('GET /profiles/resolve', () => {
  it('returns null when no profiles exist', async () => {
    const res = await request(app).get('/api/projects/proj-test/profiles/resolve')
    expect(res.status).toBe(200)
    expect(res.body.resolved).toBeNull()
  })

  it('resolves to default when no explicit profile is passed', async () => {
    await request(app).post('/api/projects/proj-test/profiles').send(baseProfile('default'))
    const res = await request(app).get('/api/projects/proj-test/profiles/resolve')
    expect(res.body.resolved.name).toBe('default')
  })

  it('honors explicit override via query', async () => {
    await request(app).post('/api/projects/proj-test/profiles').send(baseProfile('default'))
    await request(app).post('/api/projects/proj-test/profiles').send(baseProfile('data-heavy'))
    const res = await request(app).get('/api/projects/proj-test/profiles/resolve?profile=data-heavy')
    expect(res.body.resolved.name).toBe('data-heavy')
  })
})

describe('GET /profiles/catalog', () => {
  it('returns empty agents when .claude/agents does not exist', async () => {
    const res = await request(app).get('/api/projects/proj-test/profiles/catalog')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ agents: [] })
  })

  it('classifies upstream vs custom agents with metadata', async () => {
    writeAgent('sr-architect')
    writeAgent('custom-pentester', 'opus')
    const res = await request(app).get('/api/projects/proj-test/profiles/catalog')
    expect(res.status).toBe(200)
    const byId = new Map(res.body.agents.map((a: { id: string }) => [a.id, a]))
    expect(byId.get('sr-architect')).toMatchObject({ kind: 'upstream', model: 'sonnet' })
    expect(byId.get('custom-pentester')).toMatchObject({ kind: 'custom', model: 'opus' })
  })
})

describe('GET /profiles/catalog/:agentId', () => {
  it('returns the body for a known agent', async () => {
    writeAgent('sr-architect')
    const res = await request(app).get('/api/projects/proj-test/profiles/catalog/sr-architect')
    expect(res.status).toBe(200)
    expect(res.body.body).toContain('sr-architect')
  })

  it('404 for missing agent', async () => {
    const res = await request(app).get('/api/projects/proj-test/profiles/catalog/sr-ghost')
    expect(res.status).toBe(404)
  })

  it('400 for invalid id format', async () => {
    const res = await request(app).get('/api/projects/proj-test/profiles/catalog/BadName')
    expect(res.status).toBe(400)
  })
})

describe('POST /profiles/catalog', () => {
  it('creates a new custom agent and records v1', async () => {
    const res = await request(app)
      .post('/api/projects/proj-test/profiles/catalog')
      .send({ id: 'custom-qa', body: '---\nname: custom-qa\n---\nbody' })
    expect(res.status).toBe(201)
    expect(res.body.version).toBe(1)
    const versions = db.prepare('SELECT * FROM agent_versions WHERE agent_name = ?').all('custom-qa')
    expect(versions).toHaveLength(1)
  })

  it('rejects non-custom prefixes', async () => {
    const res = await request(app)
      .post('/api/projects/proj-test/profiles/catalog')
      .send({ id: 'sr-malicious', body: 'x' })
    expect(res.status).toBe(400)
  })

  it('rejects empty body', async () => {
    const res = await request(app)
      .post('/api/projects/proj-test/profiles/catalog')
      .send({ id: 'custom-empty', body: '' })
    expect(res.status).toBe(400)
  })

  it('409 on duplicate', async () => {
    await request(app)
      .post('/api/projects/proj-test/profiles/catalog')
      .send({ id: 'custom-dup', body: 'x' })
    const res = await request(app)
      .post('/api/projects/proj-test/profiles/catalog')
      .send({ id: 'custom-dup', body: 'y' })
    expect(res.status).toBe(409)
  })
})

describe('PATCH /profiles/catalog/:agentId', () => {
  it('updates a custom agent and bumps version', async () => {
    await request(app)
      .post('/api/projects/proj-test/profiles/catalog')
      .send({ id: 'custom-q', body: 'v1' })
    const res = await request(app)
      .patch('/api/projects/proj-test/profiles/catalog/custom-q')
      .send({ body: 'v2' })
    expect(res.status).toBe(200)
    expect(res.body.version).toBe(2)
  })

  it('403 on sr-* edit attempt', async () => {
    writeAgent('sr-architect')
    const res = await request(app)
      .patch('/api/projects/proj-test/profiles/catalog/sr-architect')
      .send({ body: 'tampered' })
    expect(res.status).toBe(403)
  })
})

describe('DELETE /profiles/catalog/:agentId', () => {
  it('deletes a custom agent', async () => {
    await request(app)
      .post('/api/projects/proj-test/profiles/catalog')
      .send({ id: 'custom-bye', body: 'x' })
    const res = await request(app).delete('/api/projects/proj-test/profiles/catalog/custom-bye')
    expect(res.status).toBe(200)
  })

  it('403 on sr-* delete attempt', async () => {
    writeAgent('sr-architect')
    const res = await request(app).delete('/api/projects/proj-test/profiles/catalog/sr-architect')
    expect(res.status).toBe(403)
  })
})

describe('GET /profiles/catalog/:agentId/versions', () => {
  it('returns all saved versions most-recent first', async () => {
    await request(app)
      .post('/api/projects/proj-test/profiles/catalog')
      .send({ id: 'custom-v', body: 'v1' })
    await request(app)
      .patch('/api/projects/proj-test/profiles/catalog/custom-v')
      .send({ body: 'v2' })
    const res = await request(app).get('/api/projects/proj-test/profiles/catalog/custom-v/versions')
    expect(res.status).toBe(200)
    expect(res.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1])
  })
})

describe('GET /profiles/core-version', () => {
  it('reports null + profileAware=false when version file is missing', async () => {
    const res = await request(app).get('/api/projects/proj-test/profiles/core-version')
    expect(res.status).toBe(200)
    expect(res.body.version).toBeNull()
    expect(res.body.profileAware).toBe(false)
  })

  it('reports profileAware=true for 4.1.0+', async () => {
    fs.mkdirSync(path.join(projectPath, '.specrails'), { recursive: true })
    fs.writeFileSync(path.join(projectPath, '.specrails', 'specrails-version'), '4.1.0')
    const res = await request(app).get('/api/projects/proj-test/profiles/core-version')
    expect(res.body.profileAware).toBe(true)
  })

  it('reports profileAware=false for 4.0.x', async () => {
    fs.mkdirSync(path.join(projectPath, '.specrails'), { recursive: true })
    fs.writeFileSync(path.join(projectPath, '.specrails', 'specrails-version'), '4.0.8')
    const res = await request(app).get('/api/projects/proj-test/profiles/core-version')
    expect(res.body.profileAware).toBe(false)
  })
})

describe('GET /profiles/analytics', () => {
  it('returns empty rows when no jobs have profiles', async () => {
    const res = await request(app).get('/api/projects/proj-test/profiles/analytics')
    expect(res.status).toBe(200)
    expect(res.body.rows).toEqual([])
  })

  it('aggregates per-profile metrics', async () => {
    const now = Date.now()
    db.prepare(
      `INSERT INTO jobs (id, command, started_at, status, priority, duration_ms, tokens_in, tokens_out, total_cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('job-1', '/specrails:implement', new Date(now).toISOString(), 'completed', 'normal', 1000, 100, 200, 0.05)
    db.prepare(
      `INSERT INTO job_profiles (job_id, profile_name, profile_json, created_at) VALUES (?, ?, ?, ?)`,
    ).run('job-1', 'default', '{}', now)
    const res = await request(app).get('/api/projects/proj-test/profiles/analytics')
    expect(res.body.rows).toHaveLength(1)
    expect(res.body.rows[0].profileName).toBe('default')
    expect(res.body.rows[0].successRate).toBe(1)
  })

  it('keeps Kimi profile usage and cost unavailable instead of averaging them as zero', async () => {
    const now = Date.now()
    db.prepare(
      `INSERT INTO jobs (
         id, command, started_at, status, priority, provider,
         duration_ms, tokens_in, tokens_out, tokens_cache_read,
         tokens_cache_create, total_cost_usd
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)`,
    ).run(
      'job-kimi',
      '/specrails:implement',
      new Date(now).toISOString(),
      'completed',
      'normal',
      'kimi',
      1000,
    )
    db.prepare(
      `INSERT INTO job_profiles (job_id, profile_name, profile_json, created_at) VALUES (?, ?, ?, ?)`,
    ).run('job-kimi', 'default', '{}', now)
    mountApp({ provider: 'kimi', providers: ['claude', 'kimi'] })

    const res = await request(app)
      .get('/api/projects/proj-test/profiles/analytics')
    expect(res.status).toBe(200)
    expect(res.body.rows[0]).toMatchObject({
      avgTokens: null,
      avgCostUsd: null,
      usageReportedJobs: 0,
      usageUnavailableJobs: 1,
      pricedJobs: 0,
      unpricedJobs: 1,
    })
  })
})

describe('POST /profiles/migrate-from-settings', () => {
  it('creates default profile from installed sr-* agents', async () => {
    writeAgent('sr-architect', 'opus')
    writeAgent('sr-developer')
    writeAgent('sr-reviewer')
    writeAgent('sr-merge-resolver')
    const res = await request(app).post('/api/projects/proj-test/profiles/migrate-from-settings')
    expect(res.status).toBe(201)
    expect(res.body.profile.name).toBe('default')
    // Order: baseline trio first; sr-merge-resolver is optional, sorts alphabetically among optional agents
    const ids = res.body.profile.agents.map((a: { id: string }) => a.id)
    expect(ids.slice(0, 3)).toEqual(['sr-architect', 'sr-developer', 'sr-reviewer'])
    // sr-merge-resolver is optional (not a baseline agent)
    const merge = res.body.profile.agents.find((a: { id: string }) => a.id === 'sr-merge-resolver')
    expect(merge.required).toBe(false)
  })

  it('creates default profile when only the baseline trio is present (no sr-merge-resolver)', async () => {
    writeAgent('sr-architect', 'opus')
    writeAgent('sr-developer')
    writeAgent('sr-reviewer')
    const res = await request(app).post('/api/projects/proj-test/profiles/migrate-from-settings')
    expect(res.status).toBe(201)
    const ids = res.body.profile.agents.map((a: { id: string }) => a.id)
    expect(ids).toEqual(['sr-architect', 'sr-developer', 'sr-reviewer'])
  })

  it('400 when no .claude/agents directory', async () => {
    const res = await request(app).post('/api/projects/proj-test/profiles/migrate-from-settings')
    expect(res.status).toBe(400)
  })

  it('400 when baseline is incomplete (missing sr-reviewer)', async () => {
    writeAgent('sr-architect')
    writeAgent('sr-developer')
    const res = await request(app).post('/api/projects/proj-test/profiles/migrate-from-settings')
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('sr-reviewer')
  })

  it('409 when default already exists', async () => {
    writeAgent('sr-architect')
    writeAgent('sr-developer')
    writeAgent('sr-reviewer')
    writeAgent('sr-merge-resolver')
    await request(app).post('/api/projects/proj-test/profiles/migrate-from-settings')
    const res = await request(app).post('/api/projects/proj-test/profiles/migrate-from-settings')
    expect(res.status).toBe(409)
  })

  it('preserves exact Kimi default and per-role aliases from install config', async () => {
    const originalSkills = new Map<string, string>()
    for (const role of ['sr-architect', 'sr-developer', 'sr-reviewer']) {
      const dir = path.join(projectPath, '.kimi-code', 'skills', role)
      const body = `---\nname: ${role}\ndescription: ${role}\ntype: prompt\n---\n\n# ${role}\n`
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'SKILL.md'), body)
      originalSkills.set(role, body)
    }
    const defaultAlias = 'Moonshot-Team/Private_Coder:v2'
    const architectAlias = 'moonshot-team/architect.v3'
    const previousHome = process.env.SPECRAILS_REGISTRY_HOME
    process.env.SPECRAILS_REGISTRY_HOME = projectPath
    try {
      const configPath = installConfigPath({ slug: 'proj-test', path: projectPath })
      fs.mkdirSync(path.dirname(configPath), { recursive: true })
      fs.writeFileSync(configPath, [
        'provider: kimi',
        'models:',
        `  defaults: { model: ${defaultAlias} }`,
        '  overrides:',
        `    sr-architect: ${architectAlias}`,
        '',
      ].join('\n'))
      mountApp({ provider: 'kimi', providers: ['kimi'] })

      const res = await request(app)
        .post('/api/projects/proj-test/profiles/migrate-from-settings')

      expect(res.status).toBe(201)
      expect(res.body.profile.provider).toBe('kimi')
      expect(res.body.profile.orchestrator.model).toBe(defaultAlias)
      expect(res.body.profile.agents).toEqual([
        { id: 'sr-architect', model: architectAlias, required: true },
        { id: 'sr-developer', model: defaultAlias, required: true },
        { id: 'sr-reviewer', model: defaultAlias, required: true },
      ])
      for (const [role, body] of originalSkills) {
        expect(fs.readFileSync(
          path.join(projectPath, '.kimi-code', 'skills', role, 'SKILL.md'),
          'utf8',
        )).toBe(body)
      }
    } finally {
      if (previousHome === undefined) delete process.env.SPECRAILS_REGISTRY_HOME
      else process.env.SPECRAILS_REGISTRY_HOME = previousHome
    }
  })
})

describe('feature flag gating', () => {
  it('returns 404 when SPECRAILS_AGENTS_SECTION=false', async () => {
    // Re-mount with the env set
    const prev = process.env.SPECRAILS_AGENTS_SECTION
    process.env.SPECRAILS_AGENTS_SECTION = 'false'
    try {
      // Reload module registry
      vi.resetModules()
      const { createProfilesRouter: freshRouter } = await import('./profiles-router')
      const freshApp = express()
      freshApp.use(express.json())
      const ctx: ProjectContext = {
        project: { id: 'p', slug: 'p', name: 'p', path: projectPath } as never,
        db,
        queueManager: {} as never,
        chatManager: {} as never,
        setupManager: {} as never,
        proposalManager: {} as never,
        specLauncherManager: {} as never,
        ticketWatcher: {} as never,
        broadcast: vi.fn(),
        railJobs: new Map(),
      }
      freshApp.use('/api/projects/:projectId/profiles', (req, _res, next) => {
        ;(req as never as { projectCtx: ProjectContext }).projectCtx = ctx
        next()
      }, freshRouter())
      const res = await request(freshApp).get('/api/projects/p/profiles')
      expect(res.status).toBe(404)
    } finally {
      if (prev === undefined) delete process.env.SPECRAILS_AGENTS_SECTION
      else process.env.SPECRAILS_AGENTS_SECTION = prev
    }
  })
})

describe('relocate-artifacts: custom-agent catalog routes through the workspace', () => {
  let regHome: string
  let prevRegHome: string | undefined
  let relApp: express.Express
  let workspaceDir: string

  beforeEach(async () => {
    regHome = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-reg-'))
    prevRegHome = process.env.SPECRAILS_REGISTRY_HOME
    process.env.SPECRAILS_REGISTRY_HOME = regHome

    // Allocate a registry entry for this repo (flips resolveArtifacts → !isLegacy).
    const { mirrorProjectEntry } = await import('./artifact-registry')
    const entry = mirrorProjectEntry(
      { repoPath: projectPath, slug: 'proj-test', providers: ['claude'], primaryProvider: 'claude' },
      regHome,
    )
    workspaceDir = entry.workspaceDir
    // Populate the workspace gate marker so resolveProjectExecution flips relocated.
    fs.mkdirSync(path.join(workspaceDir, '.specrails'), { recursive: true })
    fs.writeFileSync(path.join(workspaceDir, '.specrails', 'specrails-version'), '4.8.2\n')

    relApp = express()
    relApp.use(express.json())
    const ctx: ProjectContext = {
      project: { id: 'proj-test', slug: 'proj-test', name: 'Test', path: projectPath, provider: 'claude' } as never,
      db,
      queueManager: {} as never, chatManager: {} as never, setupManager: {} as never,
      proposalManager: {} as never, specLauncherManager: {} as never, ticketWatcher: {} as never,
      broadcast: vi.fn(), railJobs: new Map(),
    }
    relApp.use('/api/projects/:projectId/profiles', (req, _res, next) => {
      ;(req as never as { projectCtx: ProjectContext }).projectCtx = ctx
      next()
    }, createProfilesRouter())
  })

  afterEach(() => {
    fs.rmSync(regHome, { recursive: true, force: true })
    if (prevRegHome === undefined) delete process.env.SPECRAILS_REGISTRY_HOME
    else process.env.SPECRAILS_REGISTRY_HOME = prevRegHome
  })

  it('POST writes the custom agent under the WORKSPACE, not the repo', async () => {
    const res = await request(relApp)
      .post('/api/projects/proj-test/profiles/catalog')
      .send({ id: 'custom-reloc', body: '---\nname: custom-reloc\n---\nbody' })
    expect(res.status).toBe(201)
    // Written under the workspace .claude/agents — NOT the repo.
    expect(fs.existsSync(path.join(workspaceDir, '.claude', 'agents', 'custom-reloc.md'))).toBe(true)
    expect(fs.existsSync(path.join(projectPath, '.claude', 'agents', 'custom-reloc.md'))).toBe(false)
  })

  it('GET reads the catalog from the WORKSPACE', async () => {
    // Seed an agent directly in the workspace catalog.
    const wsAgents = path.join(workspaceDir, '.claude', 'agents')
    fs.mkdirSync(wsAgents, { recursive: true })
    fs.writeFileSync(
      path.join(wsAgents, 'custom-fromws.md'),
      '---\nname: custom-fromws\ndescription: "ws"\nmodel: sonnet\n---\nbody\n',
      'utf8',
    )
    const res = await request(relApp).get('/api/projects/proj-test/profiles/catalog')
    expect(res.status).toBe(200)
    const ids = (res.body.agents as Array<{ id: string }>).map((a) => a.id)
    expect(ids).toContain('custom-fromws')
  })
})
