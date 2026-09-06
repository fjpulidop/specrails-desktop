import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  ensureWorkspace,
  removeWorkspace,
  workspacePathFor,
  assembleWorkspaceFramework,
  ensureFrameworkAgents,
  ensureFrameworkCommandSubtrees,
} from './workspace-manager'
import { FrameworkManager } from './framework-manager'
import { coreUpdatePendingPath } from './core-update-state'

describe('workspace-manager', () => {
  let home: string
  let projectRoot: string

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-home-'))
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-project-'))
    fs.writeFileSync(path.join(projectRoot, 'README.md'), '# user project (must not be touched)\n')
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true })
    fs.writeFileSync(path.join(projectRoot, 'src', 'foo.ts'), 'export const foo = 1\n')
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(projectRoot, { recursive: true, force: true })
  })

  function activate(version: string): void {
    const current = path.join(home, '.specrails', 'framework', 'current')
    try { fs.unlinkSync(current) } catch { /* first fixture */ }
    fs.symlinkSync(version, current)
  }

  it('workspacePathFor composes the expected path', () => {
    expect(workspacePathFor('myslug', home)).toBe(
      path.join(home, '.specrails', 'projects', 'myslug', 'workspace'),
    )
  })
  it('blocks implementation repair while a workspace Core migration is pending on every platform', () => {
    const ws = workspacePathFor('pending', home)
    fs.mkdirSync(path.dirname(coreUpdatePendingPath(ws)), { recursive: true })
    fs.writeFileSync(coreUpdatePendingPath(ws), '{"version":"5.0.0"}')
    expect(() => ensureFrameworkAgents(ws, '.claude', home)).toThrow(/unfinished Core update/)
    expect(() => ensureFrameworkCommandSubtrees(ws, '.claude', home)).toThrow(/unfinished Core update/)
  })

  describe('ensureFrameworkAgents (win32 repair)', () => {
    const ORIG = process.platform
    const win32 = () => Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    afterEach(() => Object.defineProperty(process, 'platform', { value: ORIG, configurable: true }))

    function seedFramework(version = '4.10.0', agents = ['sr-architect', 'sr-developer', 'sr-reviewer']): void {
      const dir = path.join(home, '.specrails', 'framework', version, '.claude', 'agents')
      fs.mkdirSync(dir, { recursive: true })
      for (const a of agents) fs.writeFileSync(path.join(dir, `${a}.md`), `# ${a}\n`)
      activate(version)
    }

    it('copies the framework sr-* agents from the version dir into an empty workspace', () => {
      win32()
      seedFramework()
      const ws = workspacePathFor('acme', home)
      fs.mkdirSync(path.join(ws, '.claude', 'agents'), { recursive: true })
      expect(ensureFrameworkAgents(ws, '.claude', home)).toBe(3)
      expect(fs.existsSync(path.join(ws, '.claude', 'agents', 'sr-architect.md'))).toBe(true)
      expect(fs.readFileSync(path.join(ws, '.claude', 'agents', 'sr-developer.md'), 'utf8')).toBe('# sr-developer\n')
    })

    it('preserves user custom-*.md and is idempotent', () => {
      win32()
      seedFramework()
      const ws = workspacePathFor('acme', home)
      const agentsDir = path.join(ws, '.claude', 'agents')
      fs.mkdirSync(agentsDir, { recursive: true })
      fs.writeFileSync(path.join(agentsDir, 'custom-mine.md'), 'mine\n')
      expect(ensureFrameworkAgents(ws, '.claude', home)).toBe(3)
      expect(fs.readFileSync(path.join(agentsDir, 'custom-mine.md'), 'utf8')).toBe('mine\n') // preserved
      expect(ensureFrameworkAgents(ws, '.claude', home)).toBe(0) // idempotent
    })

    it('uses the activated framework and ignores a newer unpublished stage', () => {
      win32()
      seedFramework('4.9.0', ['sr-architect'])
      seedFramework('4.10.0', ['sr-architect', 'sr-developer'])
      activate('4.9.0')
      const ws = workspacePathFor('acme', home)
      expect(ensureFrameworkAgents(ws, '.claude', home)).toBe(1) // active 4.9.0; 4.10.0 was never published
    })

    it('is a NO-OP on POSIX (the assemble symlinks already populate agents)', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
      seedFramework()
      const ws = workspacePathFor('acme', home)
      expect(ensureFrameworkAgents(ws, '.claude', home)).toBe(0)
      expect(fs.existsSync(path.join(ws, '.claude', 'agents', 'sr-architect.md'))).toBe(false)
    })

    it('no-op when the framework agents source is absent', () => {
      win32()
      const ws = workspacePathFor('acme', home)
      expect(ensureFrameworkAgents(ws, '.claude', home)).toBe(0)
    })
  })

  describe('ensureFrameworkCommandSubtrees (win32 repair for /specrails:* commands)', () => {
    const ORIG = process.platform
    const win32 = () => Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    afterEach(() => Object.defineProperty(process, 'platform', { value: ORIG, configurable: true }))

    function seedSubtrees(version = '4.11.0'): string {
      const base = path.join(home, '.specrails', 'framework', version, '.claude')
      // Namespaced command: /specrails:implement → commands/specrails/implement.md
      fs.mkdirSync(path.join(base, 'commands', 'specrails'), { recursive: true })
      fs.writeFileSync(path.join(base, 'commands', 'specrails', 'implement.md'), '# implement\n')
      fs.writeFileSync(path.join(base, 'commands', 'top.md'), '# top\n')
      fs.mkdirSync(path.join(base, 'skills'), { recursive: true })
      fs.writeFileSync(path.join(base, 'skills', 'a.md'), '# a\n')
      fs.mkdirSync(path.join(base, 'rules'), { recursive: true })
      fs.writeFileSync(path.join(base, 'rules', 'layer.md'), '# rules\n')
      activate(version)
      return base
    }

    function seedKimiSubtrees(version = '4.12.0'): string {
      const base = path.join(home, '.specrails', 'framework', version, '.kimi-code')
      fs.mkdirSync(path.join(base, 'rules'), { recursive: true })
      fs.writeFileSync(path.join(base, 'rules', 'specrails.md'), '# kimi rules\n')
      fs.mkdirSync(path.join(base, 'specrails'), { recursive: true })
      fs.writeFileSync(path.join(base, 'specrails', 'run-skill.mjs'), '// managed runner\n')

      for (const [name, contents] of [
        ['specrails-implement', '# managed workflow\n'],
        ['sr-architect', '# managed role\n'],
        // These deliberately exist in the framework fixture: the repair must
        // still refuse to copy non-Core ownership prefixes.
        ['openspec-source-only', '# upstream OpenSpec\n'],
        ['custom-source-only', '# user custom\n'],
        ['third-party-source-only', '# unknown owner\n'],
      ]) {
        const skill = path.join(base, 'skills', name)
        fs.mkdirSync(skill, { recursive: true })
        fs.writeFileSync(path.join(skill, 'SKILL.md'), contents)
      }
      activate(version)
      return base
    }

    it('recursively copies commands/skills/rules when the workspace has none (broken junction)', () => {
      win32()
      seedSubtrees()
      const ws = workspacePathFor('acme', home)
      fs.mkdirSync(path.join(ws, '.claude'), { recursive: true })
      expect(ensureFrameworkCommandSubtrees(ws, '.claude', home)).toBe(3)
      // The namespaced command that produced "Unknown command" now exists.
      expect(fs.readFileSync(path.join(ws, '.claude', 'commands', 'specrails', 'implement.md'), 'utf8')).toBe('# implement\n')
      expect(fs.existsSync(path.join(ws, '.claude', 'commands', 'top.md'))).toBe(true)
      expect(fs.existsSync(path.join(ws, '.claude', 'skills', 'a.md'))).toBe(true)
      expect(fs.existsSync(path.join(ws, '.claude', 'rules', 'layer.md'))).toBe(true)
    })

    it('heals an UNREADABLE dir-symlink (points at a missing target) by replacing it with a real copy', () => {
      win32()
      seedSubtrees()
      const ws = workspacePathFor('acme', home)
      const claudeDir = path.join(ws, '.claude')
      fs.mkdirSync(claudeDir, { recursive: true })
      // Simulate the broken assemble link: a symlink to a non-existent target
      // (readdir throws → treated as unreadable). Skip if the FS can't symlink.
      try {
        fs.symlinkSync(path.join(home, 'does-not-exist'), path.join(claudeDir, 'commands'), 'junction')
      } catch {
        return
      }
      const healed = ensureFrameworkCommandSubtrees(ws, '.claude', home)
      expect(healed).toBeGreaterThanOrEqual(1)
      expect(fs.readFileSync(path.join(claudeDir, 'commands', 'specrails', 'implement.md'), 'utf8')).toBe('# implement\n')
    })

    it('leaves an already-populated dir untouched (idempotent, never deletes through a working link)', () => {
      win32()
      seedSubtrees()
      const ws = workspacePathFor('acme', home)
      const cmds = path.join(ws, '.claude', 'commands', 'specrails')
      fs.mkdirSync(cmds, { recursive: true })
      fs.writeFileSync(path.join(cmds, 'implement.md'), '# already here\n')
      // skills + rules missing → those two heal; commands is populated → skipped.
      expect(ensureFrameworkCommandSubtrees(ws, '.claude', home)).toBe(2)
      expect(fs.readFileSync(path.join(cmds, 'implement.md'), 'utf8')).toBe('# already here\n')
    })

    it('repairs Kimi runner plus managed skill children without replacing the merged skills root', () => {
      win32()
      seedKimiSubtrees()
      const ws = workspacePathFor('kimi-acme', home)
      const skills = path.join(ws, '.kimi-code', 'skills')
      fs.mkdirSync(skills, { recursive: true })

      // Simulate Core's per-child links through an untraversable `current`
      // junction: the merged root remains listable but managed children break.
      fs.symlinkSync(
        path.join(home, 'missing-specrails-implement'),
        path.join(skills, 'specrails-implement'),
        'dir',
      )
      fs.symlinkSync(
        path.join(home, 'missing-sr-architect'),
        path.join(skills, 'sr-architect'),
        'dir',
      )

      for (const [name, contents] of [
        ['openspec-apply-change', '# keep OpenSpec\n'],
        ['custom-local', '# keep custom\n'],
        ['unknown-local', '# keep unknown\n'],
      ]) {
        const skill = path.join(skills, name)
        fs.mkdirSync(skill, { recursive: true })
        fs.writeFileSync(path.join(skill, 'SKILL.md'), contents)
      }

      expect(ensureFrameworkCommandSubtrees(ws, '.kimi-code', home)).toBe(4)
      expect(
        fs.readFileSync(path.join(ws, '.kimi-code', 'specrails', 'run-skill.mjs'), 'utf8'),
      ).toBe('// managed runner\n')
      expect(
        fs.readFileSync(path.join(skills, 'specrails-implement', 'SKILL.md'), 'utf8'),
      ).toBe('# managed workflow\n')
      expect(
        fs.readFileSync(path.join(skills, 'sr-architect', 'SKILL.md'), 'utf8'),
      ).toBe('# managed role\n')
      expect(fs.readFileSync(path.join(skills, 'openspec-apply-change', 'SKILL.md'), 'utf8')).toBe('# keep OpenSpec\n')
      expect(fs.readFileSync(path.join(skills, 'custom-local', 'SKILL.md'), 'utf8')).toBe('# keep custom\n')
      expect(fs.readFileSync(path.join(skills, 'unknown-local', 'SKILL.md'), 'utf8')).toBe('# keep unknown\n')
      expect(fs.existsSync(path.join(skills, 'openspec-source-only'))).toBe(false)
      expect(fs.existsSync(path.join(skills, 'custom-source-only'))).toBe(false)
      expect(fs.existsSync(path.join(skills, 'third-party-source-only'))).toBe(false)
      expect(fs.existsSync(path.join(ws, '.kimi-code', 'commands'))).toBe(false)
      expect(fs.existsSync(path.join(ws, '.kimi-code', 'agents'))).toBe(false)

      // Every repaired unit is now a readable real directory; the operation is
      // idempotent and the user-owned children remain untouched.
      expect(ensureFrameworkCommandSubtrees(ws, '.kimi-code', home)).toBe(0)
    })

    it('is a NO-OP on POSIX (assemble symlinks resolve normally)', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
      seedSubtrees()
      const ws = workspacePathFor('acme', home)
      expect(ensureFrameworkCommandSubtrees(ws, '.claude', home)).toBe(0)
      expect(fs.existsSync(path.join(ws, '.claude', 'commands'))).toBe(false)
    })

    it('no-op when the framework subtree source is absent', () => {
      win32()
      const ws = workspacePathFor('acme', home)
      expect(ensureFrameworkCommandSubtrees(ws, '.claude', home)).toBe(0)
    })
  })

  it('BUG-ARTREG-01: honors SPECRAILS_REGISTRY_HOME (matches artifact-registry) when no explicit home is threaded', () => {
    const prev = process.env.SPECRAILS_REGISTRY_HOME
    process.env.SPECRAILS_REGISTRY_HOME = home
    try {
      // No explicit home arg → must resolve through resolveHome() and land in the
      // SAME tree the registry uses, not os.homedir().
      expect(workspacePathFor('envslug')).toBe(
        path.join(home, '.specrails', 'projects', 'envslug', 'workspace'),
      )
      const ws = ensureWorkspace('envslug2', projectRoot)
      expect(ws).toBe(path.join(home, '.specrails', 'projects', 'envslug2', 'workspace'))
      expect(fs.existsSync(ws)).toBe(true)
      expect(fs.lstatSync(path.join(ws, 'project')).isSymbolicLink()).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.SPECRAILS_REGISTRY_HOME
      else process.env.SPECRAILS_REGISTRY_HOME = prev
    }
  })

  it('ensureWorkspace creates the dir and a project symlink to the repo', () => {
    const ws = ensureWorkspace('proj1', projectRoot, home)
    expect(ws).toBe(workspacePathFor('proj1', home))
    expect(fs.existsSync(ws)).toBe(true)
    const linkPath = path.join(ws, 'project')
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true)
    // The user's repo is reachable via the link.
    expect(fs.readFileSync(path.join(linkPath, 'src', 'foo.ts'), 'utf-8')).toContain('foo = 1')
  })

  it('ensureWorkspace is idempotent', () => {
    const ws1 = ensureWorkspace('proj1', projectRoot, home)
    const ws2 = ensureWorkspace('proj1', projectRoot, home)
    expect(ws2).toBe(ws1)
    expect(fs.lstatSync(path.join(ws2, 'project')).isSymbolicLink()).toBe(true)
  })

  it('ensureWorkspace recreates the symlink when the project path changes', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-other-'))
    try {
      ensureWorkspace('proj1', projectRoot, home)
      ensureWorkspace('proj1', other, home)
      const linkPath = path.join(workspacePathFor('proj1', home), 'project')
      const target = fs.readlinkSync(linkPath)
      expect(path.resolve(path.dirname(linkPath), target)).toBe(path.resolve(other))
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })

  it('removeWorkspace deletes the dir and unlinks the project symlink without following', () => {
    ensureWorkspace('proj1', projectRoot, home)
    const userFile = path.join(projectRoot, 'README.md')
    expect(fs.existsSync(userFile)).toBe(true)

    removeWorkspace('proj1', home)
    expect(fs.existsSync(workspacePathFor('proj1', home))).toBe(false)
    // The user's project must remain entirely intact.
    expect(fs.existsSync(userFile)).toBe(true)
    expect(fs.existsSync(path.join(projectRoot, 'src', 'foo.ts'))).toBe(true)
  })

  it('removeWorkspace is a no-op when the dir does not exist', () => {
    expect(() => removeWorkspace('never-existed', home)).not.toThrow()
  })

  it('does not leave a stale project-path.txt when the symlink succeeds', () => {
    const ws = ensureWorkspace('proj-fb', projectRoot, home)
    const linkPath = path.join(ws, 'project')
    const fallback = path.join(ws, 'project-path.txt')
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(fallback)).toBe(false)
  })

  describe('openspec carve-out link', () => {
    it('links <ws>/openspec to the repo openspec (created if absent); writes land in the repo', () => {
      const ws = ensureWorkspace('osp1', projectRoot, home)
      const link = path.join(ws, 'openspec')
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
      expect(path.resolve(ws, fs.readlinkSync(link))).toBe(path.join(projectRoot, 'openspec'))
      // The carve-out target was created in the repo.
      expect(fs.existsSync(path.join(projectRoot, 'openspec'))).toBe(true)
      // A write through the link lands in the user's repo (the whole point).
      fs.writeFileSync(path.join(link, 'probe.txt'), 'x')
      expect(fs.existsSync(path.join(projectRoot, 'openspec', 'probe.txt'))).toBe(true)
    })

    it('is idempotent — an already-correct link is left untouched', () => {
      ensureWorkspace('osp2', projectRoot, home)
      const ws = ensureWorkspace('osp2', projectRoot, home)
      const link = path.join(ws, 'openspec')
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
      expect(path.resolve(ws, fs.readlinkSync(link))).toBe(path.join(projectRoot, 'openspec'))
    })

    it('migrates a pre-carve-out REAL openspec dir into the repo, then links (non-destructive)', () => {
      const ws = workspacePathFor('osp3', home)
      // A workspace stranded by the openspec binary writing to its cwd.
      const stranded = path.join(ws, 'openspec', 'changes', 'archive', 'my-change')
      fs.mkdirSync(stranded, { recursive: true })
      fs.writeFileSync(path.join(stranded, 'proposal.md'), '# stranded\n')
      // The repo already has a committed file that must NOT be clobbered.
      fs.mkdirSync(path.join(projectRoot, 'openspec'), { recursive: true })
      fs.writeFileSync(path.join(projectRoot, 'openspec', 'project.md'), '# committed\n')

      ensureWorkspace('osp3', projectRoot, home)

      expect(fs.lstatSync(path.join(ws, 'openspec')).isSymbolicLink()).toBe(true)
      // Stranded artifact rescued into the repo.
      expect(
        fs.readFileSync(path.join(projectRoot, 'openspec', 'changes', 'archive', 'my-change', 'proposal.md'), 'utf8'),
      ).toContain('stranded')
      // Repo's committed file untouched.
      expect(fs.readFileSync(path.join(projectRoot, 'openspec', 'project.md'), 'utf8')).toContain('committed')
    })

    it('migration never clobbers an existing repo file on a name collision (repo wins)', () => {
      const ws = workspacePathFor('osp4', home)
      fs.mkdirSync(path.join(ws, 'openspec'), { recursive: true })
      fs.writeFileSync(path.join(ws, 'openspec', 'config.yaml'), 'workspace-version\n')
      fs.mkdirSync(path.join(projectRoot, 'openspec'), { recursive: true })
      fs.writeFileSync(path.join(projectRoot, 'openspec', 'config.yaml'), 'repo-version\n')

      ensureWorkspace('osp4', projectRoot, home)
      expect(fs.readFileSync(path.join(projectRoot, 'openspec', 'config.yaml'), 'utf8')).toBe('repo-version\n')
    })

    it('removeWorkspace unlinks the openspec link WITHOUT deleting the repo openspec', () => {
      const ws = ensureWorkspace('osp5', projectRoot, home)
      fs.writeFileSync(path.join(ws, 'openspec', 'keep.md'), '# keep\n') // lands in the repo via the link
      expect(fs.existsSync(path.join(projectRoot, 'openspec', 'keep.md'))).toBe(true)
      removeWorkspace('osp5', home)
      expect(fs.existsSync(ws)).toBe(false)
      // Repo openspec + its files survive (link unlinked, never followed).
      expect(fs.readFileSync(path.join(projectRoot, 'openspec', 'keep.md'), 'utf8')).toContain('keep')
    })
  })

  describe('assembleWorkspaceFramework', () => {
    it('no-ops (assembled=false) when no bundled core is present, but still ensures the workspace', () => {
      const prev = process.env.SPECRAILS_BUNDLED_CORE_PATH
      delete process.env.SPECRAILS_BUNDLED_CORE_PATH
      try {
        const res = assembleWorkspaceFramework('asm-noop', projectRoot, 'claude', { home })
        expect(res.assembled).toBe(false)
        expect(fs.existsSync(res.workspace)).toBe(true)
        // The ./project link is still created so the legacy npx path has a cwd.
        expect(fs.lstatSync(path.join(res.workspace, 'project')).isSymbolicLink()).toBe(true)
      } finally {
        if (prev === undefined) delete process.env.SPECRAILS_BUNDLED_CORE_PATH
        else process.env.SPECRAILS_BUNDLED_CORE_PATH = prev
      }
    })

    it('delegates to the bundled-core assemble when a FrameworkManager is available', () => {
      const fakeFm = {
        isAvailable: () => true,
        assembleWorkspace: vi.fn().mockReturnValue({ ran: true }),
      } as unknown as FrameworkManager

      const res = assembleWorkspaceFramework('asm-ok', projectRoot, 'claude', {
        home,
        version: '5.0.0',
        framework: fakeFm,
      })
      expect(res.assembled).toBe(true)
      expect(res.error).toBeUndefined()
      expect(fakeFm.assembleWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'claude', version: '5.0.0', codeRoot: projectRoot }),
      )
    })

    it('surfaces the assemble error while still reporting assembled=true', () => {
      const fakeFm = {
        isAvailable: () => true,
        assembleWorkspace: vi.fn().mockReturnValue({ ran: true, error: 'boom' }),
      } as unknown as FrameworkManager

      const res = assembleWorkspaceFramework('asm-err', projectRoot, 'claude', { home, framework: fakeFm })
      expect(res.assembled).toBe(true)
      expect(res.error).toBe('boom')
    })
  })
})
