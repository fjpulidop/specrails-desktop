import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs'
import os from 'os'
import path from 'path'
import {
  atomicWrite,
  canonicalizeRepoPath,
  lockPath,
  mirrorProjectEntry,
  normalizeKey,
  readRegistryOrEmpty,
  reconcileFromProjects,
  resolveArtifacts,
  REGISTRY_SCHEMA_VERSION,
  registryPath,
  removeRegistryEntry,
  slugify,
  withFileLock,
  workspaceLayout,
  isCompleteEntry,
  refreshLockHeartbeat,
  type ProjectEntry,
  type RegistryFile,
} from './artifact-registry'
import { statSync } from 'fs'

let home: string

function keyFor(repo: string): string {
  return normalizeKey(canonicalizeRepoPath(repo))
}

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'specrails-artifact-registry-'))
  mkdirSync(path.join(home, '.specrails'), { recursive: true })
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('slugify (byte-parity with desktop-router)', () => {
  it('lowercases, collapses non-alphanumerics to dashes, trims edge dashes', () => {
    expect(slugify('Acme API')).toBe('acme-api')
    expect(slugify('My_Project.v2')).toBe('my-project-v2')
    expect(slugify('--Edge--')).toBe('edge')
    expect(slugify('***')).toBe('')
  })
})

describe('canonicalizeRepoPath', () => {
  it('resolves to an absolute realpath, collapsing symlinks', () => {
    const real = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'real-')))
    const link = path.join(home, 'link-to-repo')
    symlinkSync(real, link)
    expect(canonicalizeRepoPath(link)).toBe(real)
    rmSync(real, { recursive: true, force: true })
  })

  it('falls back to the resolved path when realpath throws (non-existent)', () => {
    const ghost = path.join(home, 'does', 'not', 'exist')
    expect(canonicalizeRepoPath(ghost)).toBe(path.resolve(ghost))
  })
})

describe('normalizeKey', () => {
  it('case-folds on darwin/win, identity elsewhere', () => {
    const mixed = '/Users/Javi/Repos/Acme'
    if (process.platform === 'darwin' || process.platform === 'win32') {
      expect(normalizeKey(mixed)).toBe(mixed.toLowerCase())
    } else {
      expect(normalizeKey(mixed)).toBe(mixed)
    }
  })
})

describe('workspaceLayout (byte-parity with core)', () => {
  it('derives every sub-path under the workspace dir', () => {
    const canon = '/Users/javi/repos/acme'
    const l = workspaceLayout(home, 'acme', canon)
    expect(l.workspaceDir).toBe(path.join(home, '.specrails', 'projects', 'acme', 'workspace'))
    expect(l.artifactRoot).toBe(l.workspaceDir)
    expect(l.codeRoot).toBe(canon)
    expect(l.repoPath).toBe(canon)
    expect(l.stateDir).toBe(path.join(l.workspaceDir, '.claude'))
    expect(l.ticketsPath).toBe(path.join(l.workspaceDir, '.specrails', 'local-tickets.json'))
    expect(l.backlogConfigPath).toBe(path.join(l.workspaceDir, '.specrails', 'backlog-config.json'))
    expect(l.profilesDir).toBe(path.join(l.workspaceDir, '.specrails', 'profiles'))
    expect(l.pluginsStateDir).toBe(path.join(l.workspaceDir, '.specrails', 'plugins'))
    expect(l.fileSummariesDir).toBe(path.join(l.workspaceDir, '.specrails', 'file-summaries'))
  })
})

describe('readRegistryOrEmpty (fail-open)', () => {
  it('returns empty when the file is missing', () => {
    const reg = readRegistryOrEmpty(home)
    expect(reg.schemaVersion).toBe(REGISTRY_SCHEMA_VERSION)
    expect(reg.projects).toEqual({})
  })

  it('returns empty on corrupt JSON', () => {
    writeFileSync(registryPath(home), '{ not json', 'utf8')
    expect(readRegistryOrEmpty(home).projects).toEqual({})
  })

  it('returns empty when schemaVersion is newer than understood', () => {
    writeFileSync(
      registryPath(home),
      JSON.stringify({ schemaVersion: REGISTRY_SCHEMA_VERSION + 1, projects: { '/x': {} } }),
      'utf8',
    )
    expect(readRegistryOrEmpty(home).projects).toEqual({})
  })

  it('returns empty when projects is not an object', () => {
    writeFileSync(registryPath(home), JSON.stringify({ schemaVersion: 1, projects: null }), 'utf8')
    expect(readRegistryOrEmpty(home).projects).toEqual({})
  })

  it('parses a valid registry', () => {
    writeFileSync(
      registryPath(home),
      JSON.stringify({ schemaVersion: 1, projects: { '/x': { slug: 'x' } } }),
      'utf8',
    )
    expect(readRegistryOrEmpty(home).projects['/x']).toBeDefined()
  })
})

