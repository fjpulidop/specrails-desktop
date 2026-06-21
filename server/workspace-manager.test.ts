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
} from './workspace-manager'
import { FrameworkManager } from './framework-manager'

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

  it('workspacePathFor composes the expected path', () => {
    expect(workspacePathFor('myslug', home)).toBe(
      path.join(home, '.specrails', 'projects', 'myslug', 'workspace'),
    )
  })

  describe('ensureFrameworkAgents (win32 repair)', () => {
    const ORIG = process.platform
    const win32 = () => Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    afterEach(() => Object.defineProperty(process, 'platform', { value: ORIG, configurable: true }))

    function seedFramework(version = '4.10.0', agents = ['sr-architect', 'sr-developer', 'sr-reviewer']): void {
      const dir = path.join(home, '.specrails', 'framework', version, '.claude', 'agents')
      fs.mkdirSync(dir, { recursive: true })
      for (const a of agents) fs.writeFileSync(path.join(dir, `${a}.md`), `# ${a}\n`)
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

    it('picks the highest framework version dir', () => {
      win32()
      seedFramework('4.9.0', ['sr-architect'])
      seedFramework('4.10.0', ['sr-architect', 'sr-developer'])
      const ws = workspacePathFor('acme', home)
      expect(ensureFrameworkAgents(ws, '.claude', home)).toBe(2) // from 4.10.0, not 4.9.0
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
