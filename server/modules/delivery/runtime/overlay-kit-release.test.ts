/**
 * Release of a worktree carrying Specrails's own overlay kit, against real Git
 * repositories: unchanged kit is removed (no safety archive, no notice);
 * anything changed, unknown or unprovable is kept in the archive, and only that.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { initDb } from '../../../db'
import { createRailWorktree, getRailWorktree } from './rail-worktrees-store'
import { releaseRailWorktrees, specrailsWorkspaceOf } from './rail-worktree-release'
import type { GitRunner } from '../../../worktree-manager'
import {
  OVERLAY_MANIFEST, applyWorktreeOverlay, fingerprintOverlayCleanupPath, readOverlayManifest,
  revalidateOverlayCleanupEvidence, type OverlayCleanupEvidence, type WorktreeOverlayInput,
} from '../../../worktree-overlay'

const HOOK = "'node' '/opt/specrails/agent-policy/specrails-policy-hook-0123abcd.cjs' --specrails-home '/home'"
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function runGit(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function mustGit(args: string[], cwd: string): string {
  const result = runGit(args, cwd)
  if (result.code !== 0) throw new Error(result.stderr || result.stdout)
  return result.stdout.trim()
}

function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

interface Fixture {
  root: string
  repo: string
  workspace: string
  worktree: string
  branch: string
  head: string
  overlayInput: WorktreeOverlayInput
  allocation: OverlayCleanupEvidence[]
}

/** A project laid out like production: `<home>/.specrails/projects/demo/{workspace,worktrees/<run>/ticket-1}`. */
function fixture(options: { gitignore?: string } = {}): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-kit-release-')))
  roots.push(root)
  const repo = path.join(root, 'repo')
  const projectHome = path.join(root, 'home', '.specrails', 'projects', 'demo')
  const workspace = path.join(projectHome, 'workspace')
  const worktree = path.join(projectHome, 'worktrees', 'run-1', 'ticket-1')
  const branch = 'feat/kit'
  fs.mkdirSync(repo, { recursive: true })
  mustGit(['init', '-q', '-b', 'main'], repo)
  mustGit(['config', 'user.email', 'specrails@example.test'], repo)
  mustGit(['config', 'user.name', 'Specrails Test'], repo)
  write(path.join(repo, 'README.md'), 'base\n')
  if (options.gitignore) write(path.join(repo, '.gitignore'), options.gitignore)
  mustGit(['add', '.'], repo)
  mustGit(['commit', '-qm', 'base'], repo)
  // Repo-resident, untracked carve-out (the fallback overlay root).
  write(path.join(repo, '.claude', 'skills', 'openspec-explore', 'SKILL.md'), 'explore\n')
  // The relocated framework surface.
  write(path.join(workspace, '.claude', 'commands', 'specrails', 'implement.md'), 'implement\n')
  write(path.join(workspace, '.claude', 'skills', 'sr-implement', 'SKILL.md'), 'sr\n')
  write(path.join(workspace, 'CLAUDE.md'), '# Project instructions\n')
  fs.mkdirSync(path.dirname(worktree), { recursive: true })
  mustGit(['worktree', 'add', '-q', '-b', branch, worktree, 'main'], repo)
  const head = mustGit(['rev-parse', 'HEAD'], worktree)
  const overlayInput: WorktreeOverlayInput = {
    worktreePath: worktree,
    sourceRoot: workspace,
    fallbackSourceRoots: [repo],
    providerDir: '.claude',
    instructionsFilename: 'CLAUDE.md',
    policyHookCommand: HOOK,
  }
  const overlay = applyWorktreeOverlay(overlayInput)
  expect(overlay.warnings).toEqual([])
  return { root, repo, workspace, worktree, branch, head, overlayInput, allocation: overlay.cleanupEvidence }
}

/** Settlement narrows allocation proof exactly as production does. */
function settle(f: Fixture): OverlayCleanupEvidence[] {
  const { policyHookCommand: _hook, ...input } = f.overlayInput
  return revalidateOverlayCleanupEvidence(input, f.allocation)
}

async function release(f: Fixture, evidence: OverlayCleanupEvidence[], settlementIgnored?: string[]) {
  const db = initDb(':memory:')
  createRailWorktree(db, { id: 'wt', railIndex: 0, ticketId: 1, branch: f.branch, worktreePath: f.worktree, mergeState: 'built' })
  const archives: string[] = []
  const git: GitRunner = { run: async (args, cwd) => runGit(args, cwd) }
  const warnings = await releaseRailWorktrees({
    db, git, repoDir: f.repo, worktreeIds: ['wt'],
    expectedHeadByBranch: new Map([[f.branch, f.head]]),
    overlayEvidenceByBranch: new Map([[f.branch, evidence]]),
    ...(settlementIgnored ? { settlementIgnoredByBranch: new Map([[f.branch, settlementIgnored]]) } : {}),
    onSafetyArchive: (archive) => { archives.push(archive) },
  })
  const state = getRailWorktree(db, 'wt')?.merge_state
  db.close()
  return { warnings, archives, state }
}