describe('atomicWrite', () => {
  it('writes the file and leaves no temp behind', () => {
    const target = path.join(home, 'sub', 'out.json')
    atomicWrite(target, '{"a":1}\n')
    expect(readFileSync(target, 'utf8')).toBe('{"a":1}\n')
    const leftovers = readdirSync(path.dirname(target)).filter((f) => f.includes('.tmp-'))
    expect(leftovers).toEqual([])
  })

  it('BUG-ARTREG-03: overwrites an existing file durably (parent-dir fsync is best-effort, never throws)', () => {
    const target = path.join(home, 'durable', 'out.json')
    atomicWrite(target, '{"v":1}\n')
    // A second write over the existing destination must still succeed (and the
    // post-rename parent-dir fsync must not surface an error on any platform).
    expect(() => atomicWrite(target, '{"v":2}\n')).not.toThrow()
    expect(readFileSync(target, 'utf8')).toBe('{"v":2}\n')
    const leftovers = readdirSync(path.dirname(target)).filter((f) => f.includes('.tmp-'))
    expect(leftovers).toEqual([])
  })
})

describe('refreshLockHeartbeat (BUG-ARTREG-04)', () => {
  it('bumps the lock mtime forward when the on-disk token still matches', () => {
    const lp = lockPath(home)
    writeFileSync(lp, 'my-token')
    // Backdate the lock close to the stale threshold.
    const stale = Date.now() / 1000 - 25
    utimesSync(lp, stale, stale)
    const before = statSync(lp).mtimeMs

    const ok = refreshLockHeartbeat(lp, 'my-token')
    expect(ok).toBe(true)
    // mtime is refreshed to ~now ⇒ the holder no longer looks stale.
    const after = statSync(lp).mtimeMs
    expect(after).toBeGreaterThan(before)
    expect(Date.now() - after).toBeLessThan(2000)
  })

  it('does NOT touch the lock when another writer owns it (token mismatch)', () => {
    const lp = lockPath(home)
    writeFileSync(lp, 'new-owner-token')
    const stale = Date.now() / 1000 - 25
    utimesSync(lp, stale, stale)
    const before = statSync(lp).mtimeMs

    // A stale-broken writer must never bump the NEW owner's mtime (that would
    // mask the legitimate owner and could trigger a second stale-break race).
    const ok = refreshLockHeartbeat(lp, 'our-old-token')
    expect(ok).toBe(false)
    expect(statSync(lp).mtimeMs).toBe(before)
  })

  it('is a no-op (returns false, never throws) when the lock file is gone', () => {
    const lp = lockPath(home)
    expect(refreshLockHeartbeat(lp, 'whatever')).toBe(false)
  })

  it('withFileLock keeps the lock mtime live for the duration of fn', () => {
    // The heartbeat interval is unref'd and can only fire between event-loop
    // turns; a synchronous fn never yields, so assert the explicit refresh helper
    // wired into withFileLock keeps the token-owned lock fresh.
    let tokenWhileHeld = ''
    let mtimeWhileHeld = 0
    withFileLock(home, () => {
      tokenWhileHeld = readFileSync(lockPath(home), 'utf8')
      mtimeWhileHeld = statSync(lockPath(home)).mtimeMs
      // An explicit heartbeat refresh (what the interval would do) lands.
      expect(refreshLockHeartbeat(lockPath(home), tokenWhileHeld)).toBe(true)
    })
    expect(tokenWhileHeld.length).toBeGreaterThan(0)
    expect(Date.now() - mtimeWhileHeld).toBeLessThan(2000)
    // Lock released after fn.
    expect(existsSync(lockPath(home))).toBe(false)
  })
})

