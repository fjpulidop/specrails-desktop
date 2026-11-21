import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLoopExecutors } from './modules/loops/runtime/loop-executors'

describe('loop progress fingerprint with a real Git repository', () => {
  let repo: string
  const fingerprint = (dir: string) => Promise.resolve(createLoopExecutors().repoStateHash!(dir))
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

  it('recognizes successive repairs to the same tracked file as progress', async () => {
    writeFileSync(join(repo, 'source.ts'), 'export const value = 1\n')
    const first = await fingerprint(repo)
    expect(first).not.toBeNull()
    expect(await fingerprint(repo)).toBe(first)
    writeFileSync(join(repo, 'source.ts'), 'export const value = 2\n')
    expect(await fingerprint(repo)).not.toBe(first)
  })

  it('recognizes edits to an already untracked file', async () => {
    writeFileSync(join(repo, 'new file.ts'), 'first attempt')
    const first = await fingerprint(repo)
    writeFileSync(join(repo, 'new file.ts'), 'fixed attempt')
    expect(await fingerprint(repo)).not.toBe(first)
  })

  it('recognizes index changes even when the final worktree equals HEAD', async () => {
    const clean = await fingerprint(repo)
    writeFileSync(join(repo, 'source.ts'), 'export const value = 1\n')
    git('add', 'source.ts')
    git('restore', '--source=HEAD', '--worktree', 'source.ts')
    expect(await fingerprint(repo)).not.toBe(clean)
  })

  it('resolves null outside a repository and when an output exceeds its buffer', async () => {
    const nonRepo = mkdtempSync(join(tmpdir(), 'specrails-loop-norepo-'))
    try {
      expect(await createLoopExecutors().repoStateHash!(nonRepo)).toBeNull()
    } finally {
      rmSync(nonRepo, { recursive: true, force: true })
    }
    // `git status` output over the 1 MiB default buffer fails the sample
    // (the former execFileSync threw ENOBUFS) instead of hashing a prefix.
    const longName = 'x'.repeat(200)
    for (let i = 0; i < 7_000; i++) writeFileSync(join(repo, `${longName}-${i}.txt`), '')
    expect(await fingerprint(repo)).toBeNull()
  })

  it('hashes a symlink target without following it outside the repository', async () => {
    symlinkSync('/a/missing/external/file', join(repo, 'external'))
    expect(await fingerprint(repo)).not.toBeNull()
  })
})
