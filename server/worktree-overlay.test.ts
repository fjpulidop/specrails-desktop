import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { applyWorktreeOverlay, OVERLAY_MANIFEST, revalidateOverlayCleanupEvidence } from './worktree-overlay'

let source: string
let wt: string

beforeEach(() => {
  source = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-overlay-src-')))
  wt = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-overlay-wt-')))
})

afterEach(() => {
  fs.rmSync(source, { recursive: true, force: true })
  fs.rmSync(wt, { recursive: true, force: true })
})

function write(root: string, rel: string, content = 'x'): void {
  const p = path.join(root, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

const apply = () =>
  applyWorktreeOverlay({ worktreePath: wt, sourceRoot: source, providerDir: '.claude', instructionsFilename: 'CLAUDE.md' })

/** Simulate a RELOCATED workspace source: framework surface lives ONLY here. */
function seedWorkspaceSource(): void {
  write(source, '.claude/commands/specrails/implement.md', '# implement')
  write(source, '.claude/commands/specrails/retry.md', '# retry')
  write(source, '.claude/agents/sr-architect.md', '# arch')
  write(source, '.claude/agents/sr-developer.md', '# dev')
  write(source, '.claude/skills/spec/SKILL.md', '# skill')
  write(source, '.claude/rules/layer.md', '# rules')
  write(source, '.claude/settings.json', '{}')
  fs.mkdirSync(path.join(source, '.claude', 'agent-memory'), { recursive: true })
  write(source, '.mcp.json', '{"mcpServers":{}}')
  write(source, 'CLAUDE.md', '# workspace instructions')
}

describe('applyWorktreeOverlay — relocated workspace source', () => {
  it('links the framework surface the checkout lacks; whole-dir links where absent', () => {
    seedWorkspaceSource()
    // The checkout tracks only .claude/commands/opsx (the myproject shape).
    write(wt, '.claude/commands/opsx/new.md', '# opsx')

    const res = apply()

    expect(res.warnings).toEqual([])
    // commands is partially present → the ROOT stays a real dir, per-child links.
    expect(fs.lstatSync(path.join(wt, '.claude', 'commands')).isDirectory()).toBe(true)
    expect(fs.lstatSync(path.join(wt, '.claude', 'commands', 'specrails')).isSymbolicLink()).toBe(true)
    // The native command resolves THROUGH the link.
    expect(fs.readFileSync(path.join(wt, '.claude', 'commands', 'specrails', 'implement.md'), 'utf-8')).toBe('# implement')
    // The checkout's own tracked entry is untouched (a real dir, same content).
    expect(fs.lstatSync(path.join(wt, '.claude', 'commands', 'opsx')).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(path.join(wt, '.claude', 'commands', 'opsx', 'new.md'), 'utf-8')).toBe('# opsx')
    // Wholly-absent dirs are single dir links.
    for (const d of ['agents', 'skills', 'rules', 'agent-memory']) {
      expect(fs.lstatSync(path.join(wt, '.claude', d)).isSymbolicLink()).toBe(true)
    }
    expect(fs.lstatSync(path.join(wt, '.claude', 'settings.json')).isSymbolicLink()).toBe(true)
    expect(res.createdPaths).toEqual(expect.arrayContaining([
      '.claude/commands/specrails', '.claude/agents', '.claude/skills', '.claude/rules',
      '.claude/agent-memory', '.claude/settings.json', OVERLAY_MANIFEST,
    ]))
  })

  it('agents partially present → per-file links; the user file is NEVER overwritten', () => {
    seedWorkspaceSource()
    write(source, '.claude/agents/custom-mine.md', 'SRC VERSION')
    write(wt, '.claude/agents/custom-mine.md', 'CHECKOUT VERSION')

    const res = apply()

    expect(fs.lstatSync(path.join(wt, '.claude', 'agents')).isDirectory()).toBe(true)
    expect(fs.lstatSync(path.join(wt, '.claude', 'agents', 'sr-architect.md')).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(wt, '.claude', 'agents', 'custom-mine.md'), 'utf-8')).toBe('CHECKOUT VERSION')
    expect(res.createdPaths).toContain('.claude/agents/sr-architect.md')
    expect(res.createdPaths).not.toContain('.claude/agents/custom-mine.md')
  })

  it('preserves whitespace and glob metacharacters in authenticated overlay filenames', () => {
    const name = ' user[1]*.md '
    write(source, `.claude/rules/${name}`, 'literal filename')
    write(wt, '.claude/rules/tracked.md', 'checkout')

    const res = apply()
    const rel = `.claude/rules/${name}`

    expect(res.createdPaths).toContain(rel)
    expect(res.cleanupEvidence.some((entry) => entry.path === rel)).toBe(true)
    expect(fs.readFileSync(path.join(wt, rel), 'utf8')).toBe('literal filename')
  })

  it('agent-memory is LINKED: writes through the worktree land in the shared source (shared-cwd semantics)', () => {
    seedWorkspaceSource()
    apply()
    fs.writeFileSync(path.join(wt, '.claude', 'agent-memory', 'sr-developer.md'), 'memory entry')
    expect(fs.readFileSync(path.join(source, '.claude', 'agent-memory', 'sr-developer.md'), 'utf-8')).toBe('memory entry')
  })

  it('.mcp.json and the instruction file are COPIED (spawn-local), not linked', () => {
    seedWorkspaceSource()
    const res = apply()
    for (const f of ['.mcp.json', 'CLAUDE.md']) {
      const st = fs.lstatSync(path.join(wt, f))
      expect(st.isSymbolicLink()).toBe(false)
      expect(st.isFile()).toBe(true)
      expect(res.createdPaths).toContain(f)
    }
    expect(fs.readFileSync(path.join(wt, 'CLAUDE.md'), 'utf-8')).toBe('# workspace instructions')
  })

  it('a checkout-tracked instruction file always wins over the source one', () => {
    seedWorkspaceSource()
    write(wt, 'CLAUDE.md', '# the repo tracked its own')
    const res = apply()
    expect(fs.readFileSync(path.join(wt, 'CLAUDE.md'), 'utf-8')).toBe('# the repo tracked its own')
    expect(res.createdPaths).not.toContain('CLAUDE.md')
  })

  it('never links the source `worktrees` entry (nested pipeline worktrees stay local)', () => {
    seedWorkspaceSource()
    write(source, '.claude/worktrees/dev-1/file.txt', 'nested')
    apply()
    expect(fs.existsSync(path.join(wt, '.claude', 'worktrees'))).toBe(false)
  })
})

describe('applyWorktreeOverlay — legacy repo source (untracked on-disk entries)', () => {
  it('links repo entries missing from the checkout, preserving tracked content', () => {
    // The repo has an UNTRACKED .claude/commands/specrails on disk; the worktree
    // checkout materialized only the tracked opsx commands.
    write(source, '.claude/commands/specrails/implement.md', '# implement')
    write(source, '.claude/commands/opsx/new.md', '# opsx tracked')
    write(wt, '.claude/commands/opsx/new.md', '# opsx tracked')

    const res = apply()

    expect(fs.lstatSync(path.join(wt, '.claude', 'commands', 'specrails')).isSymbolicLink()).toBe(true)
    // The tracked entry exists in BOTH → skipped, stays a real file.
    expect(fs.lstatSync(path.join(wt, '.claude', 'commands', 'opsx', 'new.md')).isSymbolicLink()).toBe(false)
    expect(res.createdPaths).toContain('.claude/commands/specrails')
    expect(res.createdPaths).not.toContain('.claude/commands/opsx/new.md')
  })

  it('a fully-tracked checkout (everything already present) is a strict no-op', () => {
    write(source, '.claude/commands/specrails/implement.md', '# implement')
    write(source, '.mcp.json', '{}')
    write(source, 'CLAUDE.md', '# repo')
    write(wt, '.claude/commands/specrails/implement.md', '# implement')
    write(wt, '.mcp.json', '{}')
    write(wt, 'CLAUDE.md', '# repo')

    const res = apply()

    expect(res.createdPaths).toEqual([])
    expect(res.warnings).toEqual([])
    expect(fs.existsSync(path.join(wt, OVERLAY_MANIFEST))).toBe(false)
    expect(fs.lstatSync(path.join(wt, '.claude', 'commands', 'specrails', 'implement.md')).isSymbolicLink()).toBe(false)
  })

  it('a source with no providerDir / no root files at all is a silent no-op', () => {
    const res = apply()
    expect(res).toEqual({ createdPaths: [], cleanupEvidence: [], warnings: [] })
  })
})

describe('applyWorktreeOverlay — idempotency + resume', () => {
  it('a second pass re-claims every entry without duplicating or re-creating', () => {
    seedWorkspaceSource()
    const first = apply()
    const second = apply()
    expect([...second.createdPaths].sort()).toEqual([...first.createdPaths].sort())
    expect(second.warnings).toEqual([])
    // Still exactly one link, still resolving.
    expect(fs.readFileSync(path.join(wt, '.claude', 'commands', 'specrails', 'implement.md'), 'utf-8')).toBe('# implement')
  })

  it('RESUME: the manifest keeps prior-pass copies excluded even though they now "exist"', () => {
    seedWorkspaceSource()
    const first = apply()
    expect(first.createdPaths).toContain('.mcp.json')
    // A resumed worktree already holds the copied .mcp.json — copyIfAbsent skips
    // it, but the manifest union must still report it overlay-owned.
    const resumed = apply()
    expect(resumed.createdPaths).toContain('.mcp.json')
    expect(resumed.createdPaths).toContain(OVERLAY_MANIFEST)
  })

  it('never trusts a tampered manifest to claim an arbitrary user path', () => {
    seedWorkspaceSource()
    apply()
    write(wt, 'user-cache/valuable.bin', 'keep me')
    fs.writeFileSync(path.join(wt, OVERLAY_MANIFEST), JSON.stringify({
      version: 1,
      paths: ['.mcp.json', 'user-cache/valuable.bin'],
    }))

    const resumed = apply()

    expect(resumed.createdPaths).toContain('.mcp.json')
    expect(resumed.createdPaths).not.toContain('user-cache/valuable.bin')
    expect(resumed.cleanupEvidence.some((entry) => entry.path === 'user-cache/valuable.bin')).toBe(false)
    expect(fs.readFileSync(path.join(wt, 'user-cache/valuable.bin'), 'utf8')).toBe('keep me')
  })

  it('revokes cleanup authority when the writable manifest changes after allocation', () => {
    seedWorkspaceSource()
    const allocated = apply()
    fs.writeFileSync(path.join(wt, OVERLAY_MANIFEST), JSON.stringify({ paths: ['valuable.txt'] }))

    const settled = revalidateOverlayCleanupEvidence({
      worktreePath: wt,
      sourceRoot: source,
      providerDir: '.claude',
      instructionsFilename: 'CLAUDE.md',
    }, allocated.cleanupEvidence)

    expect(settled.some((entry) => entry.path === OVERLAY_MANIFEST)).toBe(false)
  })

  it('stops claiming a copied overlay file once the worktree copy is modified', () => {
    seedWorkspaceSource()
    apply()
    fs.writeFileSync(path.join(wt, '.mcp.json'), '{"user":"changed this copy"}')

    const resumed = apply()

    expect(resumed.createdPaths).not.toContain('.mcp.json')
    expect(fs.readFileSync(path.join(wt, '.mcp.json'), 'utf8')).toContain('changed this copy')
  })

  it('tolerates a corrupt manifest (treated as empty)', () => {
    seedWorkspaceSource()
    fs.writeFileSync(path.join(wt, OVERLAY_MANIFEST), 'not-json{{{')
    const res = apply()
    expect(res.createdPaths).toContain('.claude/commands') // wholly-absent → dir link
    expect(res.warnings).toEqual([])
  })
})

describe('applyWorktreeOverlay — degradation (never throws)', () => {
  it('missing worktree dir → warning, empty result', () => {
    seedWorkspaceSource()
    const res = applyWorktreeOverlay({
      worktreePath: path.join(wt, 'does-not-exist'),
      sourceRoot: source,
      providerDir: '.claude',
      instructionsFilename: 'CLAUDE.md',
    })
    expect(res.createdPaths).toEqual([])
    expect(res.cleanupEvidence).toEqual([])
    expect(res.warnings.some((w) => w.includes('worktree dir missing'))).toBe(true)
  })

  it('providerDir occupied by a FILE in the checkout → warning, framework overlay skipped, root copies still land', () => {
    seedWorkspaceSource()
    fs.writeFileSync(path.join(wt, '.claude'), 'i am a file')
    const res = apply()
    expect(res.warnings.some((w) => w.includes('.claude'))).toBe(true)
    // Root-level copies still degrade gracefully INTO place.
    expect(fs.existsSync(path.join(wt, '.mcp.json'))).toBe(true)
    expect(fs.readFileSync(path.join(wt, '.claude'), 'utf-8')).toBe('i am a file')
  })

  it('source root equal to the worktree → no-op (self-overlay guard)', () => {
    const res = applyWorktreeOverlay({
      worktreePath: wt,
      sourceRoot: wt,
      providerDir: '.claude',
      instructionsFilename: 'CLAUDE.md',
    })
    expect(res).toEqual({ createdPaths: [], cleanupEvidence: [], warnings: [] })
  })
})
