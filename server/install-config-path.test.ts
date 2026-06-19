import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  installConfigPath,
  projectHomeDir,
  ensureInstallConfigDir,
} from './install-config-path'

describe('install-config-path', () => {
  let home: string
  let prevHome: string | undefined
  let repo: string

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'icp-home-'))
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'icp-repo-'))
    prevHome = process.env.SPECRAILS_REGISTRY_HOME
    process.env.SPECRAILS_REGISTRY_HOME = home
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(repo, { recursive: true, force: true })
    if (prevHome === undefined) delete process.env.SPECRAILS_REGISTRY_HOME
    else process.env.SPECRAILS_REGISTRY_HOME = prevHome
  })

  it('resolves into the per-project HOME dir when a slug is present', () => {
    const p = installConfigPath({ slug: 'my-repo', path: repo })
    expect(p).toBe(path.join(home, '.specrails', 'projects', 'my-repo', 'install-config.yaml'))
  })

  it('NEVER returns a path inside the user repo (slug present)', () => {
    const p = installConfigPath({ slug: 'my-repo', path: repo })
    expect(p.startsWith(repo)).toBe(false)
    expect(p).not.toContain(path.join(repo, '.specrails'))
  })

  it('projectHomeDir mirrors the install-config parent dir', () => {
    expect(path.dirname(installConfigPath({ slug: 's', path: repo }))).toBe(
      projectHomeDir('s', home),
    )
  })

  it('falls back to a tmp staging path (NOT the repo) when slug is absent', () => {
    const p = installConfigPath({ path: repo })
    expect(p.startsWith(repo)).toBe(false)
    expect(path.basename(p)).toBe('install-config.yaml')
    expect(p.startsWith(os.tmpdir())).toBe(true)
  })

  it('falls back for unsafe slugs (path traversal / separators)', () => {
    for (const slug of ['../evil', 'a/b', 'a\\b', '', '   ']) {
      const p = installConfigPath({ slug, path: repo })
      expect(p.startsWith(os.tmpdir())).toBe(true)
      expect(p).not.toContain('evil')
    }
  })

  it('tmp-staging path is deterministic per repo', () => {
    expect(installConfigPath({ path: repo })).toBe(installConfigPath({ path: repo }))
  })

  it('ensureInstallConfigDir creates the parent and returns the file path', () => {
    const p = ensureInstallConfigDir({ slug: 'made', path: repo }, home)
    expect(fs.existsSync(path.dirname(p))).toBe(true)
    expect(p).toBe(path.join(home, '.specrails', 'projects', 'made', 'install-config.yaml'))
    // Writing the config does NOT create any .specrails inside the repo.
    fs.writeFileSync(p, 'version: 1\n')
    expect(fs.existsSync(path.join(repo, '.specrails'))).toBe(false)
  })

  it('honors an explicit home override over the env var', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'icp-other-'))
    try {
      const p = installConfigPath({ slug: 's', path: repo }, other)
      expect(p).toBe(path.join(other, '.specrails', 'projects', 's', 'install-config.yaml'))
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })
})
