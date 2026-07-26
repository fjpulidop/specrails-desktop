import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { initDb } from './db'
import { createRailWorktree, getRailWorktree, updateRailWorktreeState } from './rail-worktrees-store'
import { releaseRailWorktrees, durableSettlementIgnoredPaths } from './rail-worktree-release'
import type { GitRunner } from './worktree-manager'
import { applyWorktreeOverlay, fingerprintOverlayCleanupPath } from './worktree-overlay'

function overlayQuarantineRoots(worktreePath: string): string[] {
  const parent = path.dirname(worktreePath)
  const prefix = `${path.basename(worktreePath)}.specrails-overlay-quarantine-`
  return fs.readdirSync(parent)
    .filter((name) => name.startsWith(prefix))
    .map((name) => path.join(parent, name))
}

function removeOverlayQuarantines(worktreePath: string): void {
  for (const quarantine of overlayQuarantineRoots(worktreePath)) {
    fs.rmSync(quarantine, { recursive: true, force: true })
  }
}

describe('releaseRailWorktrees', () => {
  const sha = 'a'.repeat(40)

  // Rows must point at a REAL directory: a missing path takes the
  // externally-removed shortcut (prune + terminalize) and would bypass the
  // verification paths these tests exercise.
  function realWt(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `sr-release-${prefix}-`))
  }

  function verifiedGit(overrides: { dirty?: boolean; head?: string } = {}) {
    const calls: Array<{ args: string[]; cwd: string }> = []
    const git: GitRunner = {
      async run(args, cwd) {
        calls.push({ args, cwd })
        if (args[0] === 'status') {
          return { code: 0, stdout: overrides.dirty ? ' M app.ts\n' : '', stderr: '' }
        }
        if (args[0] === 'rev-parse') {
          return { code: 0, stdout: `${overrides.head ?? sha}\n`, stderr: '' }
        }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    return { git, calls }
  }

  it('releases exact worktrees, preserves unverifiable needs-review data, and revalidates it later', async () => {
    const db = initDb(':memory:')
    const cleanPath = realWt('clean')
    const recoverablePath = realWt('recoverable')
    createRailWorktree(db, {
      id: 'clean', railIndex: 0, ticketId: 1, branch: 'feat/clean',
      worktreePath: cleanPath, mergeState: 'built',
    })
    createRailWorktree(db, {
      id: 'recoverable', railIndex: 0, ticketId: 2, branch: 'feat/recoverable',
      worktreePath: recoverablePath, mergeState: 'needs-review',
    })
    const { git, calls } = verifiedGit()

    await expect(releaseRailWorktrees({
      db, git, repoDir: '/repo', worktreeIds: ['clean', 'recoverable'],
      expectedHeadByBranch: new Map([['feat/clean', sha]]),
      overlayEvidenceByBranch: new Map(),
    })).resolves.toEqual([expect.stringContaining('no durable settled HEAD')])

    expect(calls).toContainEqual({ args: ['worktree', 'remove', cleanPath], cwd: '/repo' })
    expect(getRailWorktree(db, 'clean')?.merge_state).toBe('released')
    expect(getRailWorktree(db, 'recoverable')?.merge_state).toBe('needs-review')

    await expect(releaseRailWorktrees({
      db, git, repoDir: '/repo', worktreeIds: ['clean', 'recoverable'],
      expectedHeadByBranch: new Map([['feat/clean', sha], ['feat/recoverable', sha]]),
      overlayEvidenceByBranch: new Map(),
    })).resolves.toEqual([])
    expect(calls).toContainEqual({ args: ['worktree', 'remove', recoverablePath], cwd: '/repo' })
    expect(getRailWorktree(db, 'recoverable')?.merge_state).toBe('released')

    const callCount = calls.length
    await expect(releaseRailWorktrees({
      db, git, repoDir: '/repo', worktreeIds: ['clean', 'recoverable'],
      expectedHeadByBranch: new Map([['feat/clean', sha], ['feat/recoverable', sha]]),
      overlayEvidenceByBranch: new Map(),
    })).resolves.toEqual([])
    expect(calls).toHaveLength(callCount)
    db.close()
  })

  it('terminalizes an externally removed worktree (missing path) with prune and NO warning', async () => {
    const db = initDb(':memory:')
    // The user ran `git worktree remove` by hand: the path no longer exists.
    // There are no bytes to preserve — the row must terminalize instead of
    // failing cleanliness verification forever and blocking Checkout.
    createRailWorktree(db, {
      id: 'gone', railIndex: 0, ticketId: 1, branch: 'feat/gone',
      worktreePath: path.join(os.tmpdir(), 'sr-release-definitely-missing', 'ticket-1'),
      mergeState: 'needs-review',
    })
    const calls: Array<{ args: string[]; cwd: string }> = []
    // Real git in a missing cwd: the status spawn itself fails.
    const git: GitRunner = {
      async run(args, cwd) {
        calls.push({ args, cwd })
        if (args[0] === 'status') throw new Error('spawn git ENOENT')
        return { code: 0, stdout: `${sha}\n`, stderr: '' }
      },
    }

    await expect(releaseRailWorktrees({
      db, git, repoDir: '/repo', worktreeIds: ['gone'],
      expectedHeadByBranch: new Map([['feat/gone', sha]]),
      overlayEvidenceByBranch: new Map(),
    })).resolves.toEqual([])

    expect(calls).toContainEqual({ args: ['worktree', 'prune'], cwd: '/repo' })
    expect(getRailWorktree(db, 'gone')?.merge_state).toBe('released')
    db.close()
  })

  it('treats a concurrent successful release as idempotent instead of a cleanup warning', async () => {
    const db = initDb(':memory:')
    createRailWorktree(db, {
      id: 'raced', railIndex: 0, ticketId: 1, branch: 'feat/raced',
      worktreePath: realWt('raced'), mergeState: 'built',
    })

    await expect(releaseRailWorktrees({
      db,
      git: verifiedGit().git,
      repoDir: '/repo',
      worktreeIds: ['raced'],
      expectedHeadByBranch: new Map([['feat/raced', sha]]),
      overlayEvidenceByBranch: new Map(),
      remove: async () => {
        updateRailWorktreeState(db, 'raced', 'released')
        throw new Error('path already removed')
      },
    })).resolves.toEqual([])
    expect(getRailWorktree(db, 'raced')?.merge_state).toBe('released')
    db.close()
  })

  it.each([
    { name: 'became dirty', git: () => verifiedGit({ dirty: true }), warning: 'contains changes' },
    { name: 'moved to another HEAD', git: () => verifiedGit({ head: 'b'.repeat(40) }), warning: 'moved after settlement' },
  ])('preserves a worktree that $name instead of force-removing it', async ({ git: makeGit, warning }) => {
    const db = initDb(':memory:')
    createRailWorktree(db, {
      id: 'changed', railIndex: 0, ticketId: 1, branch: 'feat/changed',
      worktreePath: realWt('changed'), mergeState: 'built',
    })
    const { git, calls } = makeGit()

    await expect(releaseRailWorktrees({
      db, git, repoDir: '/repo', worktreeIds: ['changed'],
      expectedHeadByBranch: new Map([['feat/changed', sha]]),
      overlayEvidenceByBranch: new Map(),
    })).resolves.toEqual([expect.stringContaining(warning)])

    expect(calls.some((call) => call.args[0] === 'worktree')).toBe(false)
    expect(getRailWorktree(db, 'changed')?.merge_state).toBe('needs-review')
    db.close()
  })

  it('uses non-force removal so a write racing after verification is still preserved', async () => {
    const db = initDb(':memory:')
    createRailWorktree(db, {
      id: 'raced-dirty', railIndex: 0, ticketId: 1, branch: 'feat/raced-dirty',
      worktreePath: realWt('raced-dirty'), mergeState: 'built',
    })
    const remove = vi.fn(async (_git, input) => {
      expect(input.force).toBe(false)
      throw new Error('worktree contains modified or untracked files')
    })

    await expect(releaseRailWorktrees({
      db, git: verifiedGit().git, repoDir: '/repo', worktreeIds: ['raced-dirty'], remove,
      expectedHeadByBranch: new Map([['feat/raced-dirty', sha]]),
      overlayEvidenceByBranch: new Map(),
    })).resolves.toEqual([expect.stringContaining('modified or untracked')])
    expect(getRailWorktree(db, 'raced-dirty')?.merge_state).toBe('needs-review')
    db.close()
  })

  it('excludes only SQLite-persisted overlay paths and retains unknown ignored files', async () => {
    const db = initDb(':memory:')
    const source = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-release-overlay-source-'))
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-release-overlay-wt-'))
    fs.writeFileSync(path.join(source, '.mcp.json'), '{}')
    const overlay = applyWorktreeOverlay({
      sourceRoot: source,
      worktreePath: worktree,
      providerDir: '.claude',
      instructionsFilename: 'CLAUDE.md',
    })
    createRailWorktree(db, {
      id: 'overlay', railIndex: 0, ticketId: 1, branch: 'feat/overlay',
      worktreePath: worktree, mergeState: 'built',
    })
    const statusArgs: string[][] = []
    const git: GitRunner = {
      async run(args) {
        if (args[0] === 'status') {
          statusArgs.push(args)
          const overlayExcluded = args.includes(':(top,exclude,literal).mcp.json')
          const overlayStillExists = fs.existsSync(path.join(worktree, '.mcp.json'))
          return { code: 0, stdout: overlayExcluded || !overlayStillExists ? '' : '!! .mcp.json\n', stderr: '' }
        }
        if (args[0] === 'ls-files') return { code: 1, stdout: '', stderr: 'not tracked' }
        if (args[0] === 'rev-parse') return { code: 0, stdout: `${sha}\n`, stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    }

    await expect(releaseRailWorktrees({
      db, git, repoDir: '/repo', worktreeIds: ['overlay'],
      expectedHeadByBranch: new Map([['feat/overlay', sha]]),
      overlayEvidenceByBranch: new Map([['feat/overlay', overlay.cleanupEvidence]]),
    })).resolves.toEqual([])
    expect(statusArgs[0]).toContain('--ignored=matching')
    expect(getRailWorktree(db, 'overlay')?.merge_state).toBe('released')

    createRailWorktree(db, {
      id: 'unknown-ignored', railIndex: 0, ticketId: 2, branch: 'feat/unknown-ignored',
      worktreePath: realWt('unknown-ignored'), mergeState: 'built',
    })
    const unknownGit: GitRunner = {
      async run(args) {
        if (args[0] === 'status') return { code: 0, stdout: '!! user-cache/output.bin\n', stderr: '' }
        if (args[0] === 'rev-parse') return { code: 0, stdout: `${sha}\n`, stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    await expect(releaseRailWorktrees({
      db, git: unknownGit, repoDir: '/repo', worktreeIds: ['unknown-ignored'],
      expectedHeadByBranch: new Map([['feat/unknown-ignored', sha]]),
      overlayEvidenceByBranch: new Map(),
    })).resolves.toEqual([expect.stringContaining('no settlement snapshot')])
    expect(getRailWorktree(db, 'unknown-ignored')?.merge_state).toBe('needs-review')
    db.close()
    fs.rmSync(source, { recursive: true, force: true })
    fs.rmSync(worktree, { recursive: true, force: true })
    removeOverlayQuarantines(worktree)
  })

  it('does not exclude a copied overlay file whose persisted fingerprint no longer matches', async () => {
    const db = initDb(':memory:')
    const source = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-release-stale-source-'))
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-release-stale-wt-'))
    fs.writeFileSync(path.join(source, '.mcp.json'), '{}')
    const overlay = applyWorktreeOverlay({
      sourceRoot: source,
      worktreePath: worktree,
      providerDir: '.claude',
      instructionsFilename: 'CLAUDE.md',
    })
    fs.writeFileSync(path.join(worktree, '.mcp.json'), '{"changed":"valuable"}')
    createRailWorktree(db, {
      id: 'stale-overlay', railIndex: 0, ticketId: 1, branch: 'feat/stale-overlay',
      worktreePath: worktree, mergeState: 'built',
    })
    const calls: string[][] = []
    const git: GitRunner = {
      async run(args) {
        calls.push(args)
        if (args[0] === 'status') {
          const hidden = args.includes(':(top,exclude,literal).mcp.json')
          return { code: 0, stdout: hidden ? '' : '!! .mcp.json\n', stderr: '' }
        }
        if (args[0] === 'rev-parse') return { code: 0, stdout: `${sha}\n`, stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    }

    await expect(releaseRailWorktrees({
      db, git, repoDir: '/repo', worktreeIds: ['stale-overlay'],
      expectedHeadByBranch: new Map([['feat/stale-overlay', sha]]),
      overlayEvidenceByBranch: new Map([['feat/stale-overlay', overlay.cleanupEvidence]]),
    })).resolves.toEqual([expect.stringContaining('no settlement snapshot')])

    expect(calls.flat()).not.toContain(':(top,exclude,literal).mcp.json')
    expect(fs.readFileSync(path.join(worktree, '.mcp.json'), 'utf8')).toContain('valuable')
    expect(getRailWorktree(db, 'stale-overlay')?.merge_state).toBe('needs-review')
    db.close()
    fs.rmSync(source, { recursive: true, force: true })
    fs.rmSync(worktree, { recursive: true, force: true })
  })

  it('preserves a concurrent write inside a verified copied overlay directory', async () => {
    const db = initDb(':memory:')
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-release-directory-race-'))
    const overlayDirectory = path.join(worktree, '.claude', 'rules')
    fs.mkdirSync(overlayDirectory, { recursive: true })
    fs.writeFileSync(path.join(overlayDirectory, 'owned.md'), 'allocator copy')
    const fingerprint = fingerprintOverlayCleanupPath(overlayDirectory)
    expect(fingerprint?.kind).toBe('directory')
    createRailWorktree(db, {
      id: 'directory-race', railIndex: 0, ticketId: 1, branch: 'feat/directory-race',
      worktreePath: worktree, mergeState: 'built',
    })
    const git: GitRunner = {
      async run(args) {
        if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' }
        if (args[0] === 'ls-files') return { code: 1, stdout: '', stderr: 'not tracked' }
        if (args[0] === 'rev-parse') return { code: 0, stdout: `${sha}\n`, stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const remove = vi.fn(async () => {})
    let injected = false
    let quarantinePath = ''
    const safetyArchives: string[] = []

    await expect(releaseRailWorktrees({
      db, git, repoDir: '/repo', worktreeIds: ['directory-race'], remove,
      expectedHeadByBranch: new Map([['feat/directory-race', sha]]),
      overlayEvidenceByBranch: new Map([['feat/directory-race', [{
        path: '.claude/rules',
        kind: 'directory',
        digest: fingerprint!.digest,
      }]]]),
      beforeOverlayQuarantine: () => {
        injected = true
        fs.writeFileSync(path.join(overlayDirectory, 'owned.md'), 'concurrent replacement')
      },
      afterOverlayRename: (_sourcePath, movedPath) => {
        quarantinePath = movedPath
        // A second writer recreates the original path while the changed first
        // copy is already quarantined. Cleanup must preserve both and never
        // rename over this newer source.
        fs.mkdirSync(overlayDirectory, { recursive: true })
        fs.writeFileSync(path.join(overlayDirectory, 'owned.md'), 'new source path')
      },
      onSafetyArchive: (archive) => safetyArchives.push(archive),
    })).resolves.toEqual([
      expect.stringMatching(/changed during atomic quarantine.*overlay data is preserved at/),
    ])

    expect(injected).toBe(true)
    expect(remove).not.toHaveBeenCalled()
    expect(fs.readFileSync(path.join(overlayDirectory, 'owned.md'), 'utf8')).toBe('new source path')
    expect(fs.readFileSync(path.join(quarantinePath, 'owned.md'), 'utf8')).toBe('concurrent replacement')
    expect(safetyArchives).toHaveLength(1)
    expect(path.relative(safetyArchives[0], quarantinePath)).toBe(path.join('.claude', 'rules'))
    expect(getRailWorktree(db, 'directory-race')?.merge_state).toBe('needs-review')
    db.close()
    fs.rmSync(worktree, { recursive: true, force: true })
    removeOverlayQuarantines(worktree)
  })

  it('persistently quarantines a stable copied overlay directory, including writes after rename', async () => {
    const db = initDb(':memory:')
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-release-directory-clean-'))
    const overlayDirectory = path.join(worktree, '.claude', 'rules')
    fs.mkdirSync(path.join(overlayDirectory, 'nested'), { recursive: true })
    fs.writeFileSync(path.join(overlayDirectory, 'owned.md'), 'allocator copy')
    fs.writeFileSync(path.join(overlayDirectory, 'nested', 'owned.md'), 'nested copy')
    const fingerprint = fingerprintOverlayCleanupPath(overlayDirectory)
    expect(fingerprint?.kind).toBe('directory')
    createRailWorktree(db, {
      id: 'directory-clean', railIndex: 0, ticketId: 1, branch: 'feat/directory-clean',
      worktreePath: worktree, mergeState: 'built',
    })
    const git: GitRunner = {
      async run(args) {
        if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' }
        if (args[0] === 'ls-files') return { code: 1, stdout: '', stderr: 'not tracked' }
        if (args[0] === 'rev-parse') return { code: 0, stdout: `${sha}\n`, stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const remove = vi.fn(async () => {})
    let quarantinePath = ''
    const safetyArchives: string[] = []

    await expect(releaseRailWorktrees({
      db, git, repoDir: '/repo', worktreeIds: ['directory-clean'], remove,
      expectedHeadByBranch: new Map([['feat/directory-clean', sha]]),
      overlayEvidenceByBranch: new Map([['feat/directory-clean', [{
        path: '.claude/rules',
        kind: 'directory',
        digest: fingerprint!.digest,
      }]]]),
      afterOverlayQuarantine: (movedPath) => {
        quarantinePath = movedPath
        fs.writeFileSync(path.join(movedPath, 'nested', 'owned.md'), 'post-rename write')
      },
      onSafetyArchive: (archive) => safetyArchives.push(archive),
    })).resolves.toEqual([])

    expect(fs.existsSync(overlayDirectory)).toBe(false)
    expect(quarantinePath).not.toBe('')
    expect(safetyArchives).toHaveLength(1)
    expect(path.relative(safetyArchives[0], quarantinePath)).toBe(path.join('.claude', 'rules'))
    expect(fs.readFileSync(path.join(quarantinePath, 'nested', 'owned.md'), 'utf8')).toBe('post-rename write')
    expect(remove).toHaveBeenCalledOnce()
    expect(getRailWorktree(db, 'directory-clean')?.merge_state).toBe('released')
    db.close()
    fs.rmSync(worktree, { recursive: true, force: true })
    removeOverlayQuarantines(worktree)
  })

  it('discloses one durable batch root containing more than eight overlay roots', async () => {
    const db = initDb(':memory:')
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-release-many-overlays-'))
    const overlayNames = Array.from({ length: 12 }, (_, index) => `.specrails-overlay-${index}.json`)
    const evidence = overlayNames.map((name, index) => {
      const target = path.join(worktree, name)
      fs.writeFileSync(target, `overlay-${index}`)
      return { path: name, ...fingerprintOverlayCleanupPath(target)! }
    })
    createRailWorktree(db, {
      id: 'many-overlays', railIndex: 0, ticketId: 1, branch: 'feat/many-overlays',
      worktreePath: worktree, mergeState: 'built',
    })
    const git: GitRunner = {
      async run(args) {
        if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' }
        if (args[0] === 'ls-files') return { code: 1, stdout: '', stderr: 'not tracked' }
        if (args[0] === 'rev-parse') return { code: 0, stdout: `${sha}\n`, stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const safetyArchives: string[] = []
    const remove = vi.fn(async () => {})

    try {
      await expect(releaseRailWorktrees({
        db, git, repoDir: '/repo', worktreeIds: ['many-overlays'], remove,
        expectedHeadByBranch: new Map([['feat/many-overlays', sha]]),
        overlayEvidenceByBranch: new Map([['feat/many-overlays', evidence]]),
        onSafetyArchive: (archive) => safetyArchives.push(archive),
      })).resolves.toEqual([])

      expect(safetyArchives).toHaveLength(1)
      for (const [index, name] of overlayNames.entries()) {
        expect(fs.readFileSync(path.join(safetyArchives[0], name), 'utf8')).toBe(`overlay-${index}`)
      }
      expect(remove).toHaveBeenCalledOnce()
    } finally {
      db.close()
      fs.rmSync(worktree, { recursive: true, force: true })
      removeOverlayQuarantines(worktree)
    }
  })

  it('real Git preserves an unknown ignored file, then non-force releases once only verified overlay files remain', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-release-real-git-'))
    const repo = path.join(root, 'repo')
    const worktree = path.join(root, 'worktree')
    const source = path.join(root, 'source')
    fs.mkdirSync(repo)
    fs.mkdirSync(source)
    const runGit = (args: string[], cwd: string): { code: number; stdout: string; stderr: string } => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
      return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
    }
    const mustGit = (args: string[], cwd = repo): void => {
      const result = runGit(args, cwd)
      if (result.code !== 0) throw new Error(result.stderr || result.stdout)
    }
    mustGit(['init', '-b', 'main'])
    mustGit(['config', 'user.email', 'specrails@example.test'])
    mustGit(['config', 'user.name', 'Specrails Test'])
    fs.writeFileSync(path.join(repo, '.gitignore'), '.mcp.json\n.sr-rail-overlay.json\nignored-user/\n')
    fs.writeFileSync(path.join(repo, 'README.md'), 'base\n')
    mustGit(['add', '.'])
    mustGit(['commit', '-m', 'base'])
    mustGit(['worktree', 'add', '-b', 'feat/real-release', worktree, 'main'])
    const expected = runGit(['rev-parse', '--verify', 'HEAD'], worktree).stdout.trim()
    fs.writeFileSync(path.join(source, '.mcp.json'), '{}')
    const overlay = applyWorktreeOverlay({
      sourceRoot: source,
      worktreePath: worktree,
      providerDir: '.claude',
      instructionsFilename: 'CLAUDE.md',
    })
    fs.mkdirSync(path.join(worktree, 'ignored-user'))
    fs.writeFileSync(path.join(worktree, 'ignored-user', 'valuable.bin'), 'do not lose')
    const db = initDb(':memory:')
    createRailWorktree(db, {
      id: 'real', railIndex: 0, ticketId: 1, branch: 'feat/real-release',
      worktreePath: worktree, mergeState: 'built',
    })
    const git: GitRunner = { run: async (args, cwd) => runGit(args, cwd) }
    const input = {
      db, git, repoDir: repo, worktreeIds: ['real'],
      expectedHeadByBranch: new Map([['feat/real-release', expected]]),
      overlayEvidenceByBranch: new Map([['feat/real-release', overlay.cleanupEvidence]]),
    }

    await expect(releaseRailWorktrees(input)).resolves.toEqual([expect.stringContaining('no settlement snapshot')])
    expect(fs.readFileSync(path.join(worktree, 'ignored-user', 'valuable.bin'), 'utf8')).toBe('do not lose')
    expect(getRailWorktree(db, 'real')?.merge_state).toBe('needs-review')

    fs.rmSync(path.join(worktree, 'ignored-user'), { recursive: true })
    await expect(releaseRailWorktrees(input)).resolves.toEqual([])
    expect(getRailWorktree(db, 'real')?.merge_state).toBe('released')
    expect(fs.existsSync(worktree)).toBe(false)
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
})

describe('settlement ignored-path snapshot (run-created artifacts)', () => {
  const sha = 'a'.repeat(40)

  function gitWithStatus(statusOut: string) {
    const removed: string[] = []
    const git: GitRunner = {
      async run(args, cwd) {
        if (args[0] === 'status') return { code: 0, stdout: statusOut, stderr: '' }
        if (args[0] === 'rev-parse') return { code: 0, stdout: `${sha}\n`, stderr: '' }
        if (args[0] === 'worktree' && args[1] === 'remove') { removed.push(cwd); return { code: 0, stdout: '', stderr: '' } }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    return { git, removed }
  }

  function seed(db: ReturnType<typeof initDb>) {
    // A REAL directory: a missing path takes the externally-removed shortcut
    // and would bypass the verification under test.
    const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-release-snap-'))
    createRailWorktree(db, {
      id: 'wt-1', railIndex: 0, ticketId: 1, branch: 'feat/x',
      worktreePath, mergeState: 'built',
    })
    return worktreePath
  }

  it('releases when every live ignored path is covered by the settlement snapshot', async () => {
    const db = initDb(':memory:')
    seed(db)
    const { git } = gitWithStatus('!! __pycache__/\n!! .pytest_cache/\n!! app/__pycache__/\n')
    const warnings = await releaseRailWorktrees({
      db, git, repoDir: '/repo', worktreeIds: ['wt-1'],
      expectedHeadByBranch: new Map([['feat/x', sha]]),
      overlayEvidenceByBranch: new Map(),
      settlementIgnoredByBranch: new Map([['feat/x', ['__pycache__', '.pytest_cache', 'app/__pycache__']]]),
    })
    expect(warnings).toEqual([])
    expect(getRailWorktree(db, 'wt-1')?.merge_state).toBe('released')
    db.close()
  })

  it('a new file INSIDE a snapshotted ignored directory is still covered (prefix rule)', async () => {
    const db = initDb(':memory:')
    seed(db)
    const { git } = gitWithStatus('!! __pycache__/new-module.pyc\n')
    const warnings = await releaseRailWorktrees({
      db, git, repoDir: '/repo', worktreeIds: ['wt-1'],
      expectedHeadByBranch: new Map([['feat/x', sha]]),
      overlayEvidenceByBranch: new Map(),
      settlementIgnoredByBranch: new Map([['feat/x', ['__pycache__']]]),
    })
    expect(warnings).toEqual([])
    db.close()
  })

  it('preserves when an ignored path APPEARED after settlement', async () => {
    const db = initDb(':memory:')
    seed(db)
    const { git, removed } = gitWithStatus('!! __pycache__/\n!! .env\n')
    const warnings = await releaseRailWorktrees({
      db, git, repoDir: '/repo', worktreeIds: ['wt-1'],
      expectedHeadByBranch: new Map([['feat/x', sha]]),
      overlayEvidenceByBranch: new Map(),
      settlementIgnoredByBranch: new Map([['feat/x', ['__pycache__']]]),
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/appeared after settlement.*\.env/)
    expect(removed).toEqual([])
    expect(getRailWorktree(db, 'wt-1')?.merge_state).toBe('needs-review')
    db.close()
  })

  it('preserves ignored paths when no snapshot exists (legacy rows)', async () => {
    const db = initDb(':memory:')
    seed(db)
    const { git, removed } = gitWithStatus('!! __pycache__/\n')
    const warnings = await releaseRailWorktrees({
      db, git, repoDir: '/repo', worktreeIds: ['wt-1'],
      expectedHeadByBranch: new Map([['feat/x', sha]]),
      overlayEvidenceByBranch: new Map(),
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/no settlement snapshot/)
    expect(removed).toEqual([])
    db.close()
  })

  it('tracked/untracked dirt still preserves regardless of the snapshot', async () => {
    const db = initDb(':memory:')
    seed(db)
    const { git, removed } = gitWithStatus(' M app.py\n!! __pycache__/\n')
    const warnings = await releaseRailWorktrees({
      db, git, repoDir: '/repo', worktreeIds: ['wt-1'],
      expectedHeadByBranch: new Map([['feat/x', sha]]),
      overlayEvidenceByBranch: new Map(),
      settlementIgnoredByBranch: new Map([['feat/x', ['__pycache__']]]),
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/changes made after settlement/)
    expect(removed).toEqual([])
    db.close()
  })
})

describe('releaseRailWorktrees + warm dependency links', () => {
  const sha = 'b'.repeat(40)

  /** Git double whose status reports the still-present worktree entries that
   *  the caller did NOT exclude via `:(top,exclude,literal)<path>` pathspecs. */
  function statusGit(entries: () => string[]) {
    const calls: Array<{ args: string[]; cwd: string }> = []
    const git: GitRunner = {
      async run(args, cwd) {
        calls.push({ args, cwd })
        if (args[0] === 'status') {
          const excluded = new Set(
            args.filter((a) => a.startsWith(':(top,exclude,literal)'))
              .map((a) => a.replace(':(top,exclude,literal)', '')),
          )
          const lines = entries().filter((e) => !excluded.has(e)).map((e) => `?? ${e}`)
          return { code: 0, stdout: lines.length ? `${lines.join('\n')}\n` : '', stderr: '' }
        }
        // Untracked: exit 1 is what authorizes quarantine of an overlay path.
        if (args[0] === 'ls-files') return { code: 1, stdout: '', stderr: '' }
        if (args[0] === 'rev-parse') return { code: 0, stdout: `${sha}\n`, stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    return { git, calls }
  }

  function baseRepoWithInstall(): string {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-release-baserepo-'))
    fs.mkdirSync(path.join(repo, 'node_modules', 'left-pad'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'node_modules', 'left-pad', 'index.js'), 'x')
    return repo
  }

  it('releases a settled worktree whose only leftover is the app-created warm link, with NO persisted evidence', async () => {
    const db = initDb(':memory:')
    const repoDir = baseRepoWithInstall()
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-release-warm-'))
    fs.symlinkSync(path.join(repoDir, 'node_modules'), path.join(wt, 'node_modules'))
    createRailWorktree(db, {
      id: 'warm', railIndex: 0, ticketId: 1, branch: 'feat/warm',
      worktreePath: wt, mergeState: 'needs-review',
    })
    const { git, calls } = statusGit(() => (fs.existsSync(path.join(wt, 'node_modules')) ? ['node_modules'] : []))

    // No overlayEvidenceByBranch entry at all: this is exactly the shape of a
    // delivery that settled BEFORE warm links carried evidence.
    const warnings = await releaseRailWorktrees({
      db, git, repoDir, worktreeIds: ['warm'],
      expectedHeadByBranch: new Map([['feat/warm', sha]]),
      overlayEvidenceByBranch: new Map(),
    })

    expect(warnings).toEqual([])
    expect(getRailWorktree(db, 'warm')?.merge_state).toBe('released')
    // Quarantined out of the worktree so non-force removal can succeed.
    expect(fs.existsSync(path.join(wt, 'node_modules'))).toBe(false)
    expect(calls).toContainEqual({ args: ['worktree', 'remove', wt], cwd: repoDir })
    // The shared dependency tree itself is never moved or deleted.
    expect(fs.existsSync(path.join(repoDir, 'node_modules', 'left-pad', 'index.js'))).toBe(true)

    removeOverlayQuarantines(wt)
    fs.rmSync(wt, { recursive: true, force: true })
    fs.rmSync(repoDir, { recursive: true, force: true })
    db.close()
  })

  it('preserves the worktree when the dependency path is a real directory, not an app link', async () => {
    const db = initDb(':memory:')
    const repoDir = baseRepoWithInstall()
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-release-realdir-'))
    fs.mkdirSync(path.join(wt, 'node_modules'))
    fs.writeFileSync(path.join(wt, 'node_modules', 'agent-made.js'), 'x')
    createRailWorktree(db, {
      id: 'real', railIndex: 0, ticketId: 1, branch: 'feat/real',
      worktreePath: wt, mergeState: 'built',
    })
    const { git } = statusGit(() => ['node_modules'])

    const warnings = await releaseRailWorktrees({
      db, git, repoDir, worktreeIds: ['real'],
      expectedHeadByBranch: new Map([['feat/real', sha]]),
      overlayEvidenceByBranch: new Map(),
    })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/changes made after settlement/)
    expect(getRailWorktree(db, 'real')?.merge_state).toBe('needs-review')
    expect(fs.existsSync(path.join(wt, 'node_modules', 'agent-made.js'))).toBe(true)

    fs.rmSync(wt, { recursive: true, force: true })
    fs.rmSync(repoDir, { recursive: true, force: true })
    db.close()
  })

  it('preserves the worktree when the link points outside the base checkout', async () => {
    const db = initDb(':memory:')
    const repoDir = baseRepoWithInstall()
    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-release-foreign-'))
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-release-foreignlink-'))
    fs.symlinkSync(foreign, path.join(wt, 'node_modules'))
    createRailWorktree(db, {
      id: 'foreign', railIndex: 0, ticketId: 1, branch: 'feat/foreign',
      worktreePath: wt, mergeState: 'built',
    })
    const { git } = statusGit(() => ['node_modules'])

    const warnings = await releaseRailWorktrees({
      db, git, repoDir, worktreeIds: ['foreign'],
      expectedHeadByBranch: new Map([['feat/foreign', sha]]),
      overlayEvidenceByBranch: new Map(),
    })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/changes made after settlement/)
    expect(getRailWorktree(db, 'foreign')?.merge_state).toBe('needs-review')

    fs.rmSync(wt, { recursive: true, force: true })
    fs.rmSync(foreign, { recursive: true, force: true })
    fs.rmSync(repoDir, { recursive: true, force: true })
    db.close()
  })

  it('a live warm link never overrides persisted evidence for the same path', async () => {
    const db = initDb(':memory:')
    const repoDir = baseRepoWithInstall()
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-release-dedupe-'))
    fs.symlinkSync(path.join(repoDir, 'node_modules'), path.join(wt, 'node_modules'))
    createRailWorktree(db, {
      id: 'dedupe', railIndex: 0, ticketId: 1, branch: 'feat/dedupe',
      worktreePath: wt, mergeState: 'built',
    })
    const persisted = fingerprintOverlayCleanupPath(path.join(wt, 'node_modules'))!
    const { git } = statusGit(() => (fs.existsSync(path.join(wt, 'node_modules')) ? ['node_modules'] : []))

    const warnings = await releaseRailWorktrees({
      db, git, repoDir, worktreeIds: ['dedupe'],
      expectedHeadByBranch: new Map([['feat/dedupe', sha]]),
      overlayEvidenceByBranch: new Map([['feat/dedupe', [{ path: 'node_modules', ...persisted }]]]),
      authenticateWarmLinks: () => [{ path: 'node_modules', ...persisted }],
    })

    expect(warnings).toEqual([])
    expect(getRailWorktree(db, 'dedupe')?.merge_state).toBe('released')
    expect(overlayQuarantineRoots(wt)).toHaveLength(1)

    removeOverlayQuarantines(wt)
    fs.rmSync(wt, { recursive: true, force: true })
    fs.rmSync(repoDir, { recursive: true, force: true })
    db.close()
  })
})

describe('durableSettlementIgnoredPaths', () => {
  it('collapses matching snapshots, poisons conflicts and failed captures, sanitizes paths', () => {
    const out = durableSettlementIgnoredPaths([
      // matching duplicates (two units, same branch) → kept
      { branch: 'feat/a', settlementIgnoredPaths: ['__pycache__/', 'dist'] },
      { branch: 'feat/a', settlementIgnoredPaths: ['dist', '__pycache__'] },
      // conflicting sets → no authorization
      { branch: 'feat/b', settlementIgnoredPaths: ['x'] },
      { branch: 'feat/b', settlementIgnoredPaths: ['y'] },
      // failed capture (null) → no authorization
      { branch: 'feat/c', settlementIgnoredPaths: null },
      // path traversal → no authorization
      { branch: 'feat/d', settlementIgnoredPaths: ['../escape'] },
      // absent field → simply no vote
      { branch: 'feat/e' },
    ])
    expect(out.get('feat/a')).toEqual(['__pycache__', 'dist'])
    expect(out.has('feat/b')).toBe(false)
    expect(out.has('feat/c')).toBe(false)
    expect(out.has('feat/d')).toBe(false)
    expect(out.has('feat/e')).toBe(false)
  })

  it('a null capture poisons even when another unit has a valid snapshot', () => {
    const out = durableSettlementIgnoredPaths([
      { branch: 'feat/a', settlementIgnoredPaths: ['__pycache__'] },
      { branch: 'feat/a', settlementIgnoredPaths: null },
    ])
    expect(out.has('feat/a')).toBe(false)
  })
})
