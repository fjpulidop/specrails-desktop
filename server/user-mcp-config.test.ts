import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readUserClaudeMcpServers,
  writeUserMcpConfig,
  buildUserMcpArgs,
  buildCodexReservedMcpArgs,
  codexDefinesReservedServer,
} from './user-mcp-config'
import { mkdirSync } from 'node:fs'

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

    it('never returns the reserved specrails entry (the person\'s unrestricted external bridge), in either scope', () => {
      writeClaudeConfig({
        mcpServers: { specrails: { command: 'node', args: ['specrails-mcp.js'] }, u: { command: 'u' } },
        projects: { '/repos/app': { mcpServers: { specrails: { command: 'node' }, l: { command: 'l' } } } },
      })
      expect(readUserClaudeMcpServers('/repos/app', home)).toEqual({ u: { command: 'u' }, l: { command: 'l' } })
    })

    it('buildUserMcpArgs injects nothing when specrails is the only approved server', () => {
      writeClaudeConfig({ mcpServers: { specrails: { command: 'node' } } })
      expect(buildUserMcpArgs({ adapterId: 'claude', projectPath: '/repos/app', slug: 'app', homeDir: home, baseDir: base })).toEqual([])
    })
  })

  describe('buildCodexReservedMcpArgs', () => {
    function writeCodexConfig(text: string): void {
      mkdirSync(join(home, '.codex'), { recursive: true })
      writeFileSync(join(home, '.codex', 'config.toml'), text, 'utf-8')
    }

    it('switches off a [mcp_servers.specrails] table for codex turns', () => {
      writeCodexConfig('model = "o3"\n\n[mcp_servers.specrails]\ncommand = "node"\nargs = ["x.js"]\n')
      expect(buildCodexReservedMcpArgs({ adapterId: 'codex', homeDir: home, env: {} })).toEqual(['-c', 'mcp_servers.specrails.enabled=false'])
    })

    it('honours CODEX_HOME', () => {
      const codexHome = join(home, 'alt')
      mkdirSync(codexHome, { recursive: true })
      writeFileSync(join(codexHome, 'config.toml'), '[mcp_servers."specrails"]\ncommand = "node"\n', 'utf-8')
      expect(buildCodexReservedMcpArgs({ adapterId: 'codex', homeDir: home, env: { CODEX_HOME: codexHome } })).toEqual(['-c', 'mcp_servers.specrails.enabled=false'])
    })

    it('adds nothing when no specrails server is defined (a partial table would break codex startup)', () => {
      writeCodexConfig('[mcp_servers.other]\ncommand = "x"\n[mcp_servers.specrails-docs]\ncommand = "y"\n')
      expect(buildCodexReservedMcpArgs({ adapterId: 'codex', homeDir: home, env: {} })).toEqual([])
      expect(buildCodexReservedMcpArgs({ adapterId: 'codex', homeDir: join(home, 'missing'), env: {} })).toEqual([])
    })

    it('is codex-only', () => {
      writeCodexConfig('[mcp_servers.specrails]\ncommand = "node"\n')
      expect(buildCodexReservedMcpArgs({ adapterId: 'claude', homeDir: home, env: {} })).toEqual([])
    })

    it('detects dotted and [mcp_servers] inline definitions', () => {
      expect(codexDefinesReservedServer('mcp_servers.specrails.command = "node"\n')).toBe(true)
      expect(codexDefinesReservedServer('[mcp_servers]\nspecrails = { command = "node" }\n')).toBe(true)
      expect(codexDefinesReservedServer('[profiles.x]\nspecrails = 1\n')).toBe(false)
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