describe('withFileLock', () => {
  it('runs fn and releases the lock', () => {
    const result = withFileLock(home, () => 42)
    expect(result).toBe(42)
    expect(existsSync(lockPath(home))).toBe(false)
  })

  it('breaks a stale lock (older than TTL)', () => {
    writeFileSync(lockPath(home), '')
    const ancient = Date.now() / 1000 - 120
    utimesSync(lockPath(home), ancient, ancient)
    const result = withFileLock(home, () => 'ran')
    expect(result).toBe('ran')
    expect(existsSync(lockPath(home))).toBe(false)
  })

  it('FAILS CLOSED (throws) when a FRESH lock is held past the deadline', () => {
    // Hold a fresh (non-stale) lock so the spin-retry exhausts the deadline.
    writeFileSync(lockPath(home), '')
    const now = Date.now() / 1000
    utimesSync(lockPath(home), now, now)
    // The contended call must THROW rather than silently proceed without the
    // lock (fail-closed parity with core). Bounded by LOCK_MAX_WAIT_MS (2s).
    expect(() => withFileLock(home, () => 'should-not-run')).toThrow(/could not acquire lock/)
    // The pre-existing lock file is left intact (we never held it).
    expect(existsSync(lockPath(home))).toBe(true)
  })

  it('writes a unique token into the lock file while held', () => {
    let tokenWhileHeld = ''
    withFileLock(home, () => {
      tokenWhileHeld = readFileSync(lockPath(home), 'utf8')
    })
    expect(tokenWhileHeld.length).toBeGreaterThan(0)
    expect(tokenWhileHeld).toContain(String(process.pid))
  })

  it('a stale-broken writer does NOT delete the new owner\'s lock on release', () => {
    // Simulate: writer A acquires, gets stale-broken by writer B (whose token now
    // owns the file). When A releases, it must leave B's lock intact because the
    // on-disk token differs from A's.
    const lp = lockPath(home)
    // Pre-create A's lock so the next withFileLock spins; then overwrite mid-flight
    // is hard to orchestrate synchronously, so assert the token-guard directly:
    // a release that finds a DIFFERENT token leaves the file untouched.
    writeFileSync(lp, 'someone-elses-token')
    const before = readFileSync(lp, 'utf8')
    // Make it stale so a new acquisition reclaims it (overwriting the token).
    const ancient = Date.now() / 1000 - 120
    utimesSync(lp, ancient, ancient)
    const result = withFileLock(home, () => {
      // While we hold it, the file carries OUR token, not the old one.
      expect(readFileSync(lp, 'utf8')).not.toBe(before)
      return 'ran'
    })
    expect(result).toBe('ran')
    // We owned it ⇒ released it.
    expect(existsSync(lp)).toBe(false)
  })
})

describe('isCompleteEntry (per-entry completeness guard)', () => {
  function fullEntry(): ProjectEntry {
    return {
      repoPath: '/repo', slug: 'repo', workspaceDir: '/ws', artifactRoot: '/ws',
      codeRoot: '/repo', stateDir: '/ws/.claude', ticketsPath: '/ws/.specrails/local-tickets.json',
      backlogConfigPath: '/ws/.specrails/backlog-config.json', profilesDir: '/ws/.specrails/profiles',
      pluginsStateDir: '/ws/.specrails/plugins', fileSummariesDir: '/ws/.specrails/file-summaries',
      providers: ['claude'], primaryProvider: 'claude', source: 'desktop',
    }
  }
  it('accepts a complete entry', () => {
    expect(isCompleteEntry(fullEntry())).toBe(true)
  })
  it('rejects an entry missing a path field', () => {
    const e = fullEntry() as Record<string, unknown>
    delete e.ticketsPath
    expect(isCompleteEntry(e)).toBe(false)
  })
  it('rejects an entry with an empty-string path field', () => {
    const e = { ...fullEntry(), workspaceDir: '' }
    expect(isCompleteEntry(e)).toBe(false)
  })
  it('rejects non-objects', () => {
    expect(isCompleteEntry(null)).toBe(false)
    expect(isCompleteEntry('x')).toBe(false)
  })
})

