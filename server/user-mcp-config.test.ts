import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readUserClaudeMcpServers,
  writeUserMcpConfig,
  buildUserMcpArgs,
} from './user-mcp-config'

describe('user-mcp-config', () => {
  let home: string
  let base: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'umc-home-'))
    base = mkdtempSync(join(tmpdir(), 'umc-base-'))
  })

  afterEach(() => {
    try { rmSync(home, { recursive: true, force: true }) } catch {}
    try { rmSync(base, { recursive: true, force: true }) } catch {}
  })

  function writeClaudeConfig(obj: unknown): void {
    writeFileSync(join(home, '.claude.json'), JSON.stringify(obj), 'utf-8')
  }

  describe('readUserClaudeMcpServers', () => {
    it('returns {} when ~/.claude.json is missing', () => {
      expect(readUserClaudeMcpServers('/some/project', home)).toEqual({})
    })

    it('returns {} on malformed JSON', () => {
      writeFileSync(join(home, '.claude.json'), '{not json', 'utf-8')
      expect(readUserClaudeMcpServers('/some/project', home)).toEqual({})
    })

    it('returns {} when there are no mcpServers anywhere', () => {
      writeClaudeConfig({ numStartups: 3, projects: {} })
      expect(readUserClaudeMcpServers('/some/project', home)).toEqual({})
    })

    it('returns user-scope (top-level) mcpServers', () => {
      writeClaudeConfig({
        mcpServers: { ctx7: { command: 'npx', args: ['ctx7'] } },
        projects: {},
      })
      expect(readUserClaudeMcpServers('/p', home)).toEqual({
        ctx7: { command: 'npx', args: ['ctx7'] },
      })
    })

    it('returns project local-scope mcpServers keyed by the project path', () => {
      writeClaudeConfig({
        projects: {
          '/repos/app': { mcpServers: { local1: { command: 'node', args: ['x.js'] } } },
          '/repos/other': { mcpServers: { other: { command: 'node' } } },
        },
      })
      expect(readUserClaudeMcpServers('/repos/app', home)).toEqual({
        local1: { command: 'node', args: ['x.js'] },
      })
    })

    it('merges user + local scope, local wins on key conflict', () => {
      writeClaudeConfig({
        mcpServers: {
          shared: { command: 'USER' },
          userOnly: { command: 'u' },
        },
        projects: {
          '/repos/app': {
            mcpServers: {
              shared: { command: 'LOCAL' },
              localOnly: { command: 'l' },
            },
          },
        },
      })
      expect(readUserClaudeMcpServers('/repos/app', home)).toEqual({
        shared: { command: 'LOCAL' },
        userOnly: { command: 'u' },
        localOnly: { command: 'l' },
      })
    })

    it('handles a project entry without an mcpServers field', () => {
      writeClaudeConfig({
        mcpServers: { u: { command: 'u' } },
        projects: { '/repos/app': { allowedTools: [] } },
      })
      expect(readUserClaudeMcpServers('/repos/app', home)).toEqual({ u: { command: 'u' } })
    })
  })

  describe('writeUserMcpConfig', () => {
    it('writes a { mcpServers } file under <base>/<slug> and returns the path', () => {
      const servers = { foo: { command: 'npx', args: ['foo'] } }
      const file = writeUserMcpConfig(servers, 'my-slug', base)
      expect(file).toBe(join(base, 'my-slug', 'user-mcp.json'))
      expect(existsSync(file)).toBe(true)
      expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ mcpServers: servers })
    })

    it('writes the file with no group/other permission bits (POSIX)', () => {
      if (process.platform === 'win32') return
      const file = writeUserMcpConfig({ a: { command: 'a' } }, 's', base)
      const mode = statSync(file).mode
      expect(mode & 0o077).toBe(0)
    })

    it('tightens permissions on a PRE-EXISTING loose-perm file (chmod after write)', () => {
      if (process.platform === 'win32') return
      const fs = require('node:fs') as typeof import('node:fs')
      const dir = join(base, 'reused')
      fs.mkdirSync(dir, { recursive: true })
      const file = join(dir, 'user-mcp.json')
      // Pre-create with world-readable/writable perms. `writeFileSync`'s `mode`
      // is ignored for an existing file, so without the explicit chmod the loose
      // bits would survive.
      fs.writeFileSync(file, '{}', { mode: 0o666 })
      fs.chmodSync(file, 0o666)
      expect(statSync(file).mode & 0o077).not.toBe(0)

      writeUserMcpConfig({ a: { command: 'a' } }, 'reused', base)

      const mode = statSync(file).mode
      expect(mode & 0o077).toBe(0)
      expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({
        mcpServers: { a: { command: 'a' } },
      })
    })

    it('throws on an unsafe slug (path-traversal defence-in-depth)', () => {
      expect(() => writeUserMcpConfig({ a: { command: 'a' } }, '../../etc', base)).toThrow(/unsafe project slug/)
      expect(() => writeUserMcpConfig({ a: { command: 'a' } }, 'a/b', base)).toThrow(/unsafe project slug/)
      expect(() => writeUserMcpConfig({ a: { command: 'a' } }, '', base)).toThrow(/unsafe project slug/)
    })
  })

  describe('buildUserMcpArgs', () => {
    it('returns [] for non-claude providers (codex reads ~/.codex natively)', () => {
      writeClaudeConfig({ mcpServers: { foo: { command: 'foo' } } })
      expect(buildUserMcpArgs({ adapterId: 'codex', projectPath: '/p', slug: 's', homeDir: home, baseDir: base })).toEqual([])
    })

    it('returns [] for claude when the user has no approved servers', () => {
      // no ~/.claude.json at all
      expect(buildUserMcpArgs({ adapterId: 'claude', projectPath: '/p', slug: 's', homeDir: home, baseDir: base })).toEqual([])
    })

    it('returns --mcp-config pointing at a written file when claude has servers', () => {
      writeClaudeConfig({ mcpServers: { foo: { command: 'npx', args: ['foo'] } } })
      const args = buildUserMcpArgs({ adapterId: 'claude', projectPath: '/p', slug: 's', homeDir: home, baseDir: base })
      expect(args[0]).toBe('--mcp-config')
      expect(args).toHaveLength(2)
      const file = args[1]
      expect(existsSync(file)).toBe(true)
      expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({
        mcpServers: { foo: { command: 'npx', args: ['foo'] } },
      })
    })

    it('returns [] (never throws) when the config file cannot be written', () => {
      writeClaudeConfig({ mcpServers: { foo: { command: 'foo' } } })
      // baseDir points at a regular file → mkdirSync(<file>/<slug>) throws ENOTDIR.
      const fileAsBase = join(base, 'not-a-dir')
      writeFileSync(fileAsBase, 'x', 'utf-8')
      expect(buildUserMcpArgs({ adapterId: 'claude', projectPath: '/p', slug: 's', homeDir: home, baseDir: fileAsBase })).toEqual([])
    })

    it('returns [] (swallows the throw) for an unsafe slug', () => {
      writeClaudeConfig({ mcpServers: { foo: { command: 'foo' } } })
      expect(buildUserMcpArgs({ adapterId: 'claude', projectPath: '/p', slug: '../../../etc/passwd', homeDir: home, baseDir: base })).toEqual([])
    })
  })
})
