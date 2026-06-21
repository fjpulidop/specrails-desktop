import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
} from 'fs'
import os from 'os'
import path from 'path'

import { FrameworkManager, frameworkRoot } from './framework-manager'
import { migrateWorkspaceToSymlinks, providerDirFor } from './framework-migration'
import { workspacePathFor } from './workspace-manager'

/**
 * framework-migration tests. A FAKE bundled-core CLI stands in for core's
 * compiled installer. Its `install-framework` populates
 * `<fw>/<version>/<providerDir>/{agents,commands}` with KNOWN byte content and
 * points `current`; its `assemble` re-creates the workspace providerDir as
 * SYMLINKS to `current/<providerDir>/{agents,commands,skills,rules}` + a real
 * `agent-memory` dir. We then plant a per-workspace COPY layout and assert the
 * migration converts it non-destructively.
 */

const FAKE_CLI = `
const fs = require('fs')
const path = require('path')
function arg(name) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const sub = process.argv[2]
const providerDirFor = (p) => p === 'codex' ? '.codex' : p === 'gemini' ? '.gemini' : '.claude'
const SUBS = ['commands', 'agents', 'skills', 'rules']
if (sub === 'install-framework') {
  const fw = arg('framework-dir'); const provider = arg('provider'); const version = arg('version')
  const pd = providerDirFor(provider)
  for (const s of SUBS) {
    const dir = path.join(fw, version, pd, s)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, s + '.md'), '# framework ' + s + ' v1')
  }
  const cur = path.join(fw, 'current')
  try { fs.unlinkSync(cur) } catch {}
  fs.symlinkSync(version, cur)
  process.exit(0)
} else if (sub === 'assemble') {
  const ws = arg('workspace'); const provider = arg('provider')
  const fw = arg('framework-dir')
  const pd = providerDirFor(provider)
  fs.mkdirSync(path.join(ws, pd), { recursive: true })
  for (const s of SUBS) {
    const link = path.join(ws, pd, s)
    try { fs.rmSync(link, { recursive: true, force: true }) } catch {}
    const target = path.join(fw, 'current', pd, s)
    fs.symlinkSync(target, link)
  }
  // Real writable agent-memory (never linked); only create when absent.
  const mem = path.join(ws, pd, 'agent-memory')
  if (!fs.existsSync(mem)) fs.mkdirSync(path.join(mem, 'sr-architect'), { recursive: true })
  process.exit(0)
}
process.exit(7)
`

/**
 * A PARTIAL assemble that links only `agents` (and exits 0) — the rest stay
 * unlinked. Drives the `.some()` vs `.every()` verify distinction (BUG-FW-03):
 * `.some()` would pass (agents linked) and delete EVERY backup, dropping the
 * recoverable backups of the still-unlinked subtrees; `.every()` reverts instead.
 */
const FAKE_CLI_PARTIAL_ASSEMBLE = `
const fs = require('fs')
const path = require('path')
function arg(name) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const sub = process.argv[2]
const providerDirFor = (p) => p === 'codex' ? '.codex' : p === 'gemini' ? '.gemini' : '.claude'
const SUBS = ['commands', 'agents', 'skills', 'rules']
if (sub === 'install-framework') {
  const fw = arg('framework-dir'); const provider = arg('provider'); const version = arg('version')
  const pd = providerDirFor(provider)
  for (const s of SUBS) {
    const dir = path.join(fw, version, pd, s)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, s + '.md'), '# framework ' + s + ' v1')
  }
  const cur = path.join(fw, 'current')
  try { fs.unlinkSync(cur) } catch {}
  fs.symlinkSync(version, cur)
  process.exit(0)
} else if (sub === 'assemble') {
  const ws = arg('workspace'); const provider = arg('provider'); const fw = arg('framework-dir')
  const pd = providerDirFor(provider)
  fs.mkdirSync(path.join(ws, pd), { recursive: true })
  // Link ONLY agents — leave commands/skills/rules unlinked (partial assemble).
  const link = path.join(ws, pd, 'agents')
  try { fs.rmSync(link, { recursive: true, force: true }) } catch {}
  fs.symlinkSync(path.join(fw, 'current', pd, 'agents'), link)
  process.exit(0)
}
process.exit(7)
`

