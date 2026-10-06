import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initDb, type DbInstance } from './db'
import { createProfile, getProfile } from './modules/agents/runtime/profile-manager'

/**
 * Integration-flavor test for the migration endpoint's core logic: seed the
 * baseline role ids (runtime-defined by specrails-core, no file required),
 * read `model:` only from `.claude/agents/sr-*.md` files that still exist,
 * and build a default profile. We exercise the filesystem + ProfileManager
 * directly since the endpoint only adds ctx + broadcast plumbing.
 */

let projectPath: string
let db: DbInstance

function agentFile(name: string, model: 'sonnet' | 'opus' | 'haiku' = 'sonnet'): string {
  return `---\nname: ${name}\ndescription: "test"\nmodel: ${model}\ncolor: blue\nmemory: project\n---\n\n# Identity\ntest agent\n`
}

function seedAgent(name: string, model: 'sonnet' | 'opus' | 'haiku' = 'sonnet'): void {
  const dir = path.join(projectPath, '.claude', 'agents')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${name}.md`), agentFile(name, model), 'utf8')
}

// Mirror of the migration endpoint body — keeps test focused on the core logic.
const BASELINE = ['sr-architect', 'sr-developer', 'sr-reviewer']
const DEFAULT_MODEL = 'sonnet'
function runMigration(projectPath: string): { ok: true } {
  const agentsDir = path.join(projectPath, '.claude', 'agents')
  const agents: Array<{ id: string; model: 'sonnet' | 'opus' | 'haiku' }> = []
  // Role files are optional; read models only from the `sr-*` files that exist.
  for (const entry of fs.existsSync(agentsDir) ? fs.readdirSync(agentsDir) : []) {
    if (!entry.endsWith('.md') || !entry.startsWith('sr-')) continue
    const id = entry.slice(0, -'.md'.length)
    let model: 'sonnet' | 'opus' | 'haiku' = DEFAULT_MODEL
    const body = fs.readFileSync(path.join(agentsDir, entry), 'utf8')
    const m = body.match(/^model:\s*(sonnet|opus|haiku)/m)
    if (m) model = m[1] as 'sonnet' | 'opus' | 'haiku'
    agents.push({ id, model })
  }
  for (const id of BASELINE) {
    if (!agents.some((a) => a.id === id)) agents.push({ id, model: DEFAULT_MODEL })
  }
  const baseline = BASELINE
  const profile = {
    schemaVersion: 1,
    name: 'default',
    orchestrator: { model: 'sonnet' as const },
    agents: agents.map((a) => ({ id: a.id, model: a.model, required: baseline.includes(a.id) })),
    routing: [{ default: true, agent: 'sr-developer' }],
  }
  createProfile(projectPath, profile as never)
  return { ok: true }
}

beforeEach(() => {
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'prof-migrate-'))
  db = initDb(':memory:')
})

afterEach(() => {
  fs.rmSync(projectPath, { recursive: true, force: true })
  db.close()
})

describe('profile migration from runtime-defined roles and existing agent frontmatters', () => {
  it('creates a default profile from older-Core role files, keeping optional sr-* agents', () => {
    seedAgent('sr-architect', 'opus')
    seedAgent('sr-developer', 'sonnet')
    seedAgent('sr-reviewer', 'sonnet')
    seedAgent('sr-merge-resolver', 'sonnet')
    const result = runMigration(projectPath)
    expect(result).toEqual({ ok: true })
    const profile = getProfile(projectPath, 'default')
    expect(profile.name).toBe('default')
    expect(profile.agents.map((a) => a.id).sort()).toEqual(
      ['sr-architect', 'sr-developer', 'sr-merge-resolver', 'sr-reviewer'],
    )
    const architect = profile.agents.find((a) => a.id === 'sr-architect')!
    expect(architect.model).toBe('opus')
    expect(architect.required).toBe(true)
    // merge-resolver is not part of the baseline trio
    const merge = profile.agents.find((a) => a.id === 'sr-merge-resolver')!
    expect(merge.required).toBe(false)
  })

  it('seeds the baseline trio with the default model when no role file exists (Core >= 6.3)', () => {
    expect(fs.existsSync(path.join(projectPath, '.claude', 'agents'))).toBe(false)
    expect(runMigration(projectPath)).toEqual({ ok: true })
    const profile = getProfile(projectPath, 'default')
    expect(profile.agents).toEqual([
      { id: 'sr-architect', model: 'sonnet', required: true },
      { id: 'sr-developer', model: 'sonnet', required: true },
      { id: 'sr-reviewer', model: 'sonnet', required: true },
    ])
  })

  it('reads models from the role files that exist and seeds the missing sr-reviewer', () => {
    seedAgent('sr-architect', 'opus')
    seedAgent('sr-developer', 'haiku')
    // sr-reviewer missing: seeded with the default model instead of rejecting
    expect(runMigration(projectPath)).toEqual({ ok: true })
    const profile = getProfile(projectPath, 'default')
    const byId = new Map(profile.agents.map((a) => [a.id, a]))
    expect(byId.get('sr-architect')).toMatchObject({ model: 'opus', required: true })
    expect(byId.get('sr-developer')).toMatchObject({ model: 'haiku', required: true })
    expect(byId.get('sr-reviewer')).toMatchObject({ model: 'sonnet', required: true })
  })

  it('ignores non-sr agents (e.g. custom-*)', () => {
    seedAgent('sr-architect')
    seedAgent('sr-developer')
    seedAgent('sr-reviewer')
    seedAgent('sr-merge-resolver')
    // custom agent shouldn't block migration and shouldn't appear in the default profile
    const customFile = path.join(projectPath, '.claude', 'agents', 'custom-qa.md')
    fs.writeFileSync(customFile, agentFile('custom-qa'), 'utf8')
    const result = runMigration(projectPath)
    expect(result).toEqual({ ok: true })
    const profile = getProfile(projectPath, 'default')
    expect(profile.agents.map((a) => a.id)).not.toContain('custom-qa')
  })

  it('refuses to overwrite an existing default profile', () => {
    seedAgent('sr-architect')
    seedAgent('sr-developer')
    seedAgent('sr-reviewer')
    seedAgent('sr-merge-resolver')
    runMigration(projectPath)
    expect(() => runMigration(projectPath)).toThrow()
  })
})
