import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { applyContributors, contributorPaths, revertContributors, SHARED_FILE_CONTRIBUTORS } from './contributors'
import type { Plugin } from '../types'

let projectPath: string

function makePlugin(claudeMdInstructions?: string): Plugin {
  return {
    manifest: {
      name: 'serena',
      version: '1.0.0',
      description: '',
      whatItDoes: [],
      owns: { mcpServers: ['serena'] },
      claudeMdInstructions,
    },
    install: async () => {},
    uninstall: async () => {},
    verify: async () => ({ ok: true, checkedAt: new Date().toISOString() }),
  }
}

beforeEach(() => { projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'contrib-')) })
afterEach(() => { fs.rmSync(projectPath, { recursive: true, force: true }) })

describe('contributors registry', () => {
  it('instructions-md contributor present (replaces the legacy claude-md id from before §14)', () => {
    expect(SHARED_FILE_CONTRIBUTORS.find((c) => c.id === 'instructions-md')).toBeDefined()
  })
})

describe('contributorPaths', () => {
  it('returns empty when plugin contributes nothing', () => {
    expect(contributorPaths(makePlugin())).toEqual([])
  })

  it('returns CLAUDE.md when plugin has claudeMdInstructions', () => {
    expect(contributorPaths(makePlugin('## hello'))).toEqual(['CLAUDE.md'])
  })

  it('returns empty when claudeMdInstructions is whitespace-only', () => {
    expect(contributorPaths(makePlugin('   \n  '))).toEqual([])
  })
})

describe('applyContributors / revertContributors', () => {
  it('apply writes CLAUDE.md with the plugin block; revert removes it', async () => {
    const plugin = makePlugin('## serena hint')
    const touched = await applyContributors(plugin, projectPath)
    expect(touched).toEqual(['CLAUDE.md'])
    const text = fs.readFileSync(path.join(projectPath, 'CLAUDE.md'), 'utf8')
    expect(text).toContain('## serena hint')
    expect(text).toContain('specrails-desktop-managed:serena')

    await revertContributors(plugin, projectPath)
    // CLAUDE.md is deleted when the only content was the managed block.
    const claudeMd = path.join(projectPath, 'CLAUDE.md')
    if (fs.existsSync(claudeMd)) {
      const after = fs.readFileSync(claudeMd, 'utf8')
      expect(after).not.toContain('serena hint')
      expect(after).not.toContain('specrails-desktop-managed:serena')
    }
  })

  it('apply is idempotent (multiple calls produce same content)', async () => {
    const plugin = makePlugin('## hint')
    await applyContributors(plugin, projectPath)
    await applyContributors(plugin, projectPath)
    const text = fs.readFileSync(path.join(projectPath, 'CLAUDE.md'), 'utf8')
    const occurrences = (text.match(/specrails-desktop-managed:serena:start/g) || []).length
    expect(occurrences).toBe(1)
  })

  it('apply for plugin A does not touch plugin B block', async () => {
    const a = makePlugin('A content')
    a.manifest.name = 'a'
    const b = makePlugin('B content')
    b.manifest.name = 'b'
    await applyContributors(a, projectPath)
    await applyContributors(b, projectPath)
    await revertContributors(a, projectPath)
    const text = fs.readFileSync(path.join(projectPath, 'CLAUDE.md'), 'utf8')
    expect(text).not.toContain('A content')
    expect(text).toContain('B content')
  })

  it('plugin without claudeMdInstructions skips contributor (no file created)', async () => {
    const plugin = makePlugin()
    const touched = await applyContributors(plugin, projectPath)
    expect(touched).toEqual([])
    expect(fs.existsSync(path.join(projectPath, 'CLAUDE.md'))).toBe(false)
  })

  it('writes AGENTS.md instead of CLAUDE.md when providerId=codex', async () => {
    const plugin = makePlugin('## codex-aware hint')
    const touched = await applyContributors(plugin, projectPath, 'codex')
    expect(touched).toEqual(['AGENTS.md'])
    expect(fs.existsSync(path.join(projectPath, 'AGENTS.md'))).toBe(true)
    expect(fs.existsSync(path.join(projectPath, 'CLAUDE.md'))).toBe(false)
    const agentsMd = fs.readFileSync(path.join(projectPath, 'AGENTS.md'), 'utf8')
    expect(agentsMd).toContain('## codex-aware hint')
    expect(agentsMd).toContain('specrails-desktop-managed:serena')

    await revertContributors(plugin, projectPath, 'codex')
    // AGENTS.md deleted when only managed block was its content
    const agentsMdPath = path.join(projectPath, 'AGENTS.md')
    if (fs.existsSync(agentsMdPath)) {
      const after = fs.readFileSync(agentsMdPath, 'utf8')
      expect(after).not.toContain('specrails-desktop-managed:serena')
    }
  })

  it('writes Kimi guidance to .kimi-code/AGENTS.md without touching Codex AGENTS.md', async () => {
    const plugin = makePlugin('## kimi-aware hint')
    const touched = await applyContributors(plugin, projectPath, 'kimi')
    const relativePath = path.join('.kimi-code', 'AGENTS.md')
    const kimiAgentsPath = path.join(projectPath, relativePath)

    expect(touched).toEqual([relativePath])
    expect(fs.readFileSync(kimiAgentsPath, 'utf8')).toContain('## kimi-aware hint')
    expect(fs.existsSync(path.join(projectPath, 'AGENTS.md'))).toBe(false)

    await revertContributors(plugin, projectPath, 'kimi')
    expect(fs.existsSync(kimiAgentsPath)).toBe(false)
  })

  it('contributorPaths reflects each provider instruction path', () => {
    expect(contributorPaths(makePlugin('## x'))).toEqual(['CLAUDE.md'])
    expect(contributorPaths(makePlugin('## x'), 'claude')).toEqual(['CLAUDE.md'])
    expect(contributorPaths(makePlugin('## x'), 'codex')).toEqual(['AGENTS.md'])
    expect(contributorPaths(makePlugin('## x'), 'kimi'))
      .toEqual([path.join('.kimi-code', 'AGENTS.md')])
  })

  it('unknown providerId falls back to CLAUDE.md gracefully', () => {
    expect(contributorPaths(makePlugin('## x'), 'turbofake')).toEqual(['CLAUDE.md'])
  })
})
