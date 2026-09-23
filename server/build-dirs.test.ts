import { describe, it, expect } from 'vitest'
import { BUILD_DIRS, isInBuildDir } from './build-dirs'

describe('BUILD_DIRS', () => {
  it('contains the heavy build/dep dirs', () => {
    for (const d of ['node_modules', 'dist', 'build', 'out', 'coverage', 'target', 'vendor']) {
      expect(BUILD_DIRS.has(d)).toBe(true)
    }
  })
})

describe('isInBuildDir', () => {
  it('flags the Tauri Rust build tree (the fd-leak root cause)', () => {
    expect(isInBuildDir('src-tauri/target/release/bundle/macos/SpecRails')).toBe(true)
    expect(isInBuildDir('src-tauri/target/debug/incremental/x')).toBe(true)
    expect(isInBuildDir('src-tauri\\target\\release\\deps\\foo.rlib')).toBe(true)
  })

  it('flags node_modules / dist / build / out / coverage / vendor at any depth', () => {
    expect(isInBuildDir('node_modules/react/index.js')).toBe(true)
    expect(isInBuildDir('client/dist/assets/app.js')).toBe(true)
    expect(isInBuildDir('build/output')).toBe(true)
    expect(isInBuildDir('packages/a/out/bundle.js')).toBe(true)
    expect(isInBuildDir('coverage/lcov.info')).toBe(true)
    expect(isInBuildDir('vendor/github.com/pkg/x.go')).toBe(true)
  })

  it('flags any dot-directory segment (.git, .next, .turbo, .venv)', () => {
    expect(isInBuildDir('.git/objects/ab/cd')).toBe(true)
    expect(isInBuildDir('app/.next/server/page.js')).toBe(true)
    expect(isInBuildDir('.venv/lib/python')).toBe(true)
  })

  it('does NOT flag ordinary source files', () => {
    expect(isInBuildDir('server/modules/terminals/runtime/terminal-manager.ts')).toBe(false)
    expect(isInBuildDir('client/src/components/BottomPanel.tsx')).toBe(false)
    expect(isInBuildDir('README.md')).toBe(false)
    expect(isInBuildDir('docs/windows.md')).toBe(false)
  })

  it('does NOT false-positive on substrings (a file named distribute.ts)', () => {
    expect(isInBuildDir('src/distribute.ts')).toBe(false)
    expect(isInBuildDir('src/targeting.ts')).toBe(false)
    expect(isInBuildDir('lib/output-helper.ts')).toBe(false)
  })

  it('ignores empty / dot / dotdot segments', () => {
    expect(isInBuildDir('')).toBe(false)
    expect(isInBuildDir('./server/x.ts')).toBe(false)
    expect(isInBuildDir('a/../b/c.ts')).toBe(false)
  })
})