function siblings(worktree: string): string[] {
  return fs.readdirSync(path.dirname(worktree)).filter((name) => name !== path.basename(worktree))
}

/** Every regular file or link beneath `dir`, relative, links not followed. */
function listTree(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name)
    const rel = prefix ? `${prefix}/${name}` : name
    const stat = fs.lstatSync(full)
    if (stat.isDirectory() && !stat.isSymbolicLink()) out.push(...listTree(full, rel))
    else out.push(rel)
  }
  return out
}

function expectSourcesIntact(f: Fixture): void {
  expect(fs.readFileSync(path.join(f.workspace, 'CLAUDE.md'), 'utf8')).toBe('# Project instructions\n')
  expect(fs.readFileSync(path.join(f.workspace, '.claude', 'commands', 'specrails', 'implement.md'), 'utf8')).toBe('implement\n')
  expect(fs.readFileSync(path.join(f.workspace, '.claude', 'skills', 'sr-implement', 'SKILL.md'), 'utf8')).toBe('sr\n')
  expect(fs.readFileSync(path.join(f.repo, '.claude', 'skills', 'openspec-explore', 'SKILL.md'), 'utf8')).toBe('explore\n')
}

describe('overlay manifest v2', () => {
  it('records what the overlay wrote per path', () => {
    const f = fixture()
    const manifest = readOverlayManifest(path.join(f.worktree, OVERLAY_MANIFEST))!
    expect(manifest.version).toBe(2)
    expect(manifest.records['.claude/commands']).toEqual({ kind: 'symlink', target: path.join(f.workspace, '.claude', 'commands') })
    expect(manifest.records['.claude/skills/openspec-explore']).toEqual({ kind: 'symlink', target: path.join(f.repo, '.claude', 'skills', 'openspec-explore') })
    expect(manifest.records['CLAUDE.md']).toMatchObject({ kind: 'file', size: '# Project instructions\n'.length })
    expect(manifest.records['.claude/settings.local.json']).toMatchObject({ kind: 'file', json: { hooks: expect.any(Object) } })
    expect(specrailsWorkspaceOf(f.worktree)).toBe(f.workspace)
  })
})

