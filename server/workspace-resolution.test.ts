import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync, lstatSync } from 'fs'
import os from 'os'
import path from 'path'
import { mirrorProjectEntry, workspaceLayout, resolveHome } from './artifact-registry'
import {
  resolveProjectExecution,
  isWorkspacePopulated,
} from './workspace-resolution'

let home: string
let repo: string

beforeEach(() => {
  home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'specrails-wsres-home-')))
  mkdirSync(path.join(home, '.specrails'), { recursive: true })
  repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'specrails-wsres-repo-')))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

/** Seed a registry entry AND populate the workspace with the core marker file so
 *  the project is considered fully relocated. Returns the workspace dir. */
function seedRelocated(slug: string): string {
  mirrorProjectEntry({ repoPath: repo, slug, providers: ['claude'], desktopProjectId: 'p1' }, home)
  const ws = workspaceLayout(resolveHome(home), slug, repo).workspaceDir
  mkdirSync(path.join(ws, '.specrails'), { recursive: true })
  writeFileSync(path.join(ws, '.specrails', 'specrails-version'), '4.8.0\n')
  return ws
}

describe('isWorkspacePopulated', () => {
  it('false when the workspace has no .specrails/specrails-version marker', () => {
    const ws = path.join(home, '.specrails', 'projects', 'acme', 'workspace')
    mkdirSync(ws, { recursive: true })
    expect(isWorkspacePopulated(ws)).toBe(false)
  })

  it('true once the marker file exists', () => {
    const ws = path.join(home, '.specrails', 'projects', 'acme', 'workspace')
    mkdirSync(path.join(ws, '.specrails'), { recursive: true })
    writeFileSync(path.join(ws, '.specrails', 'specrails-version'), '4.8.0\n')
    expect(isWorkspacePopulated(ws)).toBe(true)
  })

  it('true for the bundled-framework SYMLINKED providerDir layout (marker is a real file, subtrees are symlinks)', () => {
    // Simulate `assemble`: a real .specrails/specrails-version marker, but the
    // providerDir static subtrees are SYMLINKS into framework/current/<provider>/.
    const fwAgents = path.join(home, '.specrails', 'framework', 'current', '.claude', 'agents')
    mkdirSync(fwAgents, { recursive: true })
    writeFileSync(path.join(fwAgents, 'sr-architect.md'), '# arch')

    const ws = path.join(home, '.specrails', 'projects', 'linked', 'workspace')
    mkdirSync(path.join(ws, '.claude'), { recursive: true })
    symlinkSync(fwAgents, path.join(ws, '.claude', 'agents'))
    // commands as a whole-dir symlink too.
    const fwCommands = path.join(home, '.specrails', 'framework', 'current', '.claude', 'commands')
    mkdirSync(fwCommands, { recursive: true })
    symlinkSync(fwCommands, path.join(ws, '.claude', 'commands'))
    // The version marker is a REAL file.
    mkdirSync(path.join(ws, '.specrails'), { recursive: true })
    writeFileSync(path.join(ws, '.specrails', 'specrails-version'), '5.0.0\n')

    // Sanity: providerDir subtrees really ARE symlinks.
    expect(lstatSync(path.join(ws, '.claude', 'agents')).isSymbolicLink()).toBe(true)
    expect(lstatSync(path.join(ws, '.claude', 'commands')).isSymbolicLink()).toBe(true)
    // Gate accepts it as populated.
    expect(isWorkspacePopulated(ws)).toBe(true)
  })
})

describe('resolveProjectExecution — LEGACY (the gate stays closed)', () => {
  it('no registry entry ⇒ legacy: cwd = repo, repoDir = repo, empty env', () => {
    const exec = resolveProjectExecution({ slug: 'acme', path: repo }, home)
    expect(exec.relocated).toBe(false)
    expect(exec.cwd).toBe(repo)
    expect(exec.repoDir).toBe(repo)
    expect(exec.workspaceDir).toBeNull()
    expect(exec.env).toEqual({})
    expect(exec.ticketsPath).toBe(path.join(repo, '.specrails', 'local-tickets.json'))
    expect(exec.backlogConfigPath).toBe(path.join(repo, '.specrails', 'backlog-config.json'))
    expect(exec.profilesDir).toBe(path.join(repo, '.specrails', 'profiles'))
    expect(exec.stateDir).toBe(path.join(repo, '.claude'))
  })

  it('registry entry exists but workspace NOT populated ⇒ STILL legacy', () => {
    // Mirror an entry but do NOT write the core version marker into the workspace.
    mirrorProjectEntry({ repoPath: repo, slug: 'acme', providers: ['claude'] }, home)
    const exec = resolveProjectExecution({ slug: 'acme', path: repo }, home)
    expect(exec.relocated).toBe(false)
    expect(exec.cwd).toBe(repo)
    expect(exec.env).toEqual({})
  })
})

describe('resolveProjectExecution — RELOCATED (entry + populated workspace)', () => {
  it('flips relocated: cwd = workspace, repoDir = repo, SPECRAILS_REPO_DIR injected', () => {
    const ws = seedRelocated('acme')
    const exec = resolveProjectExecution({ slug: 'acme', path: repo }, home)
    expect(exec.relocated).toBe(true)
    expect(exec.cwd).toBe(ws)
    expect(exec.workspaceDir).toBe(ws)
    expect(exec.repoDir).toBe(repo)
    expect(exec.env.SPECRAILS_REPO_DIR).toBe(repo)
    expect(exec.env.SPECRAILS_WORKSPACE_DIR).toBe(ws)
    expect(exec.env.SPECRAILS_TICKETS_PATH).toBe(path.join(ws, '.specrails', 'local-tickets.json'))
    expect(exec.env.SPECRAILS_STATE_DIR).toBeDefined()
  })

  it('artifact paths point at the workspace when relocated', () => {
    const ws = seedRelocated('acme')
    const exec = resolveProjectExecution({ slug: 'acme', path: repo }, home)
    expect(exec.ticketsPath).toBe(path.join(ws, '.specrails', 'local-tickets.json'))
    expect(exec.profilesDir).toBe(path.join(ws, '.specrails', 'profiles'))
    expect(exec.pluginsStateDir).toBe(path.join(ws, '.specrails', 'plugins'))
    expect(exec.fileSummariesDir).toBe(path.join(ws, '.specrails', 'file-summaries'))
  })

  it('(re)creates the workspace ./project symlink pointing at the repo', () => {
    const ws = seedRelocated('acme')
    resolveProjectExecution({ slug: 'acme', path: repo }, home)
    const link = path.join(ws, 'project')
    // Either a symlink to the repo, or (fallback) a project-path.txt with the path.
    const fs = require('fs') as typeof import('fs')
    if (fs.existsSync(link)) {
      expect(realpathSync(link)).toBe(repo)
    } else {
      const txt = fs.readFileSync(path.join(ws, 'project-path.txt'), 'utf8')
      expect(txt).toBe(repo)
    }
  })

  it('uses the REGISTRY slug for the workspace, not the passed desktop slug', () => {
    // Core adopted the repo under a different slug than desktop would pick.
    const ws = seedRelocated('core-allocated-slug')
    // Pass a DIFFERENT desktop slug — resolution must still land on the registry
    // entry's workspace (keyed by repo path), never recompute from 'desktop-slug'.
    const exec = resolveProjectExecution({ slug: 'desktop-slug', path: repo }, home)
    expect(exec.relocated).toBe(true)
    expect(exec.cwd).toBe(ws)
    expect(exec.workspaceDir).toBe(ws)
  })
})
