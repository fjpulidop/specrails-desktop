import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { detectMcpDrift } from './drift'
import type { Plugin } from '../types'

let projectPath: string

function makePlugin(expected?: Record<string, unknown>): Plugin {
  return {
    manifest: { name: 'serena', version: '1', description: '', whatItDoes: [], owns: { mcpServers: ['serena'] } },
    install: async () => {},
    uninstall: async () => {},
    verify: async () => ({ ok: true, checkedAt: new Date().toISOString() }),
    expectedMcpEntry: expected ? () => expected : undefined,
  }
}

beforeEach(() => { projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-')) })
afterEach(() => { fs.rmSync(projectPath, { recursive: true, force: true }) })

describe('detectMcpDrift', () => {
  it('returns false when plugin has no expectedMcpEntry', () => {
    expect(detectMcpDrift(projectPath, makePlugin())).toBe(false)
  })

  it('returns false when .mcp.json is missing', () => {
    expect(detectMcpDrift(projectPath, makePlugin({ a: 1 }))).toBe(false)
  })

  it('returns false when on-disk entry matches expected', () => {
    fs.writeFileSync(path.join(projectPath, '.mcp.json'), JSON.stringify({ mcpServers: { serena: { a: 1 } } }))
    expect(detectMcpDrift(projectPath, makePlugin({ a: 1 }))).toBe(false)
  })

  it('returns true when on-disk entry differs', () => {
    fs.writeFileSync(path.join(projectPath, '.mcp.json'), JSON.stringify({ mcpServers: { serena: { a: 999 } } }))
    expect(detectMcpDrift(projectPath, makePlugin({ a: 1 }))).toBe(true)
  })

  it('returns false when owned key absent in .mcp.json (plugin not yet installed)', () => {
    fs.writeFileSync(path.join(projectPath, '.mcp.json'), JSON.stringify({ mcpServers: { other: {} } }))
    expect(detectMcpDrift(projectPath, makePlugin({ a: 1 }))).toBe(false)
  })

  it('returns false when .mcp.json malformed', () => {
    fs.writeFileSync(path.join(projectPath, '.mcp.json'), '{not')
    expect(detectMcpDrift(projectPath, makePlugin({ a: 1 }))).toBe(false)
  })

  it('checks Kimi drift against .kimi-code/mcp.json', () => {
    const dir = path.join(projectPath, '.kimi-code')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({
      mcpServers: { serena: { a: 999 } },
    }))
    expect(detectMcpDrift(projectPath, makePlugin({ a: 1 }), 'kimi')).toBe(true)
  })

  it('checks contributor drift against Kimi native .kimi-code/AGENTS.md', () => {
    const plugin = makePlugin({ a: 1 })
    plugin.manifest.claudeMdInstructions = 'expected instructions'
    const dir = path.join(projectPath, '.kimi-code')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({
      mcpServers: { serena: { a: 1 } },
    }))
    const agentsPath = path.join(dir, 'AGENTS.md')
    fs.writeFileSync(agentsPath, [
      '<!-- specrails-desktop-managed:serena:start -->',
      'expected instructions',
      '<!-- specrails-desktop-managed:serena:end -->',
      '',
    ].join('\n'))

    expect(detectMcpDrift(projectPath, plugin, 'kimi')).toBe(false)

    fs.writeFileSync(agentsPath, [
      '<!-- specrails-desktop-managed:serena:start -->',
      'stale instructions',
      '<!-- specrails-desktop-managed:serena:end -->',
      '',
    ].join('\n'))
    expect(detectMcpDrift(projectPath, plugin, 'kimi')).toBe(true)
  })
})