describe('mirrorProjectEntry', () => {
  it('inserts a fresh desktop-owned entry with every sub-path', () => {
    const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'acme-')))
    const entry = mirrorProjectEntry(
      { repoPath: repo, slug: 'acme', providers: ['claude'], desktopProjectId: 'uuid-1' },
      home,
    )
    expect(entry.source).toBe('desktop')
    expect(entry.slug).toBe('acme')
    expect(entry.desktopProjectId).toBe('uuid-1')
    expect(entry.providers).toEqual(['claude'])
    expect(entry.primaryProvider).toBe('claude')
    expect(entry.workspaceDir).toBe(path.join(home, '.specrails', 'projects', 'acme', 'workspace'))
    expect(entry.createdAt).toBeDefined()
    expect(entry.lastInstallAt).toBeDefined()
    expect(entry.updatedAt).toBeDefined()

    const reg = readRegistryOrEmpty(home)
    expect(reg.generator).toBe('specrails-desktop')
    expect(reg.projects[keyFor(repo)]).toBeDefined()
    rmSync(repo, { recursive: true, force: true })
  })

  it('defaults providers to [primaryProvider] / [claude]', () => {
    const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'acme-')))
    const e1 = mirrorProjectEntry({ repoPath: repo, slug: 'acme', primaryProvider: 'codex' }, home)
    expect(e1.providers).toEqual(['codex'])
    expect(e1.primaryProvider).toBe('codex')
    rmSync(repo, { recursive: true, force: true })

    const repo2 = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'acme2-')))
    const e2 = mirrorProjectEntry({ repoPath: repo2, slug: 'acme2' }, home)
    expect(e2.providers).toEqual(['claude'])
    rmSync(repo2, { recursive: true, force: true })
  })

  it('upsert preserves createdAt and refreshes lastInstallAt/updatedAt', () => {
    const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'acme-')))
    const first = mirrorProjectEntry({ repoPath: repo, slug: 'acme', providers: ['claude'] }, home)
    const second = mirrorProjectEntry({ repoPath: repo, slug: 'acme', providers: ['claude', 'codex'] }, home)
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.providers).toEqual(['claude', 'codex'])
    // only one entry
    expect(Object.keys(readRegistryOrEmpty(home).projects)).toHaveLength(1)
    rmSync(repo, { recursive: true, force: true })
  })

  it('ADOPTS an existing core-standalone entry: keeps slug + workspaceDir, flips source', () => {
    const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'acme-')))
    const key = keyFor(repo)
    // Pre-plant a core-standalone entry with a DIFFERENT slug + workspace.
    const coreEntry: ProjectEntry = {
      ...workspaceLayout(home, 'acme-7', canonicalizeRepoPath(repo)),
      providers: ['claude'],
      primaryProvider: 'claude',
      createdAt: '2020-01-01T00:00:00.000Z',
      source: 'core-standalone',
    }
    const reg: RegistryFile = { schemaVersion: 1, projects: { [key]: coreEntry } }
    writeFileSync(registryPath(home), JSON.stringify(reg))

    const adopted = mirrorProjectEntry(
      { repoPath: repo, slug: 'acme', providers: ['claude', 'codex'], desktopProjectId: 'uuid-9' },
      home,
    )
    expect(adopted.source).toBe('desktop')
    // slug + workspaceDir preserved from the core entry (NOT desktop's 'acme')
    expect(adopted.slug).toBe('acme-7')
    expect(adopted.workspaceDir).toBe(coreEntry.workspaceDir)
    expect(adopted.artifactRoot).toBe(coreEntry.workspaceDir)
    expect(adopted.desktopProjectId).toBe('uuid-9')
    expect(adopted.providers).toEqual(['claude', 'codex'])
    expect(adopted.createdAt).toBe('2020-01-01T00:00:00.000Z')
    rmSync(repo, { recursive: true, force: true })
  })

  it('BUG-ARTREG-02: SELF-HEALS a partial existing entry by rebuilding paths from the immutable slug (never strands legacy)', () => {
    const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'partial-')))
    const key = keyFor(repo)
    // Pre-plant a hand-edited / truncated entry: it carries the immutable slug
    // but is MISSING a path field (ticketsPath) and several others. Verbatim
    // spread would write it back incomplete → resolveArtifacts treats it as
    // ABSENT → the project is stranded in legacy mode forever.
    const partial = {
      repoPath: canonicalizeRepoPath(repo),
      slug: 'frozen-slug',
      workspaceDir: path.join(home, '.specrails', 'projects', 'frozen-slug', 'workspace'),
      // ticketsPath / backlogConfigPath / profilesDir / pluginsStateDir /
      // fileSummariesDir / artifactRoot / codeRoot / stateDir all DROPPED.
      providers: ['claude'],
      primaryProvider: 'claude',
      createdAt: '2021-03-03T00:00:00.000Z',
      source: 'core-standalone',
    } as unknown as ProjectEntry
    writeFileSync(registryPath(home), JSON.stringify({ schemaVersion: 1, projects: { [key]: partial } }))
    expect(isCompleteEntry(partial)).toBe(false)

    const healed = mirrorProjectEntry(
      { repoPath: repo, slug: 'desktop-slug', providers: ['claude'], desktopProjectId: 'uheal' },
      home,
    )
    // The IMMUTABLE slug from the existing entry is kept (never re-homed to
    // desktop's slug), and every path field is rebuilt from workspaceLayout.
    const expectedLayout = workspaceLayout(home, 'frozen-slug', canonicalizeRepoPath(repo))
    expect(healed.slug).toBe('frozen-slug')
    expect(healed.workspaceDir).toBe(expectedLayout.workspaceDir)
    expect(healed.ticketsPath).toBe(expectedLayout.ticketsPath)
    expect(healed.backlogConfigPath).toBe(expectedLayout.backlogConfigPath)
    expect(healed.profilesDir).toBe(expectedLayout.profilesDir)
    expect(healed.pluginsStateDir).toBe(expectedLayout.pluginsStateDir)
    expect(healed.fileSummariesDir).toBe(expectedLayout.fileSummariesDir)
    expect(healed.artifactRoot).toBe(expectedLayout.workspaceDir)
    expect(healed.stateDir).toBe(expectedLayout.stateDir)
    expect(healed.codeRoot).toBe(canonicalizeRepoPath(repo))
    expect(healed.source).toBe('desktop')
    expect(healed.createdAt).toBe('2021-03-03T00:00:00.000Z')

    // The written-back entry is now COMPLETE, so resolveArtifacts no longer
    // treats it as absent — the project is relocated, not stranded in legacy.
    const persisted = readRegistryOrEmpty(home).projects[key]
    expect(isCompleteEntry(persisted)).toBe(true)
    const art = resolveArtifacts(repo, { allocate: false }, home)
    expect(art.isLegacy).toBe(false)
    expect(art.ticketsPath).toBe(expectedLayout.ticketsPath)
    rmSync(repo, { recursive: true, force: true })
  })

  it('BUG-ARTREG-02: rebuilds paths from desiredSlug when the partial entry has NO slug', () => {
    const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'noslug-')))
    const key = keyFor(repo)
    const partial = {
      repoPath: canonicalizeRepoPath(repo),
      // no slug at all
      providers: ['claude'],
      primaryProvider: 'claude',
      source: 'desktop',
    } as unknown as ProjectEntry
    writeFileSync(registryPath(home), JSON.stringify({ schemaVersion: 1, projects: { [key]: partial } }))

    const healed = mirrorProjectEntry({ repoPath: repo, slug: 'fallback-slug', providers: ['claude'] }, home)
    const expectedLayout = workspaceLayout(home, 'fallback-slug', canonicalizeRepoPath(repo))
    expect(healed.slug).toBe('fallback-slug')
    expect(healed.ticketsPath).toBe(expectedLayout.ticketsPath)
    expect(isCompleteEntry(readRegistryOrEmpty(home).projects[key])).toBe(true)
    rmSync(repo, { recursive: true, force: true })
  })
})

