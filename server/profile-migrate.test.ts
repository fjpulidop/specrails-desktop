import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initDb, type DbInstance } from './db'
import { createProfile, getProfile, ProfileNotFoundError } from './modules/agents/runtime/profile-manager'

/**
 * Integration-flavor test for the migration endpoint's core logic: read
 * .claude/agents/*.md frontmatter, build a default profile, reject on
 * missing baseline agents. We exercise the filesystem + ProfileManager
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
function runMigration(projectPath: string): { ok: true } | { ok: false; error: string } {
  const agentsDir = path.join(projectPath, '.claude', 'agents')
  if (!fs.existsSync(agentsDir)) return { ok: false, error: 'no .claude/agents/ directory found' }
  const agents: Array<{ id: string; model: 'sonnet' | 'opus' | 'haiku' }> = []
  for (const entry of fs.readdirSync(agentsDir)) {
    if (!entry.endsWith('.md') || !entry.startsWith('sr-')) continue
    const id = entry.slice(0, -'.md'.length)
    let model: 'sonnet' | 'opus' | 'haiku' = 'sonnet'
    const body = fs.readFileSync(path.join(agentsDir, entry), 'utf8')
    const m = body.match(/^model:\s*(sonnet|opus|haiku)/m)
    if (m) model = m[1] as 'sonnet' | 'opus' | 'haiku'
    agents.push({ id, model })
  }
  const baseline = ['sr-architect', 'sr-developer', 'sr-reviewer', 'sr-merge-resolver']
  const missing = baseline.filter((id) => !agents.some((a) => a.id === id))
  if (missing.length > 0) return { ok: false, error: `missing: ${missing.join(', ')}` }
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

describe('profile migration from existing agent frontmatters', () => {
  it('creates a default profile mirroring the 4-agent baseline', () => {
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
    // merge-resolver is required
    const merge = profile.agents.find((a) => a.id === 'sr-merge-resolver')!
    expect(merge.required).toBe(true)
  })

  it('rejects when the baseline is incomplete (missing sr-reviewer)', () => {
    seedAgent('sr-architect')
    seedAgent('sr-developer')
    seedAgent('sr-merge-resolver')
    // sr-reviewer missing
    const result = runMigration(projectPath)
    expect(result.ok).toBe(false)
    if (result.ok === false) {
      expect(result.error).toContain('sr-reviewer')
    }
    expect(() => getProfile(projectPath, 'default')).toThrow(ProfileNotFoundError)
  })

  it('rejects when sr-merge-resolver is missing from the baseline', () => {
    seedAgent('sr-architect')
    seedAgent('sr-developer')
    seedAgent('sr-reviewer')
    const result = runMigration(projectPath)
    expect(result.ok).toBe(false)
    if (result.ok === false) {
      expect(result.error).toContain('sr-merge-resolver')
    }
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
