import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDb, createConversation, type DbInstance } from './db'
import {
  defaultBootScope, normalizeContextScope,
  getLastContextScope, setLastContextScope,
  setConversationContextScope, getConversationContextScope,
  buildSpecrailsTicketsSection, buildOpenSpecSpecsSection, buildScopedSystemPromptPrefix,
  toolFlagsForScope,
} from './context-scope'

describe('context-scope', () => {
  let db: DbInstance
  let tmpProject: string

  beforeEach(() => {
    db = initDb(':memory:')
    tmpProject = mkdtempSync(join(tmpdir(), 'ctxscope-'))
  })

  afterEach(() => {
    rmSync(tmpProject, { recursive: true, force: true })
  })

  describe('defaultBootScope', () => {
    it('Quick mode boots specrails ON, others OFF', () => {
      expect(defaultBootScope('quick')).toEqual({
        specrails: true, openspec: false, full: false, mcp: false, contractRefine: false, userMcp: false,
      })
    })

    it('Explore mode boots specrails+full ON, mcp+contractRefine OFF', () => {
      expect(defaultBootScope('explore')).toEqual({
        specrails: true, openspec: false, full: true, mcp: false, contractRefine: false, userMcp: false,
      })
    })
  })

  describe('normalizeContextScope', () => {
    const fb = { specrails: false, openspec: false, full: false, mcp: false, contractRefine: false, userMcp: false }

    it('returns fallback for non-object', () => {
      expect(normalizeContextScope(null, fb)).toEqual(fb)
      expect(normalizeContextScope('x', fb)).toEqual(fb)
      expect(normalizeContextScope(42, fb)).toEqual(fb)
    })

    it('drops unknown keys', () => {
      expect(normalizeContextScope({ specrails: true, foo: 'bar' }, fb))
        .toEqual({ ...fb, specrails: true })
    })

    it('non-boolean value falls back per key', () => {
      expect(normalizeContextScope({ specrails: 'yes', full: true }, fb))
        .toEqual({ ...fb, full: true })
    })

    it('passes through valid object', () => {
      expect(normalizeContextScope({ specrails: true, openspec: true, full: true, mcp: true, contractRefine: true }, fb))
        .toEqual({ specrails: true, openspec: true, full: true, mcp: true, contractRefine: true, userMcp: false })
    })

    it('preserves userMcp=true and falls back to false when absent', () => {
      expect(normalizeContextScope({ specrails: false, openspec: false, full: false, mcp: false, contractRefine: false, userMcp: true }, fb).userMcp)
        .toBe(true)
      // Missing userMcp falls back to fb.userMcp (false here).
      expect(normalizeContextScope({ specrails: true }, fb).userMcp).toBe(false)
      // Non-boolean userMcp falls back too.
      expect(normalizeContextScope({ userMcp: 'yes' }, { ...fb, userMcp: true }).userMcp).toBe(true)
    })
  })

  describe('get/setLastContextScope', () => {
    it('returns default boot when nothing persisted', () => {
      const scope = getLastContextScope(db, 'explore')
      expect(scope).toEqual({ specrails: true, openspec: false, full: true, mcp: false, contractRefine: false, userMcp: false })
    })

    it('default boot does not consult any project-level setting', () => {
      // The project-level explore_mcp_enabled and explore_contract_refine_enabled
      // toggles were removed; default boot is now derived exclusively from the
      // SpecMode argument.
      expect(getLastContextScope(db, 'explore').mcp).toBe(false)
      expect(getLastContextScope(db, 'explore').contractRefine).toBe(false)
    })

    it('persists and restores', () => {
      setLastContextScope(db, { specrails: false, openspec: true, full: false, mcp: true, contractRefine: true, userMcp: true })
      expect(getLastContextScope(db, 'explore')).toEqual({
        specrails: false, openspec: true, full: false, mcp: true, contractRefine: true, userMcp: true,
      })
    })

    it('survives invalid JSON in stored row', () => {
      db.prepare(`INSERT OR REPLACE INTO queue_state (key, value) VALUES ('add_spec_context_scope_last', 'not-json')`).run()
      const scope = getLastContextScope(db, 'explore')
      expect(scope.specrails).toBe(true) // fell back to default
    })

    it('Quick mode default boot has full=false', () => {
      expect(getLastContextScope(db, 'quick').full).toBe(false)
    })
  })

  describe('conversation context_scope', () => {
    it('round-trips', () => {
      createConversation(db, { id: 'c1', model: 'sonnet', kind: 'explore' })
      setConversationContextScope(db, 'c1', { specrails: true, openspec: true, full: false, mcp: true, contractRefine: true, userMcp: true })
      expect(getConversationContextScope(db, 'c1')).toEqual({
        specrails: true, openspec: true, full: false, mcp: true, contractRefine: true, userMcp: true,
      })
    })

    it('returns null when column is null', () => {
      createConversation(db, { id: 'c2', model: 'sonnet', kind: 'explore' })
      expect(getConversationContextScope(db, 'c2')).toBeNull()
    })

    it('createConversation persists contextScope directly', () => {
      createConversation(db, {
        id: 'c3', model: 'sonnet', kind: 'explore',
        contextScope: { specrails: false, openspec: false, full: true, mcp: false, contractRefine: false },
      })
      expect(getConversationContextScope(db, 'c3')).toEqual({
        specrails: false, openspec: false, full: true, mcp: false, contractRefine: false, userMcp: false,
      })
    })

    it('returns null when context_scope contains malformed JSON', () => {
      createConversation(db, { id: 'c4', model: 'sonnet', kind: 'explore' })
      db.prepare(`UPDATE chat_conversations SET context_scope = ? WHERE id = ?`).run('{bad', 'c4')
      expect(getConversationContextScope(db, 'c4')).toBeNull()
    })
  })

  describe('spec concat', () => {
    it('returns null for empty project', () => {
      expect(buildSpecrailsTicketsSection(tmpProject)).toBeNull()
      expect(buildOpenSpecSpecsSection(tmpProject)).toBeNull()
    })

    it('builds specrails section from local-tickets.json', () => {
      const dir = join(tmpProject, '.specrails')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'local-tickets.json'), JSON.stringify({
        tickets: [
          { id: 1, title: 'Feature A', status: 'todo', priority: 'high', labels: ['ui'], description: 'body A' },
          { id: 2, title: 'Feature B', status: 'done', priority: 'low', labels: [], description: 'body B' },
        ],
      }))
      const section = buildSpecrailsTicketsSection(tmpProject)
      expect(section).toContain('## Specrails Tickets')
      expect(section).toContain('#1 · Feature A')
      expect(section).toContain('status: todo')
      expect(section).toContain('#2 · Feature B')
    })

    it('handles object-keyed-by-id form (schema 1.1)', () => {
      const dir = join(tmpProject, '.specrails')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'local-tickets.json'), JSON.stringify({
        schema_version: '1.1',
        tickets: {
          '1': { id: 1, title: 'Keyed A', status: 'todo', priority: 'low', labels: [], description: 'aa' },
          '2': { id: 2, title: 'Keyed B', status: 'done', priority: 'high', labels: ['x'], description: 'bb' },
        },
      }))
      const section = buildSpecrailsTicketsSection(tmpProject)
      expect(section).toContain('#1 · Keyed A')
      expect(section).toContain('#2 · Keyed B')
    })

    it('handles bare array form', () => {
      const dir = join(tmpProject, '.specrails')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'local-tickets.json'), JSON.stringify([
        { id: 7, title: 'Direct', status: 'todo', priority: 'medium', labels: [], description: '' },
      ]))
      expect(buildSpecrailsTicketsSection(tmpProject)).toContain('#7 · Direct')
    })

    it('returns null on malformed JSON', () => {
      const dir = join(tmpProject, '.specrails')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'local-tickets.json'), '{nope')
      expect(buildSpecrailsTicketsSection(tmpProject)).toBeNull()
    })

    it('builds openspec section only from spec.md files', () => {
      const a = join(tmpProject, 'openspec', 'specs', 'foo')
      mkdirSync(a, { recursive: true })
      writeFileSync(join(a, 'spec.md'), '# foo spec')
      writeFileSync(join(a, 'README.md'), 'not a spec')
      const section = buildOpenSpecSpecsSection(tmpProject)
      expect(section).toContain('## OpenSpec Specs')
      expect(section).toContain('foo spec')
      expect(section).not.toContain('not a spec')
    })

    it('buildScopedSystemPromptPrefix returns empty when both off', () => {
      expect(buildScopedSystemPromptPrefix(
        { specrails: false, openspec: false, full: false, mcp: false },
        tmpProject,
      )).toBe('')
    })

    it('buildScopedSystemPromptPrefix joins both sections when both on', () => {
      mkdirSync(join(tmpProject, '.specrails'), { recursive: true })
      writeFileSync(join(tmpProject, '.specrails', 'local-tickets.json'),
        JSON.stringify({ tickets: [{ id: 1, title: 'X', status: 'todo', priority: 'low', labels: [], description: 'x' }] }))
      const od = join(tmpProject, 'openspec', 'specs', 'cap')
      mkdirSync(od, { recursive: true })
      writeFileSync(join(od, 'spec.md'), 'osx')
      const out = buildScopedSystemPromptPrefix(
        { specrails: true, openspec: true, full: false, mcp: false },
        tmpProject,
      )
      expect(out).toContain('## Specrails Tickets')
      expect(out).toContain('## OpenSpec Specs')
    })

    it('truncates with marker on overflow', () => {
      const dir = join(tmpProject, '.specrails')
      mkdirSync(dir, { recursive: true })
      // Build many tickets to overflow the 120k byte cap.
      const tickets = []
      for (let i = 0; i < 200; i++) {
        tickets.push({ id: i, title: `t${i}`, status: 'todo', priority: 'low', labels: [], description: 'x'.repeat(1000) })
      }
      writeFileSync(join(dir, 'local-tickets.json'), JSON.stringify({ tickets }))
      const section = buildSpecrailsTicketsSection(tmpProject)
      expect(section).toContain('(truncated)')
    })
  })

  describe('toolFlagsForScope', () => {
    it('full=true → --tools Read,Grep,Glob (no Bash)', () => {
      expect(toolFlagsForScope({ specrails: false, openspec: false, full: true, mcp: false }).args)
        .toEqual(['--tools', 'Read,Grep,Glob'])
    })

    it('full=false → --tools __none__ (effectively no tools)', () => {
      expect(toolFlagsForScope({ specrails: false, openspec: false, full: false, mcp: false }).args)
        .toEqual(['--tools', '__none__'])
    })

    it('never includes Bash', () => {
      const a = toolFlagsForScope({ specrails: false, openspec: false, full: true, mcp: false }).args
      expect(a.join(',')).not.toContain('Bash')
    })

    it('high tier (full + mcp) → --disallowedTools writers, NO --tools restriction', () => {
      const a = toolFlagsForScope({ specrails: false, openspec: false, full: true, mcp: true }).args
      expect(a).toEqual(['--disallowedTools', 'Write,Edit,NotebookEdit'])
      // No `--tools Read,Grep,Glob` restriction → Bash + MCP tools stay in the toolkit.
      expect(a).not.toContain('--tools')
    })

    it('high tier (full + userMcp) → --disallowedTools writers (approved-MCPs path)', () => {
      const a = toolFlagsForScope({ specrails: false, openspec: false, full: true, mcp: false, userMcp: true } as never).args
      expect(a).toEqual(['--disallowedTools', 'Write,Edit,NotebookEdit'])
    })

    it('userMcp without full stays locked down (no high-tier capability)', () => {
      const a = toolFlagsForScope({ specrails: false, openspec: false, full: false, mcp: false, userMcp: true } as never).args
      expect(a).toEqual(['--tools', '__none__'])
    })
  })
})
