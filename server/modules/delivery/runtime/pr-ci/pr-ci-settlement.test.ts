import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultGitRunner } from '../../../../worktree-manager'
import type { Exec } from '../pr-publisher'
import { preservePrCiWip, prCiKeptRef, prCiWipRef, settlePrCiGeneration } from './pr-ci-settlement'

let root: string, work: string
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd: work, encoding: 'utf8' }).trim()
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'pr-ci-settle-')); work = path.join(root, 'work')
  execFileSync('git', ['init', '-q', '-b', 'feature', work])
  writeFileSync(path.join(work, 'a.txt'), 'a\n'); git('add', '.'); git('commit', '-qm', 'pushed')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const view = (over: Record<string, unknown>) => JSON.stringify({ state: 'OPEN', isDraft: true, headRefName: 'feature', baseRefName: 'main', isCrossRepository: false, headRefOid: git('rev-parse', 'HEAD'), mergeCommit: null, commits: [], ...over })
const exec = (stdout: () => string): Exec => ({ run: async () => ({ code: 0, stdout: stdout(), stderr: '' }) })
const unit = { ticketId: 3, branch: 'feature', succeeded: false, implementationOutcome: 'failed' as const, deliveryOutcome: 'not_started' as const, finalSha: 'x', failureCode: 'implementation_failed' as const }
const input = (stdout: () => string, completion: { ok: boolean; reasons: string[] } | null) => ({ git: defaultGitRunner, exec: exec(stdout), baseRepo: work, deliveryId: 'd-ci',
  continuation: { prUrl: 'https://github.com/acme/app/pull/7', branch: 'feature', baseBranch: 'main' }, worktrees: [work], completion, branches: [unit] })

