import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLoopExecutors } from './loop-executors'

describe('loop progress fingerprint with a real Git repository', () => {
  let repo: string
  const fingerprint = (dir: string) => createLoopExecutors().repoStateHash!(dir)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'specrails-loop-state-'))
    git('init')
    git('config', 'user.name', 'Loop test')
    git('config', 'user.email', 'loop@example.test')
    writeFileSync(join(repo, 'source.ts'), 'export const value = 0\n')
    git('add', '.')
    git('commit', '-m', 'base')
  })
  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('recognizes successive repairs to the same tracked file as progress', () => {
    writeFileSync(join(repo, 'source.ts'), 'export const value = 1\n')
    const first = fingerprint(repo)
    expect(first).not.toBeNull()
    expect(fingerprint(repo)).toBe(first)
    writeFileSync(join(repo, 'source.ts'), 'export const value = 2\n')
    expect(fingerprint(repo)).not.toBe(first)
  })

  it('recognizes edits to an already untracked file', () => {
    writeFileSync(join(repo, 'new file.ts'), 'first attempt')
    const first = fingerprint(repo)
    writeFileSync(join(repo, 'new file.ts'), 'fixed attempt')
    expect(fingerprint(repo)).not.toBe(first)
  })

  it('recognizes index changes even when the final worktree equals HEAD', () => {
    const clean = fingerprint(repo)
    writeFileSync(join(repo, 'source.ts'), 'export const value = 1\n')
    git('add', 'source.ts')
    git('restore', '--source=HEAD', '--worktree', 'source.ts')
    expect(fingerprint(repo)).not.toBe(clean)
  })

  it('hashes a symlink target without following it outside the repository', () => {
    symlinkSync('/a/missing/external/file', join(repo, 'external'))
    expect(fingerprint(repo)).not.toBeNull()
  })
})
