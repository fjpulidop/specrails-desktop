import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'fs'
import os from 'os'
import path from 'path'

import {
  ensureOpenspecShim,
  openspecShimDir,
  prependShimToPath,
  removeOpenspecShim,
  OPENSPEC_NPX_SPEC,
} from './openspec-shim'

describe('openspec-shim', () => {
  let home: string
  let prevBundled: string | undefined

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'osshim-'))
    prevBundled = process.env.SPECRAILS_BUNDLED_OPENSPEC_PATH
    delete process.env.SPECRAILS_BUNDLED_OPENSPEC_PATH
  })

  afterEach(() => {
    if (prevBundled === undefined) delete process.env.SPECRAILS_BUNDLED_OPENSPEC_PATH
    else process.env.SPECRAILS_BUNDLED_OPENSPEC_PATH = prevBundled
    rmSync(home, { recursive: true, force: true })
  })

  describe('openspecShimDir', () => {
    it('is per-slug + per-job under the home projects dir', () => {
      const dir = openspecShimDir('my-proj', 'job-1', home)
      expect(dir).toBe(
        path.join(home, '.specrails', 'projects', 'my-proj', 'openspec-shim', 'job-1'),
      )
    })
  })

  describe('ensureOpenspecShim (npx fallback — no bundled openspec)', () => {
    it('writes an openspec POSIX script that cds into SPECRAILS_REPO_DIR and execs npx', () => {
      const dir = ensureOpenspecShim('my-proj', 'job-1', home)
      expect(dir).toBe(openspecShimDir('my-proj', 'job-1', home))
      const posix = readFileSync(path.join(dir!, 'openspec'), 'utf8')
      expect(posix).toContain('#!/bin/sh')
      expect(posix).toContain('cd "${SPECRAILS_REPO_DIR:-.}"')
      expect(posix).toContain(`npx -y '${OPENSPEC_NPX_SPEC}'`)
      expect(posix.trimEnd().endsWith('"$@"')).toBe(true)
    })

    it('writes a Windows openspec.cmd that cds into SPECRAILS_REPO_DIR', () => {
      const dir = ensureOpenspecShim('my-proj', 'job-1', home)
      const cmd = readFileSync(path.join(dir!, 'openspec.cmd'), 'utf8')
      expect(cmd).toContain('@echo off')
      expect(cmd).toContain('if defined SPECRAILS_REPO_DIR cd /d "%SPECRAILS_REPO_DIR%"')
      expect(cmd).toContain('npx -y "@fission-ai/openspec@1.4.1"')
      expect(cmd).toContain('%*')
    })

    it('makes the POSIX shim executable (0755) inside a 0700 dir on POSIX', () => {
      if (process.platform === 'win32') return
      const dir = ensureOpenspecShim('my-proj', 'job-1', home)!
      const dmode = statSync(dir).mode & 0o777
      expect(dmode).toBe(0o700)
      const fmode = statSync(path.join(dir, 'openspec')).mode & 0o777
      expect(fmode).toBe(0o755)
    })
  })

  describe('ensureOpenspecShim (bundled openspec present)', () => {
    it('execs `node <cli>` instead of npx when a bundled openspec exists', () => {
      // Materialize a fake bundled openspec CLI on disk + point the env at it.
      const root = path.join(home, 'bundle')
      const cli = path.join(root, 'node_modules', '@fission-ai', 'openspec', 'bin', 'openspec.js')
      rmSync(root, { recursive: true, force: true })
      require('fs').mkdirSync(path.dirname(cli), { recursive: true })
      require('fs').writeFileSync(cli, '// fake')
      process.env.SPECRAILS_BUNDLED_OPENSPEC_PATH = root

      const dir = ensureOpenspecShim('my-proj', 'job-2', home)!
      const posix = readFileSync(path.join(dir, 'openspec'), 'utf8')
      expect(posix).toContain(`node '${cli}'`)
      expect(posix).not.toContain('npx')
    })
  })

  describe('prependShimToPath', () => {
    const sep = path.delimiter
    it('prepends the shim dir', () => {
      expect(prependShimToPath(`/usr/bin${sep}/bin`, '/shim')).toBe(`/shim${sep}/usr/bin${sep}/bin`)
    })
    it('is a no-op when shimDir is null', () => {
      expect(prependShimToPath('/usr/bin', null)).toBe('/usr/bin')
    })
    it('does not double-prepend when already leading', () => {
      const v = `/shim${sep}/usr/bin`
      expect(prependShimToPath(v, '/shim')).toBe(v)
    })
    it('handles an undefined PATH', () => {
      expect(prependShimToPath(undefined, '/shim')).toBe('/shim')
    })
  })

  describe('removeOpenspecShim', () => {
    it('removes the shim dir', () => {
      const dir = ensureOpenspecShim('my-proj', 'job-1', home)!
      expect(existsSync(dir)).toBe(true)
      removeOpenspecShim('my-proj', 'job-1', home)
      expect(existsSync(dir)).toBe(false)
    })
    it('is a no-op when absent', () => {
      expect(() => removeOpenspecShim('nope', 'job-x', home)).not.toThrow()
    })
  })
})
