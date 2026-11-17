import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDb } from '../../../db'
import { createLoopRun } from '../../loops/runtime/loop-runs-store'
import { defaultGitRunner } from '../../../worktree-manager'
import { definitionForkChain, forkSuccessorChangeName, retireSupersededForkChanges } from './fork-change-supersession'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function repository(): { root: string; base: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fork-supersession-'))
  roots.push(root)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test')
  change(root, 'baseline-change')
  git('add', '-A'); git('commit', '-q', '-m', 'base')
  return { root, base: git('rev-parse', 'HEAD') }
}
function change(root: string, name: string, archived = false): string {
  const directory = path.join(root, 'openspec', 'changes', ...(archived ? ['archive', `2026-11-13-${name}`] : [name]))
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, 'proposal.md'), name)
  return directory
}
const exists = (root: string, name: string) => existsSync(path.join(root, 'openspec', 'changes', name))

describe('fork change supersession', () => {
  it('mirrors the Core fork change name (runtime-158a… → …-fork-9981a5d68f5f)', () => {
    expect(forkSuccessorChangeName('runtime-158a339bcb274a3f52f3', 'fork-bac65c888b9ac4cf0389f01f526db3b9'))
      .toBe('runtime-158a339bcb274a3f52f3-fork-9981a5d68f5f')
    expect(forkSuccessorChangeName('a'.repeat(41) + '-tail', 'fork-x')).toMatch(new RegExp(`^${'a'.repeat(41)}-fork-[a-f0-9]{12}$`))
  })

  it('retires the source change a fork archived under its own name and keeps everything else', async () => {
    const { root, base } = repository()
    const fork = 'fork-bac65c888b9ac4cf0389f01f526db3b9'
    change(root, 'runtime-158a339bcb274a3f52f3')
    change(root, forkSuccessorChangeName('runtime-158a339bcb274a3f52f3', fork), true)
    change(root, 'unrelated-new-change')
    const retired = await retireSupersededForkChanges({ git: defaultGitRunner, worktreePath: root, baseRef: base, forkRunIds: [fork] })
    expect(retired).toEqual(['runtime-158a339bcb274a3f52f3'])
    expect(exists(root, 'runtime-158a339bcb274a3f52f3')).toBe(false)
    expect(exists(root, 'unrelated-new-change')).toBe(true)
    expect(exists(root, 'baseline-change')).toBe(true)
  })

  it('retires every superseded change of a fork-of-a-fork chain, including an active successor', async () => {
    const { root, base } = repository()
    const first = forkSuccessorChangeName('feature', 'fork-a'), second = forkSuccessorChangeName(first, 'fork-b')
    change(root, 'feature'); change(root, first); change(root, second)
    const retired = await retireSupersededForkChanges({ git: defaultGitRunner, worktreePath: root, baseRef: base, forkRunIds: ['fork-b', 'fork-a'] })
    expect(retired.sort()).toEqual(['feature', first].sort())
    expect(exists(root, second)).toBe(true)
  })

  it('never retires the change the settled run is using, even when truncated fork names collide (fork-dddf836f)', async () => {
    const { root, base } = repository()
    // The real lineage: ef2f929a → fork-44d9 → fork-ee78 → fork-dddf. After the
    // 42-character truncation both later changes share one prefix, so each is
    // the other's "successor" under some run of the chain.
    const chain = ['fork-dddf836fb5ca7d250c6fcf6211f2ed98', 'fork-ee78a538295e69b85d71c78c4e23bfdb', 'fork-44d95bbcd74cbe6225696bde5254358a']
    const first = forkSuccessorChangeName('runtime-842b43104eaf2d0e2d41', chain[2])
    const previous = forkSuccessorChangeName(first, chain[1])
    const current = forkSuccessorChangeName(previous, chain[0])
    expect(previous).toBe('runtime-842b43104eaf2d0e2d41-fork-b0e8f0ed-fork-71382de94d95')
    expect(forkSuccessorChangeName(current, chain[1])).toBe(previous)
    change(root, previous); writeFileSync(path.join(change(root, current), 'tasks.md'), '- [x] 1.1 done')
    const retired = await retireSupersededForkChanges({ git: defaultGitRunner, worktreePath: root, baseRef: base, forkRunIds: chain })
    expect(retired).toEqual([previous])
    expect(exists(root, current)).toBe(true)
    expect(readFileSync(path.join(root, 'openspec', 'changes', current, 'tasks.md'), 'utf8')).toBe('- [x] 1.1 done')
  })

  it('moves a retired change into the git directory instead of deleting it', async () => {
    const { root, base } = repository()
    const fork = 'fork-bac65c888b9ac4cf0389f01f526db3b9'
    change(root, 'runtime-158a339bcb274a3f52f3')
    change(root, forkSuccessorChangeName('runtime-158a339bcb274a3f52f3', fork), true)
    await retireSupersededForkChanges({ git: defaultGitRunner, worktreePath: root, baseRef: base, forkRunIds: [fork] })
    const backups = path.join(root, '.git', 'specrails', 'retired-openspec-changes')
    const [stamp] = readdirSync(backups)
    expect(readFileSync(path.join(backups, stamp, 'runtime-158a339bcb274a3f52f3', 'proposal.md'), 'utf8')).toBe('runtime-158a339bcb274a3f52f3')
    expect(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' })).not.toContain('retired-openspec-changes')
  })

  it('never touches baseline changes, symlinks, changes without a successor or non-fork runs', async () => {
    const { root, base } = repository()
    change(root, forkSuccessorChangeName('baseline-change', 'fork-a'), true)
    change(root, 'orphan')
    const outside = mkdtempSync(path.join(os.tmpdir(), 'fork-supersession-outside-')); roots.push(outside)
    symlinkSync(outside, path.join(root, 'openspec', 'changes', 'linked'))
    change(root, forkSuccessorChangeName('linked', 'fork-a'), true)
    expect(await retireSupersededForkChanges({ git: defaultGitRunner, worktreePath: root, baseRef: base, forkRunIds: ['fork-a'] })).toEqual([])
    expect(await retireSupersededForkChanges({ git: defaultGitRunner, worktreePath: root, baseRef: base, forkRunIds: [] })).toEqual([])
    expect(exists(root, 'baseline-change') && exists(root, 'orphan') && exists(root, 'linked')).toBe(true)
  })

  it('walks the fork chain nearest first and stops at the original run', () => {
    const db = initDb(':memory:')
    for (const id of ['root', 'child', 'grandchild']) createLoopRun(db, { id, projectId: 'p', loopId: 'l', loopName: 'L', railIndex: 0, ticketId: null, iterationLimit: 1, startedAt: new Date().toISOString() } as never)
    db.prepare('UPDATE loop_runs SET fork_of = ? WHERE id = ?').run('root', 'child')
    db.prepare('UPDATE loop_runs SET fork_of = ? WHERE id = ?').run('child', 'grandchild')
    expect(definitionForkChain(db, 'grandchild')).toEqual(['grandchild', 'child'])
    expect(definitionForkChain(db, 'root')).toEqual([])
  })
})
