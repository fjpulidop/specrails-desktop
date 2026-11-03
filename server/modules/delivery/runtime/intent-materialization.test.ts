import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { defaultGitRunner } from '../../../worktree-manager'
import { parseIntentMarkdown, type SpecIntent } from '../../specs/domain/intent'
import { materializeIntent, newChangeDirectories } from './intent-materialization'

const INTENT: SpecIntent = {
  problem: 'Setup asks for an API key too early.',
  outcome: 'A new user sees a working project first.',
  successSignals: ['Setup under 2 minutes'],
  affects: ['New users'],
  constraints: ['No new dependency'],
  openQuestions: [{ question: 'Offline?' }],
}

let repo: string
let base: string
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
const write = (relative: string, body = 'x\n') => {
  fs.mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true })
  fs.writeFileSync(path.join(repo, relative), body)
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-md-'))
  git('init', '-q')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'user.name', 'Test')
  write('openspec/changes/old-change/proposal.md')
  write('src/a.ts')
  git('add', '-A')
  git('commit', '-qm', 'base')
  base = git('rev-parse', 'HEAD')
})
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }) })

describe('materializeIntent', () => {
  it('writes intent.md into the one active change the run created, and is idempotent', async () => {
    write('openspec/changes/calm-setup/proposal.md')
    write('openspec/changes/calm-setup/tasks.md')
    write('src/b.ts')
    expect(await newChangeDirectories(defaultGitRunner, repo, base)).toEqual(['openspec/changes/calm-setup'])
    const first = await materializeIntent({ git: defaultGitRunner, worktreePath: repo, baseRef: base, intent: INTENT, title: 'Calm setup' })
    expect(first).toEqual({ status: 'written', path: 'openspec/changes/calm-setup/intent.md' })
    const body = fs.readFileSync(path.join(repo, 'openspec/changes/calm-setup/intent.md'), 'utf8')
    expect(body.startsWith('# Intent: Calm setup\n')).toBe(true)
    expect(parseIntentMarkdown(body)).toEqual(INTENT)
    expect(await materializeIntent({ git: defaultGitRunner, worktreePath: repo, baseRef: base, intent: INTENT, title: 'Calm setup' })).toEqual({ status: 'unchanged', path: 'openspec/changes/calm-setup/intent.md' })
  })

  it('writes into the archived change when the run archived it (committed by the run too)', async () => {
    write('openspec/changes/archive/2026-11-01-calm-setup/proposal.md')
    git('add', '-A')
    git('commit', '-qm', 'run archived its change')
    expect(await materializeIntent({ git: defaultGitRunner, worktreePath: repo, baseRef: base, intent: INTENT })).toEqual({ status: 'written', path: 'openspec/changes/archive/2026-11-01-calm-setup/intent.md' })
  })

  it('skips a run without a new change or a project without OpenSpec, and warns on several changes', async () => {
    write('src/c.ts')
    expect(await materializeIntent({ git: defaultGitRunner, worktreePath: repo, baseRef: base, intent: INTENT })).toEqual({ status: 'skipped', reason: 'no_change' })
    write('openspec/changes/one/proposal.md')
    write('openspec/changes/two/proposal.md')
    const several = await materializeIntent({ git: defaultGitRunner, worktreePath: repo, baseRef: base, intent: INTENT })
    expect(several.status).toBe('warning')
    expect(fs.existsSync(path.join(repo, 'openspec/changes/one/intent.md'))).toBe(false)
    fs.rmSync(path.join(repo, 'openspec'), { recursive: true, force: true })
    expect(await materializeIntent({ git: defaultGitRunner, worktreePath: repo, baseRef: base, intent: INTENT })).toEqual({ status: 'skipped', reason: 'no_openspec' })
  })

  it('turns a Git failure into a warning instead of throwing', async () => {
    write('openspec/changes/calm-setup/proposal.md')
    const result = await materializeIntent({ git: defaultGitRunner, worktreePath: repo, baseRef: 'no-such-ref', intent: INTENT })
    expect(result.status).toBe('warning')
  })
})