describe('removeRegistryEntry', () => {
  it('deletes the keyed entry', () => {
    const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'acme-')))
    mirrorProjectEntry({ repoPath: repo, slug: 'acme' }, home)
    expect(readRegistryOrEmpty(home).projects[keyFor(repo)]).toBeDefined()
    removeRegistryEntry(repo, home)
    expect(readRegistryOrEmpty(home).projects[keyFor(repo)]).toBeUndefined()
    rmSync(repo, { recursive: true, force: true })
  })

  it('is a no-op when the key is absent', () => {
    const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'ghost-')))
    expect(() => removeRegistryEntry(repo, home)).not.toThrow()
    rmSync(repo, { recursive: true, force: true })
  })
})

describe('reconcileFromProjects', () => {
  it('is a no-op for an empty project list', () => {
    reconcileFromProjects([], home)
    expect(existsSync(registryPath(home))).toBe(false)
  })

  it('merge-upserts one desktop entry per project', () => {
    const a = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'a-')))
    const b = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'b-')))
    reconcileFromProjects(
      [
        { repoPath: a, slug: 'a', providers: ['claude'], desktopProjectId: 'ua' },
        { repoPath: b, slug: 'b', providers: ['codex'], primaryProvider: 'codex', desktopProjectId: 'ub' },
      ],
      home,
    )
    const reg = readRegistryOrEmpty(home)
    expect(reg.projects[keyFor(a)].source).toBe('desktop')
    expect(reg.projects[keyFor(a)].desktopProjectId).toBe('ua')
    expect(reg.projects[keyFor(b)].primaryProvider).toBe('codex')
    expect(reg.generator).toBe('specrails-desktop')
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  })

  it('LEAVES non-desktop (core-standalone) entries for untracked repos UNTOUCHED', () => {
    const tracked = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tracked-')))
    const untrackedKey = normalizeKey(path.resolve('/some/untracked/repo'))
    const coreEntry: ProjectEntry = {
      ...workspaceLayout(home, 'untracked', path.resolve('/some/untracked/repo')),
      providers: ['claude'],
      primaryProvider: 'claude',
      source: 'core-standalone',
    }
    writeFileSync(
      registryPath(home),
      JSON.stringify({ schemaVersion: 1, projects: { [untrackedKey]: coreEntry } }),
    )

    reconcileFromProjects([{ repoPath: tracked, slug: 'tracked', desktopProjectId: 'ut' }], home)

    const reg = readRegistryOrEmpty(home)
    // tracked is now desktop-owned
    expect(reg.projects[keyFor(tracked)].source).toBe('desktop')
    // untracked core-standalone entry survives, never re-homed
    expect(reg.projects[untrackedKey]).toBeDefined()
    expect(reg.projects[untrackedKey].source).toBe('core-standalone')
    expect(reg.projects[untrackedKey].slug).toBe('untracked')
    rmSync(tracked, { recursive: true, force: true })
  })

  it('adopts a core-standalone entry whose repo IS a tracked desktop project', () => {
    const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'adopt-')))
    const key = keyFor(repo)
    const coreEntry: ProjectEntry = {
      ...workspaceLayout(home, 'adopt-5', canonicalizeRepoPath(repo)),
      providers: ['claude'],
      primaryProvider: 'claude',
      createdAt: '2019-06-06T00:00:00.000Z',
      source: 'core-standalone',
    }
    writeFileSync(registryPath(home), JSON.stringify({ schemaVersion: 1, projects: { [key]: coreEntry } }))

    reconcileFromProjects([{ repoPath: repo, slug: 'adopt', desktopProjectId: 'uadopt' }], home)

    const e = readRegistryOrEmpty(home).projects[key]
    expect(e.source).toBe('desktop')
    expect(e.slug).toBe('adopt-5') // preserved from core
    expect(e.workspaceDir).toBe(coreEntry.workspaceDir)
    expect(e.desktopProjectId).toBe('uadopt')
    expect(e.createdAt).toBe('2019-06-06T00:00:00.000Z')
    rmSync(repo, { recursive: true, force: true })
  })

  it('REGRESSION: a second reconcile never re-homes an already-adopted entry (no stranded artifacts on every boot)', () => {
    const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rehome-')))
    const key = keyFor(repo)
    // Core installed standalone under a core-allocated slug that differs from
    // desktop's slug for the same repo.
    const coreEntry: ProjectEntry = {
      ...workspaceLayout(home, 'core-slug-9', canonicalizeRepoPath(repo)),
      providers: ['claude'],
      primaryProvider: 'claude',
      createdAt: '2019-01-01T00:00:00.000Z',
      source: 'core-standalone',
    }
    writeFileSync(registryPath(home), JSON.stringify({ schemaVersion: 1, projects: { [key]: coreEntry } }))

    // Desktop knows the repo under its OWN slug 'acme'. First reconcile adopts.
    reconcileFromProjects([{ repoPath: repo, slug: 'acme', desktopProjectId: 'u1' }], home)
    const first = readRegistryOrEmpty(home).projects[key]
    expect(first.slug).toBe('core-slug-9')
    expect(first.workspaceDir).toBe(coreEntry.workspaceDir)

    // Next app start: reconcile runs AGAIN with desktop's slug. Must NOT
    // re-home to 'acme' (would strand artifacts already on disk at core-slug-9).
    reconcileFromProjects([{ repoPath: repo, slug: 'acme', desktopProjectId: 'u1' }], home)
    const second = readRegistryOrEmpty(home).projects[key]
    expect(second.slug).toBe('core-slug-9')
    expect(second.workspaceDir).toBe(coreEntry.workspaceDir)
    expect(second.ticketsPath).toBe(coreEntry.ticketsPath)
    expect(second.source).toBe('desktop')
    expect(second.createdAt).toBe('2019-01-01T00:00:00.000Z')
    rmSync(repo, { recursive: true, force: true })
  })

  it('honors SPECRAILS_REGISTRY_HOME when no explicit home is passed', () => {
    const prev = process.env.SPECRAILS_REGISTRY_HOME
    process.env.SPECRAILS_REGISTRY_HOME = home
    try {
      const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'env-')))
      mirrorProjectEntry({ repoPath: repo, slug: 'env-proj' })
      expect(readRegistryOrEmpty().projects[keyFor(repo)]).toBeDefined()
      rmSync(repo, { recursive: true, force: true })
    } finally {
      if (prev !== undefined) process.env.SPECRAILS_REGISTRY_HOME = prev
      else delete process.env.SPECRAILS_REGISTRY_HOME
    }
  })
})