describe('release of a worktree carrying the overlay kit (real Git)', () => {
  it('unchanged kit: removed, no safety archive, no notice', async () => {
    const f = fixture()
    const result = await release(f, settle(f))
    expect(result.warnings).toEqual([])
    expect(result.archives).toEqual([])
    expect(result.state).toBe('released')
    expect(fs.existsSync(f.worktree)).toBe(false)
    expect(siblings(f.worktree)).toEqual([])
    expectSourcesIntact(f)
  })

  it('edited CLAUDE.md: only that file is kept in the safety archive', async () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.worktree, 'CLAUDE.md'), '# Project instructions\nAgent note worth keeping\n')
    const result = await release(f, settle(f))
    expect(result.warnings).toEqual([])
    expect(result.state).toBe('released')
    expect(result.archives).toHaveLength(1)
    expect(path.basename(result.archives[0])).toMatch(/^ticket-1\.specrails-overlay-quarantine-/)
    expect(listTree(result.archives[0])).toEqual(['CLAUDE.md'])
    expect(fs.readFileSync(path.join(result.archives[0], 'CLAUDE.md'), 'utf8')).toContain('Agent note worth keeping')
    expect(fs.existsSync(f.worktree)).toBe(false)
    expectSourcesIntact(f)
  })

  it('replaced symlink: the real directory that replaced it is kept, the rest removed', async () => {
    const f = fixture()
    const commands = path.join(f.worktree, '.claude', 'commands')
    fs.unlinkSync(commands)
    write(path.join(commands, 'mine.md'), 'hand-written command\n')
    const result = await release(f, settle(f))
    expect(result.warnings).toEqual([])
    expect(result.state).toBe('released')
    expect(result.archives).toHaveLength(1)
    expect(listTree(result.archives[0])).toEqual(['.claude/commands/mine.md'])
    expectSourcesIntact(f)
  })

  it('a symlink re-pointed elsewhere is kept', async () => {
    const f = fixture()
    const link = path.join(f.worktree, '.claude', 'skills', 'sr-implement')
    const elsewhere = path.join(f.root, 'elsewhere')
    fs.mkdirSync(elsewhere)
    fs.unlinkSync(link)
    fs.symlinkSync(elsewhere, link)
    const result = await release(f, settle(f))
    expect(result.state).toBe('released')
    expect(listTree(result.archives[0])).toEqual(['.claude/skills/sr-implement'])
    expect(fs.readlinkSync(path.join(result.archives[0], '.claude', 'skills', 'sr-implement'))).toBe(elsewhere)
  })

  it('a source edited mid-run revokes the copy proof, but the v2 record still proves the copy unchanged', async () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.workspace, 'CLAUDE.md'), '# Project instructions, edited by the person\n')
    const evidence = settle(f)
    expect(evidence.map((entry) => entry.path)).not.toContain('CLAUDE.md')
    const result = await release(f, evidence)
    expect(result.warnings).toEqual([])
    expect(result.archives).toEqual([])
    expect(result.state).toBe('released')
  })

  it('v1 manifest: links into Specrails sources and policy-only settings are removed; unprovable files are kept', async () => {
    const f = fixture()
    const manifestPath = path.join(f.worktree, OVERLAY_MANIFEST)
    const v2 = readOverlayManifest(manifestPath)!
    fs.writeFileSync(manifestPath, JSON.stringify({ version: 1, paths: v2.paths }, null, 2))
    // A legacy settlement kept only the manifest's own proof.
    const evidence = [{ path: OVERLAY_MANIFEST, ...fingerprintOverlayCleanupPath(manifestPath)! }]
    const result = await release(f, evidence)
    expect(result.warnings).toEqual([])
    expect(result.state).toBe('released')
    expect(result.archives).toHaveLength(1)
    expect(listTree(result.archives[0])).toEqual(['CLAUDE.md'])
    expectSourcesIntact(f)
  })

  it('a manifest changed after allocation is not trusted: its paths keep holding the worktree', async () => {
    const f = fixture()
    const evidence = settle(f)
    const manifestPath = path.join(f.worktree, OVERLAY_MANIFEST)
    const manifest = readOverlayManifest(manifestPath)!
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, paths: [...manifest.paths, 'src-work.ts'] }, null, 2))
    write(path.join(f.worktree, 'src-work.ts'), 'unsaved work\n')
    const result = await release(f, evidence)
    expect(result.warnings).toEqual([expect.stringContaining('changes made after settlement')])
    expect(result.state).toBe('needs-review')
    expect(fs.readFileSync(path.join(f.worktree, 'src-work.ts'), 'utf8')).toBe('unsaved work\n')
    expect(siblings(f.worktree)).toEqual([])
  })

  it('settings.local.json rewritten with Specrails-owned entries only (hook refresh, connectors deny-list) is removed', async () => {
    const f = fixture()
    const settings = path.join(f.worktree, '.claude', 'settings.local.json')
    const current = JSON.parse(fs.readFileSync(settings, 'utf8')) as Record<string, unknown>
    const hooks = { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: "'node' '/opt/specrails-policy-hook-ffff.cjs'", timeout: 10 }] }] }
    fs.writeFileSync(settings, JSON.stringify({ deniedMcpServers: [{ serverName: 'github' }], ...current, hooks }, null, 2))
    const result = await release(f, settle(f))
    expect(result.warnings).toEqual([])
    expect(result.archives).toEqual([])
    expect(result.state).toBe('released')
  })

  it('settings.local.json with a key Specrails does not own is kept', async () => {
    const f = fixture()
    const settings = path.join(f.worktree, '.claude', 'settings.local.json')
    const current = JSON.parse(fs.readFileSync(settings, 'utf8')) as Record<string, unknown>
    fs.writeFileSync(settings, JSON.stringify({ ...current, permissions: { allow: ['Bash(npm test)'] } }, null, 2))
    const result = await release(f, settle(f))
    expect(result.state).toBe('released')
    expect(listTree(result.archives[0])).toEqual(['.claude/settings.local.json'])
    expect(fs.readFileSync(path.join(result.archives[0], '.claude', 'settings.local.json'), 'utf8')).toContain('npm test')
  })

  it('mixed: an ignored .claude/ with kit and a person\'s file keeps only the person\'s file', async () => {
    const f = fixture({ gitignore: '.claude/\nCLAUDE.md\n' })
    write(path.join(f.worktree, '.claude', 'notes.md'), 'my notes\n')
    fs.appendFileSync(path.join(f.worktree, 'CLAUDE.md'), 'edited\n')
    const result = await release(f, settle(f), ['.claude', 'CLAUDE.md'])
    expect(result.warnings).toEqual([])
    expect(result.state).toBe('released')
    expect(result.archives).toHaveLength(1)
    expect(listTree(result.archives[0])).toEqual(['.claude/notes.md', 'CLAUDE.md'])
    expectSourcesIntact(f)
  })

  it('an ignored .claude/ holding nothing but kit leaves no archive', async () => {
    const f = fixture({ gitignore: '.claude/\n' })
    const result = await release(f, settle(f), ['.claude'])
    expect(result.warnings).toEqual([])
    expect(result.archives).toEqual([])
    expect(siblings(f.worktree)).toEqual([])
  })
})