/** A broken assemble that does NOT create symlinks (forces verify failure). */
const FAKE_CLI_BROKEN_ASSEMBLE = `
const fs = require('fs')
const path = require('path')
function arg(name) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const sub = process.argv[2]
const providerDirFor = (p) => p === 'codex' ? '.codex' : p === 'gemini' ? '.gemini' : '.claude'
const SUBS = ['commands', 'agents', 'skills', 'rules']
if (sub === 'install-framework') {
  const fw = arg('framework-dir'); const provider = arg('provider'); const version = arg('version')
  const pd = providerDirFor(provider)
  for (const s of SUBS) {
    const dir = path.join(fw, version, pd, s)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, s + '.md'), '# framework ' + s + ' v1')
  }
  const cur = path.join(fw, 'current')
  try { fs.unlinkSync(cur) } catch {}
  fs.symlinkSync(version, cur)
  process.exit(0)
}
// assemble: do nothing → no symlinks → verify fails
process.exit(0)
`

describe('framework-migration', () => {
  let home: string
  let coreDir: string
  let repo: string
  let prevCoreEnv: string | undefined

  const SLUG = 'demo'
  const PROVIDER = 'claude'
  const PROVIDER_DIR = providerDirFor(PROVIDER)
  const VERSION = '5.0.0'
  const SUBS = ['commands', 'agents', 'skills', 'rules']

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'fmig-home-'))
    coreDir = mkdtempSync(path.join(os.tmpdir(), 'fmig-core-'))
    repo = mkdtempSync(path.join(os.tmpdir(), 'fmig-repo-'))
    prevCoreEnv = process.env.SPECRAILS_BUNDLED_CORE_PATH
  })

  afterEach(() => {
    if (prevCoreEnv === undefined) delete process.env.SPECRAILS_BUNDLED_CORE_PATH
    else process.env.SPECRAILS_BUNDLED_CORE_PATH = prevCoreEnv
    rmSync(home, { recursive: true, force: true })
    rmSync(coreDir, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  function installFakeCore(cli = FAKE_CLI, version = VERSION): void {
    mkdirSync(path.join(coreDir, 'dist', 'installer'), { recursive: true })
    writeFileSync(path.join(coreDir, 'dist', 'installer', 'cli.js'), cli)
    writeFileSync(path.join(coreDir, 'package.json'), JSON.stringify({ version }))
    process.env.SPECRAILS_BUNDLED_CORE_PATH = coreDir
  }

  /** Materialize `framework/current` then return the framework providerDir. */
  function materialize(): string {
    const fm = new FrameworkManager({ home })
    fm.materialize(VERSION, [PROVIDER])
    return path.join(frameworkRoot(home), 'current', PROVIDER_DIR)
  }

  /** Plant a per-workspace COPY layout whose shared subtrees byte-match the
   *  framework (a "migratable copy"). Returns the workspace providerDir. */
  function plantCopy(fwProviderDir: string, opts: { customAgent?: boolean; divergeFile?: string } = {}): string {
    const ws = workspacePathFor(SLUG, home)
    const wsPd = path.join(ws, PROVIDER_DIR)
    for (const s of SUBS) {
      const dir = path.join(wsPd, s)
      mkdirSync(dir, { recursive: true })
      const src = readFileSync(path.join(fwProviderDir, s, s + '.md'), 'utf8')
      writeFileSync(path.join(dir, s + '.md'), src)
    }
    if (opts.customAgent) {
      writeFileSync(path.join(wsPd, 'agents', 'custom-serena.md'), '# user/plugin agent')
    }
    if (opts.divergeFile) {
      const [sub, file] = opts.divergeFile.split('/')
      writeFileSync(path.join(wsPd, sub, file), '# USER EDITED THIS')
    }
    // A real, populated agent-memory dir (per-workspace state).
    mkdirSync(path.join(wsPd, 'agent-memory', 'sr-architect'), { recursive: true })
    writeFileSync(path.join(wsPd, 'agent-memory', 'sr-architect', 'notes.md'), 'remembered')
    return wsPd
  }

  function isLink(p: string): boolean {
    try { return lstatSync(p).isSymbolicLink() } catch { return false }
  }

  describe('graceful no-op', () => {
    it('no-bundle when no bundled core', () => {
      delete process.env.SPECRAILS_BUNDLED_CORE_PATH
      const res = migrateWorkspaceToSymlinks(SLUG, repo, PROVIDER, { home })
      expect(res.outcome).toBe('no-bundle')
    })

    it('no-bundle when framework/current is absent (not yet materialized)', () => {
      installFakeCore()
      const res = migrateWorkspaceToSymlinks(SLUG, repo, PROVIDER, { home })
      expect(res.outcome).toBe('no-bundle')
    })

    it('not-a-copy when the workspace has no shared providerDir subtree', () => {
      installFakeCore()
      materialize()
      // workspace exists but empty providerDir
      mkdirSync(path.join(workspacePathFor(SLUG, home), PROVIDER_DIR), { recursive: true })
      const res = migrateWorkspaceToSymlinks(SLUG, repo, PROVIDER, { home })
      expect(res.outcome).toBe('not-a-copy')
    })
  })

  describe('happy path: copy → symlink', () => {
    it('backs up, re-links, verifies, deletes the backup, preserves agent-memory', () => {
      installFakeCore()
      const fwPd = materialize()
      const wsPd = plantCopy(fwPd)
      // Pre-condition: shared subtrees are REAL dirs (copies), not links.
      for (const s of SUBS) expect(isLink(path.join(wsPd, s))).toBe(false)

      const broadcast = vi.fn()
      const res = migrateWorkspaceToSymlinks(SLUG, repo, PROVIDER, { home, broadcast })
      expect(res.outcome).toBe('migrated')

      // All shared subtrees are now symlinks resolving into framework/current.
      for (const s of SUBS) {
        const link = path.join(wsPd, s)
        expect(isLink(link)).toBe(true)
        const target = readlinkSync(link)
        const abs = path.isAbsolute(target) ? target : path.resolve(wsPd, target)
        expect(abs).toContain(path.join('framework', 'current'))
        expect(existsSync(path.join(wsPd, s, s + '.md'))).toBe(true)
      }
      // Backups deleted on success.
      for (const s of SUBS) expect(existsSync(path.join(wsPd, s + '.pre-symlink.bak'))).toBe(false)
      // agent-memory preserved as a REAL dir with the user's content.
      const mem = path.join(wsPd, 'agent-memory', 'sr-architect', 'notes.md')
      expect(existsSync(mem)).toBe(true)
      expect(readFileSync(mem, 'utf8')).toBe('remembered')
      expect(isLink(path.join(wsPd, 'agent-memory'))).toBe(false)
      // framework.migrated broadcast (app-level, no projectId).
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'framework.migrated', slug: SLUG, provider: PROVIDER }),
      )
      const call = broadcast.mock.calls.find((c) => c[0].type === 'framework.migrated')!
      expect(call[0]).not.toHaveProperty('projectId')
    })

    it('preserves a custom-*.md agent (never deleted with the backup)', () => {
      installFakeCore()
      const fwPd = materialize()
      const wsPd = plantCopy(fwPd, { customAgent: true })
      const broadcast = vi.fn()
      const res = migrateWorkspaceToSymlinks(SLUG, repo, PROVIDER, { home, broadcast })
      expect(res.outcome).toBe('migrated')
      // The agents subtree is now a symlink into the framework.
      expect(isLink(path.join(wsPd, 'agents'))).toBe(true)
      // The custom agent lived in the agents copy → it must be PRESERVED (the
      // backup with custom content is retained, not deleted).
      const preserved = path.join(wsPd, 'agents.custom.preserved', 'custom-serena.md')
      expect(existsSync(preserved)).toBe(true)
      expect(readFileSync(preserved, 'utf8')).toBe('# user/plugin agent')
      // And the shared-only subtrees ARE deleted (nothing custom in them).
      expect(existsSync(path.join(wsPd, 'commands.pre-symlink.bak'))).toBe(false)
      expect(existsSync(path.join(wsPd, 'commands.custom.preserved'))).toBe(false)
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'framework.custom_agents_preserved', files: ['custom-serena.md'] }),
      )
    })
  })

  describe('idempotent', () => {
    it('already-symlinked on a second run (no-op)', () => {
      installFakeCore()
      const fwPd = materialize()
      plantCopy(fwPd)
      expect(migrateWorkspaceToSymlinks(SLUG, repo, PROVIDER, { home }).outcome).toBe('migrated')
      // Second run: workspace is symlinked → no-op.
      const res = migrateWorkspaceToSymlinks(SLUG, repo, PROVIDER, { home })
      expect(res.outcome).toBe('already-symlinked')
    })

    it('already-symlinked when the workspace was assembled (never a copy)', () => {
      installFakeCore()
      const fwPd = materialize()
      // Directly assemble symlinks (no copy planted).
      const ws = workspacePathFor(SLUG, home)
      const wsPd = path.join(ws, PROVIDER_DIR)
      mkdirSync(wsPd, { recursive: true })
      for (const s of SUBS) {
        symlinkSync(path.join(fwPd, s), path.join(wsPd, s))
      }
      const res = migrateWorkspaceToSymlinks(SLUG, repo, PROVIDER, { home })
      expect(res.outcome).toBe('already-symlinked')
    })
  })

  describe('local divergence guard (NEVER migrate a user edit)', () => {
    it('skips + leaves the copy when a shared framework file diverges', () => {
      installFakeCore()
      const fwPd = materialize()
      const wsPd = plantCopy(fwPd, { divergeFile: 'commands/commands.md' })
      const broadcast = vi.fn()
      const res = migrateWorkspaceToSymlinks(SLUG, repo, PROVIDER, { home, broadcast })
      expect(res.outcome).toBe('skipped-divergence')
      expect(res.detail).toContain('commands')
      // The copy is LEFT untouched (real dirs, user edit intact).
      for (const s of SUBS) expect(isLink(path.join(wsPd, s))).toBe(false)
      expect(readFileSync(path.join(wsPd, 'commands', 'commands.md'), 'utf8')).toBe('# USER EDITED THIS')
      // No .bak created (we never mutated).
      for (const s of SUBS) expect(existsSync(path.join(wsPd, s + '.pre-symlink.bak'))).toBe(false)
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'framework.migration_skipped', reason: 'local-divergence' }),
      )
    })

    it('a custom-*.md agent does NOT count as divergence', () => {
      installFakeCore()
      const fwPd = materialize()
      // Only a custom agent added (no shared-file edit) → still migratable.
      plantCopy(fwPd, { customAgent: true })
      const res = migrateWorkspaceToSymlinks(SLUG, repo, PROVIDER, { home })
      expect(res.outcome).toBe('migrated')
    })
  })

  describe('revert-on-verify-failure', () => {
    it('restores the backup when the re-link does not resolve into framework/current', () => {
      // install-framework works (materialize); assemble is a no-op (no symlinks).
      installFakeCore(FAKE_CLI_BROKEN_ASSEMBLE)
      const fwPd = materialize()
      const wsPd = plantCopy(fwPd)
      // Capture original content to prove it's restored byte-for-byte.
      const before = SUBS.map((s) => readFileSync(path.join(wsPd, s, s + '.md'), 'utf8'))

      const broadcast = vi.fn()
      const res = migrateWorkspaceToSymlinks(SLUG, repo, PROVIDER, { home, broadcast })
      expect(res.outcome).toBe('reverted')
      // Backups restored: shared subtrees are REAL dirs again with original bytes.
      for (let i = 0; i < SUBS.length; i++) {
        const s = SUBS[i]
        expect(isLink(path.join(wsPd, s))).toBe(false)
        expect(readFileSync(path.join(wsPd, s, s + '.md'), 'utf8')).toBe(before[i])
        expect(existsSync(path.join(wsPd, s + '.pre-symlink.bak'))).toBe(false)
      }
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'framework.migration_skipped', reason: 'verify-failed' }),
      )
    })

    it('BUG-FW-03: a PARTIAL assemble (only agents linked) reverts — every backup is restored', () => {
      // With the old `.some()` verify, one linked subtree (agents) passed verify
      // and the unconditional cleanup deleted EVERY backup — silently dropping the
      // recoverable backups of commands/skills/rules which were NOT re-linked.
      // `.every()` requires all backed-up subtrees to link → this reverts instead,
      // restoring every backup byte-for-byte (no data loss).
      installFakeCore(FAKE_CLI_PARTIAL_ASSEMBLE)
      const fwPd = materialize()
      const wsPd = plantCopy(fwPd)
      const before = SUBS.map((s) => readFileSync(path.join(wsPd, s, s + '.md'), 'utf8'))

      const broadcast = vi.fn()
      const res = migrateWorkspaceToSymlinks(SLUG, repo, PROVIDER, { home, broadcast })
      expect(res.outcome).toBe('reverted')

      // Every shared subtree is a REAL dir again with original bytes — including
      // the ones the partial assemble linked (agents): full revert, nothing lost.
      for (let i = 0; i < SUBS.length; i++) {
        const s = SUBS[i]
        expect(isLink(path.join(wsPd, s))).toBe(false)
        expect(readFileSync(path.join(wsPd, s, s + '.md'), 'utf8')).toBe(before[i])
        // No backup is left orphaned after a clean revert.
        expect(existsSync(path.join(wsPd, s + '.pre-symlink.bak'))).toBe(false)
      }
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'framework.migration_skipped', reason: 'verify-failed' }),
      )
    })
  })
})
