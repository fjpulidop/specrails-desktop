import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { markProjectsTrusted, ensureClaudeTrusted, claudeConfigPath } from './claude-trust'

describe('markProjectsTrusted', () => {
  let dir: string
  let cfg: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-trust-'))
    cfg = path.join(dir, '.claude.json')
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('creates the config + projects entry with hasTrustDialogAccepted when absent', () => {
    const wt = fs.mkdtempSync(path.join(dir, 'wt-'))
    expect(markProjectsTrusted(cfg, [wt])).toBe(1)
    const parsed = JSON.parse(fs.readFileSync(cfg, 'utf-8'))
    expect(parsed.projects[fs.realpathSync(wt)].hasTrustDialogAccepted).toBe(true)
  })

  it('is idempotent — a second call trusts nothing new and rewrites nothing', () => {
    const wt = fs.mkdtempSync(path.join(dir, 'wt-'))
    expect(markProjectsTrusted(cfg, [wt])).toBe(1)
    expect(markProjectsTrusted(cfg, [wt])).toBe(0)
  })

  it('preserves existing config + other project entries and only sets the trust flag', () => {
    const wt = fs.mkdtempSync(path.join(dir, 'wt-'))
    fs.writeFileSync(cfg, JSON.stringify({
      numStartups: 7,
      projects: {
        '/some/other': { hasTrustDialogAccepted: true, history: [1, 2, 3] },
        [fs.realpathSync(wt)]: { history: ['keep me'] },
      },
    }))
    expect(markProjectsTrusted(cfg, [wt])).toBe(1)
    const parsed = JSON.parse(fs.readFileSync(cfg, 'utf-8'))
    expect(parsed.numStartups).toBe(7) // untouched
    expect(parsed.projects['/some/other']).toEqual({ hasTrustDialogAccepted: true, history: [1, 2, 3] })
    // Our target: flag added, existing fields kept.
    expect(parsed.projects[fs.realpathSync(wt)]).toEqual({ history: ['keep me'], hasTrustDialogAccepted: true })
  })

  it('refuses to overwrite a corrupt config (returns 0, leaves the file)', () => {
    fs.writeFileSync(cfg, '{ this is not json')
    expect(markProjectsTrusted(cfg, ['/x'])).toBe(0)
    expect(fs.readFileSync(cfg, 'utf-8')).toBe('{ this is not json')
  })

  it('dedupes paths and ignores empties', () => {
    const wt = fs.mkdtempSync(path.join(dir, 'wt-'))
    expect(markProjectsTrusted(cfg, [wt, wt, ''])).toBe(1)
  })
})

describe('ensureClaudeTrusted', () => {
  let home: string
  let prevRegHome: string | undefined
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-'))
    prevRegHome = process.env.SPECRAILS_REGISTRY_HOME
    process.env.SPECRAILS_REGISTRY_HOME = home // claudeConfigPath resolves under here
  })
  afterEach(() => {
    if (prevRegHome === undefined) delete process.env.SPECRAILS_REGISTRY_HOME
    else process.env.SPECRAILS_REGISTRY_HOME = prevRegHome
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('no-op for non-claude providers (never writes the config)', () => {
    const wt = fs.mkdtempSync(path.join(home, 'wt-'))
    ensureClaudeTrusted('codex', [wt])
    expect(fs.existsSync(claudeConfigPath())).toBe(false)
  })

  it('trusts claude spawn dirs (writes the flag)', () => {
    const wt = fs.mkdtempSync(path.join(home, 'wt-'))
    ensureClaudeTrusted('claude', [wt, undefined])
    const cfg = claudeConfigPath()
    expect(fs.existsSync(cfg)).toBe(true)
    expect(JSON.parse(fs.readFileSync(cfg, 'utf-8')).projects[fs.realpathSync(wt)].hasTrustDialogAccepted).toBe(true)
  })

  it('re-asserts on every call — recreates the flag after the config is deleted', () => {
    const wt = fs.mkdtempSync(path.join(home, 'wt-'))
    const cfg = claudeConfigPath()
    ensureClaudeTrusted('claude', [wt])
    expect(fs.existsSync(cfg)).toBe(true)
    // Simulate a concurrent whole-file clobber that dropped our entry: delete
    // the config, call again — with no memo it MUST re-write the flag.
    fs.rmSync(cfg)
    ensureClaudeTrusted('claude', [wt])
    expect(fs.existsSync(cfg)).toBe(true)
    expect(JSON.parse(fs.readFileSync(cfg, 'utf-8')).projects[fs.realpathSync(wt)].hasTrustDialogAccepted).toBe(true)
  })

  it('re-asserts on every call — re-flips a clobbered false back to true', () => {
    const wt = fs.mkdtempSync(path.join(home, 'wt-'))
    const cfg = claudeConfigPath()
    ensureClaudeTrusted('claude', [wt])
    const real = fs.realpathSync(wt)
    // Simulate another claude process rewriting the whole file with a stale
    // `false` for our dir (the lost-update this fix defends against).
    const clobbered = { projects: { [real]: { hasTrustDialogAccepted: false, lastCost: 1.23 } } }
    fs.writeFileSync(cfg, JSON.stringify(clobbered))
    ensureClaudeTrusted('claude', [wt])
    const parsed = JSON.parse(fs.readFileSync(cfg, 'utf-8'))
    expect(parsed.projects[real].hasTrustDialogAccepted).toBe(true)
    // Sibling fields written by claude are preserved.
    expect(parsed.projects[real].lastCost).toBe(1.23)
  })
})
