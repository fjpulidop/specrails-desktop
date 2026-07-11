import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import express, { Router, type Request } from 'express'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { getProjectGitInfo, checkoutProjectBranch, checkoutProjectReviewBranch, inspectProjectCheckoutCleanliness, parseWorktreePorcelain, compactCheckoutError } from './project-git'
import { registerGitRoutes } from './project-router-git'
import type { ProjectRoutesDeps } from './project-router-helpers'

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@test.local',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@test.local',
  GIT_CONFIG_NOSYSTEM: '1',
}

function run(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'pipe' })
}

let repo: string
let plainDir: string

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-git-'))
  plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-plain-'))
  run(repo, 'init', '--initial-branch=main')
  fs.writeFileSync(path.join(repo, 'file.txt'), 'a\n')
  run(repo, 'add', '.')
  run(repo, 'commit', '-m', 'first commit')
  run(repo, 'checkout', '-b', 'feature')
  fs.writeFileSync(path.join(repo, 'file.txt'), 'b\n')
  run(repo, 'commit', '-am', 'feature commit')
  run(repo, 'checkout', 'main')
})

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true })
  fs.rmSync(plainDir, { recursive: true, force: true })
})

describe('project-git', () => {
  it('reports git:false outside a work tree', async () => {
    const info = await getProjectGitInfo(plainDir)
    expect(info.git).toBe(false)
    expect(info.branches).toEqual([])
  })

  it('reads branch, local branches and last commit', async () => {
    const info = await getProjectGitInfo(repo)
    expect(info.git).toBe(true)
    expect(info.branch).toBe('main')
    expect(info.detached).toBe(false)
    expect(info.dirty).toBe(false)
    expect(info.branches.sort()).toEqual(['feature', 'main'])
    expect(info.lastCommit?.subject).toBe('first commit')
    expect(info.lastCommit?.hash).toMatch(/^[0-9a-f]{7,}$/)
  })

  it('flags a dirty working tree', async () => {
    fs.writeFileSync(path.join(repo, 'file.txt'), 'dirty\n')
    expect((await getProjectGitInfo(repo)).dirty).toBe(true)
    run(repo, 'checkout', '--', 'file.txt')
    expect((await getProjectGitInfo(repo)).dirty).toBe(false)
  })

  it('reports checkout cleanliness as tri-state and fails closed when status is unreadable', async () => {
    await expect(inspectProjectCheckoutCleanliness(repo)).resolves.toEqual({ ok: true, clean: true })
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'valuable\n')
    await expect(inspectProjectCheckoutCleanliness(repo)).resolves.toEqual({ ok: true, clean: false })
    fs.rmSync(path.join(repo, 'untracked.txt'))
    await expect(inspectProjectCheckoutCleanliness(plainDir)).resolves.toMatchObject({ ok: false })
  })

  it('checks out an existing local branch', async () => {
    const r = await checkoutProjectBranch(repo, 'feature')
    expect(r).toEqual({ ok: true })
    const info = await getProjectGitInfo(repo)
    expect(info.branch).toBe('feature')
    expect(info.lastCommit?.subject).toBe('feature commit')
    run(repo, 'checkout', 'main')
  })

  it('rejects a branch not in the local list (no flag smuggling)', async () => {
    for (const bad of ['nope', '--force', '-b evil', 'origin/main']) {
      const r = await checkoutProjectBranch(repo, bad)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain('Unknown local branch')
    }
    expect((await getProjectGitInfo(repo)).branch).toBe('main')
  })

  it('REFUSES a checkout that would overwrite uncommitted changes — repo untouched', async () => {
    fs.writeFileSync(path.join(repo, 'file.txt'), 'precious uncommitted work\n')
    const r = await checkoutProjectBranch(repo, 'feature')
    expect(r.ok).toBe(false)
    // Still on main, the uncommitted content survived.
    const info = await getProjectGitInfo(repo)
    expect(info.branch).toBe('main')
    expect(fs.readFileSync(path.join(repo, 'file.txt'), 'utf-8')).toContain('precious')
    run(repo, 'checkout', '--', 'file.txt')
  })

  it('checkoutProjectReviewBranch checks out a local PR branch and refuses dirty work', async () => {
    fs.writeFileSync(path.join(repo, 'file.txt'), 'dirty\n')
    const dirty = await checkoutProjectReviewBranch(repo, 'feature')
    expect(dirty.ok).toBe(false)
    if (!dirty.ok) expect(dirty.error).toContain('uncommitted changes')
    run(repo, 'checkout', '--', 'file.txt')

    const ok = await checkoutProjectReviewBranch(repo, 'feature')
    expect(ok).toEqual({ ok: true })
    expect((await getProjectGitInfo(repo)).branch).toBe('feature')
    run(repo, 'checkout', 'main')
  })

  it('reports an unborn fresh repo as git:true with no commits', async () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-fresh-'))
    try {
      run(fresh, 'init', '--initial-branch=main')
      const info = await getProjectGitInfo(fresh)
      expect(info.git).toBe(true)
      expect(info.branch).toBe('main')
      expect(info.lastCommit).toBeNull()
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true })
    }
  })

  it('compacts the many-files checkout refusal into a toast-sized message', () => {
    const raw = [
      'error: Your local changes to the following files would be overwritten by checkout:',
      ...Array.from({ length: 44 }, (_, i) => `\tclient/src/file-${i}.tsx`),
      'Please commit your changes or stash them before you switch branches.',
      'Aborting',
    ].join('\n')
    const compact = compactCheckoutError(raw)
    expect(compact).toContain('44 files')
    expect(compact).toContain('file-0.tsx')
    expect(compact).toContain('+41 more')
    expect(compact.length).toBeLessThan(300)
    // Unrelated errors pass through (capped).
    expect(compactCheckoutError('fatal: reference is not a tree')).toBe('fatal: reference is not a tree')
  })

  it('parses `git worktree list --porcelain` blocks', () => {
    const out = [
      'worktree /repo',
      'HEAD aaaa111',
      'branch refs/heads/main',
      '',
      'worktree /repo/.claude/worktrees/ticket-7',
      'HEAD bbbb222',
      'branch refs/heads/sr/ticket-7',
      '',
      'worktree /repo/.claude/worktrees/probe',
      'HEAD cccc333',
      'detached',
    ].join('\n')
    expect(parseWorktreePorcelain(out)).toEqual([
      { path: '/repo', branch: 'main', head: 'aaaa111', isMain: true },
      { path: '/repo/.claude/worktrees/ticket-7', branch: 'sr/ticket-7', head: 'bbbb222', isMain: false },
      { path: '/repo/.claude/worktrees/probe', branch: null, head: 'cccc333', isMain: false },
    ])
  })

  it('surfaces linked worktrees in the info payload', async () => {
    const wtPath = path.join(os.tmpdir(), `sr-wt-${process.pid}`)
    run(repo, 'worktree', 'add', wtPath, 'feature')
    try {
      const info = await getProjectGitInfo(repo)
      expect(info.worktrees.length).toBe(2)
      expect(info.worktrees[0].isMain).toBe(true)
      const linked = info.worktrees[1]
      expect(linked.branch).toBe('feature')
      expect(fs.realpathSync(linked.path)).toBe(fs.realpathSync(wtPath))
    } finally {
      run(repo, 'worktree', 'remove', '--force', wtPath)
    }
  })

  it('reports a detached HEAD', async () => {
    const hash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, env: GIT_ENV }).toString().trim()
    run(repo, 'checkout', hash)
    const info = await getProjectGitInfo(repo)
    expect(info.detached).toBe(true)
    expect(info.branch).toBeNull()
    run(repo, 'checkout', 'main')
  })
})