describe('settlePrCiGeneration', () => {
  it('keeps the PR as the deliverable with the CI reason when the loop stops', async () => {
    const head = git('rev-parse', 'HEAD')
    const settled = await settlePrCiGeneration(input(() => view({ isDraft: false }), { ok: false, reasons: ['The remaining failures are not caused by the code (flaky): test X'] }))
    expect(settled).toEqual({ next: 'pr_ready', deliverySha: head, statusCode: 'ci_needs_attention', statusDetail: 'The remaining failures are not caused by the code (flaky): test X', keptRef: null,
      branches: [expect.objectContaining({ succeeded: true, implementationOutcome: 'succeeded', deliveryOutcome: 'ready', finalSha: head, failureCode: null })] })
  })

  it('freezes the ignored-path snapshot of a failed loop once its worktree is clean at the PR head', async () => {
    writeFileSync(path.join(work, '.gitignore'), 'node_modules/\n'); git('add', '.'); git('commit', '-qm', 'ignore')
    execFileSync('mkdir', ['-p', path.join(work, 'node_modules', 'pkg')]); writeFileSync(path.join(work, 'node_modules', 'pkg', 'index.js'), '\n')
    writeFileSync(path.join(work, 'wip.txt'), 'unfinished\n')
    const seen: Array<{ worktree: string; excludes: readonly string[]; dirty: string }> = []
    const capture = async (worktree: string, excludes: readonly string[]) => {
      seen.push({ worktree, excludes, dirty: git('status', '--porcelain') })
      return git('status', '--porcelain', '--ignored=matching').split('\n').filter(line => line.startsWith('!! ')).map(line => line.slice(3).replace(/\/$/, ''))
    }
    const failed = { ...unit, worktreePath: work, overlayExcludes: ['.sr-rail-overlay.json'], settlementIgnoredPaths: null }
    const settled = await settlePrCiGeneration({ ...input(() => view({}), { ok: false, reasons: ['Budget exhausted'] }), branches: [failed], captureIgnoredPaths: capture })
    expect(seen).toEqual([{ worktree: work, excludes: ['.sr-rail-overlay.json'], dirty: '' }])
    expect(settled?.branches[0].settlementIgnoredPaths).toEqual(['node_modules'])
    // A snapshot the ordinary settlement already froze is never replaced.
    seen.length = 0
    const kept = await settlePrCiGeneration({ ...input(() => view({}), { ok: true, reasons: [] }), branches: [{ ...failed, settlementIgnoredPaths: ['dist'] }], captureIgnoredPaths: capture })
    expect(seen).toEqual([])
    expect(kept?.branches[0].settlementIgnoredPaths).toEqual(['dist'])
  })

  it('reports green when Core ended green', async () => {
    expect(await settlePrCiGeneration(input(() => view({}), { ok: true, reasons: ['All checks of the pull request are green.'] }))).toMatchObject({ next: 'pr_draft', statusCode: 'ci_green', statusDetail: null })
  })

  it('moves unverified local commits off the PR branch and keeps them on a delivery ref', async () => {
    const pushed = git('rev-parse', 'HEAD')
    writeFileSync(path.join(work, 'b.txt'), 'unverified\n'); git('add', '.'); git('commit', '-qm', 'unverified')
    const local = git('rev-parse', 'HEAD')
    const settled = await settlePrCiGeneration(input(() => view({ headRefOid: pushed }), { ok: false, reasons: ['Budget exhausted'] }))
    expect(settled).toMatchObject({ deliverySha: pushed, keptRef: prCiKeptRef('d-ci'), statusDetail: expect.stringContaining(prCiKeptRef('d-ci')) })
    expect(git('rev-parse', 'HEAD')).toBe(pushed)
    expect(git('rev-parse', prCiKeptRef('d-ci'))).toBe(local)
  })

  it('sets aside edits a stopped loop never committed, leaving the worktree clean at the PR head', async () => {
    writeFileSync(path.join(work, 'a.txt'), 'edited\n'); writeFileSync(path.join(work, 'new.txt'), 'untracked\n')
    const settled = await settlePrCiGeneration(input(() => view({}), { ok: false, reasons: ['Budget exhausted'] }))
    expect(settled?.statusDetail).toContain(prCiWipRef('d-ci'))
    expect(git('status', '--porcelain')).toBe('')
    expect(git('show', `${prCiWipRef('d-ci')}:a.txt`)).toBe('edited')
    expect(git('show', `${prCiWipRef('d-ci')}^3:new.txt`)).toBe('untracked')
    expect(git('stash', 'list')).toBe('')
    expect(await preservePrCiWip(defaultGitRunner, work, 'd-ci')).toBeNull()
  })

  it('follows a PR someone else moved, keeping local commits the PR does not contain', async () => {
    const base = git('rev-parse', 'HEAD')
    writeFileSync(path.join(work, 'theirs.txt'), 'pushed by someone else\n'); git('add', '.'); git('commit', '-qm', 'theirs')
    const theirs = git('rev-parse', 'HEAD')
    git('reset', '-q', '--hard', base)
    expect(await settlePrCiGeneration(input(() => view({ headRefOid: theirs }), { ok: false, reasons: ['flaky'] }))).toMatchObject({ deliverySha: theirs, keptRef: null })
    expect(git('rev-parse', 'HEAD')).toBe(theirs)
    git('reset', '-q', '--hard', base)
    writeFileSync(path.join(work, 'mine.txt'), 'local only\n'); git('add', '.'); git('commit', '-qm', 'mine')
    const mine = git('rev-parse', 'HEAD')
    expect(await settlePrCiGeneration(input(() => view({ headRefOid: theirs }), { ok: false, reasons: ['flaky'] }))).toMatchObject({ deliverySha: theirs, keptRef: prCiKeptRef('d-ci') })
    expect(git('rev-parse', 'HEAD')).toBe(theirs)
    expect(git('rev-parse', prCiKeptRef('d-ci'))).toBe(mine)
  })

  it('leaves a closed PR, an unreachable PR head or an unverifiable PR to the ordinary settlement', async () => {
    expect(await settlePrCiGeneration(input(() => view({ state: 'CLOSED' }), null))).toBeNull()
    expect(await settlePrCiGeneration(input(() => view({ headRefOid: 'f'.repeat(40) }), null))).toBeNull()
    expect(await settlePrCiGeneration({ ...input(() => '', null), exec: { run: async () => ({ code: 1, stdout: '', stderr: 'gh: offline' }) } })).toBeNull()
  })
})