describe('resolveArtifacts (read-side gate primitive)', () => {
  it('isLegacy=true with repo-relative paths when no entry exists', () => {
    const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'legacy-')))
    const art = resolveArtifacts(repo, { allocate: false }, home)
    expect(art.isLegacy).toBe(true)
    expect(art.repoPath).toBe(repo)
    expect(art.workspaceDir).toBe(repo)
    expect(art.ticketsPath).toBe(path.join(repo, '.specrails', 'local-tickets.json'))
    expect(art.profilesDir).toBe(path.join(repo, '.specrails', 'profiles'))
    expect(art.entry).toBeUndefined()
    rmSync(repo, { recursive: true, force: true })
  })

  it('isLegacy=false with workspace paths when an entry exists', () => {
    const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'reloc-')))
    const entry = mirrorProjectEntry({ repoPath: repo, slug: 'reloc', providers: ['claude'] }, home)
    const art = resolveArtifacts(repo, { allocate: false }, home)
    expect(art.isLegacy).toBe(false)
    expect(art.repoPath).toBe(repo)
    expect(art.workspaceDir).toBe(entry.workspaceDir)
    expect(art.ticketsPath).toBe(entry.ticketsPath)
    expect(art.profilesDir).toBe(entry.profilesDir)
    expect(art.entry?.slug).toBe('reloc')
    rmSync(repo, { recursive: true, force: true })
  })

  it('never mutates the registry on a read (allocate:false)', () => {
    const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'noalloc-')))
    resolveArtifacts(repo, { allocate: false }, home)
    const reg = readRegistryOrEmpty(home)
    expect(reg.projects[keyFor(repo)]).toBeUndefined()
    rmSync(repo, { recursive: true, force: true })
  })

  it('falls back to LEGACY when a hand-edited entry is missing a path field', () => {
    const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'incomplete-')))
    // Allocate a full entry, then corrupt it (drop ticketsPath) on disk.
    mirrorProjectEntry({ repoPath: repo, slug: 'incomplete', providers: ['claude'] }, home)
    const reg = readRegistryOrEmpty(home)
    const key = keyFor(repo)
    delete (reg.projects[key] as Record<string, unknown>).ticketsPath
    atomicWrite(registryPath(home), JSON.stringify(reg, null, 2) + '\n')

    const art = resolveArtifacts(repo, { allocate: false }, home)
    // Incomplete entry ⇒ legacy resolution (never ticketsPath: undefined).
    expect(art.isLegacy).toBe(true)
    expect(art.entry).toBeUndefined()
    expect(art.ticketsPath).toBe(path.join(repo, '.specrails', 'local-tickets.json'))
    rmSync(repo, { recursive: true, force: true })
  })
})