describe('git routes', () => {
  function makeApp(repoDir: string, exec?: ProjectRoutesDeps['exec']) {
    const app = express()
    app.use(express.json())
    const router = Router()
    registerGitRoutes({
      router,
      ctx: () => ({ project: { path: repoDir } }),
      exec,
      registry: {},
      ticketPath: () => '',
    } as unknown as ProjectRoutesDeps)
    // Same mount shape as index.ts: the ROUTER paths carry the :projectId
    // prefix (this exact mismatch once shipped /api/projects/git by accident).
    app.use('/api/projects', router)
    return app
  }

  async function req(app: express.Express, method: string, p: string, body?: unknown) {
    const server = app.listen(0)
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    try {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      return { status: res.status, body: await res.json() }
    } finally {
      server.close()
    }
  }

  it('GET /git returns the info payload', async () => {
    const r = await req(makeApp(repo), 'GET', '/api/projects/p1/git')
    expect(r.status).toBe(200)
    expect(r.body.git).toBe(true)
    expect(r.body.branch).toBe('main')
  })

  it('POST /git/checkout: 400 without branch, 409 unknown branch, 200 switching', async () => {
    const app = makeApp(repo)
    expect((await req(app, 'POST', '/api/projects/p1/git/checkout', {})).status).toBe(400)
    const unknown = await req(app, 'POST', '/api/projects/p1/git/checkout', { branch: 'ghost' })
    expect(unknown.status).toBe(409)
    expect(unknown.body.error).toContain('Unknown local branch')
    const ok = await req(app, 'POST', '/api/projects/p1/git/checkout', { branch: 'feature' })
    expect(ok.status).toBe(200)
    expect(ok.body.branch).toBe('feature')
    await req(app, 'POST', '/api/projects/p1/git/checkout', { branch: 'main' })
  })

  it('GET /git/pull-requests/:number resolves a bare PR number through gh', async () => {
    const exec = {
      run: vi.fn(async () => ({
        code: 0,
        stdout: JSON.stringify({ url: 'https://github.com/o/r/pull/515' }),
        stderr: '',
      })),
    }
    const r = await req(makeApp(repo, exec), 'GET', '/api/projects/p1/git/pull-requests/515')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ prNumber: 515, url: 'https://github.com/o/r/pull/515' })
    expect(exec.run).toHaveBeenCalledWith('gh', ['pr', 'view', '515', '--json', 'url'], repo)
  })

  it('GET /git/pull-requests/:number returns 404 when gh cannot resolve it', async () => {
    const exec = { run: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'not found' })) }
    const r = await req(makeApp(repo, exec), 'GET', '/api/projects/p1/git/pull-requests/999')
    expect(r.status).toBe(404)
    expect(r.body.error).toBe('pull_request_not_found')
  })
})
