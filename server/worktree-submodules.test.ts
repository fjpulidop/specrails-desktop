import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { materializeIsolatedWorktree } from './modules/delivery/runtime/isolated-worktree'
import { createWorktree, defaultGitRunner, initializeWorktreeSubmodules, removeWorktree, SubmoduleUnavailableError } from './worktree-manager'

// Real repositories: an app whose test imports from a submodule (which itself has a
// nested submodule), cloned and initialized the way a person's checkout is.
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()
const fileGit = (cwd: string, ...args: string[]) => git(cwd, '-c', 'protocol.file.allow=always', ...args)

let root: string, app: string, savedEnv: Record<string, string | undefined>
function write(file: string, content: string) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content) }

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt submodules ')))
  // The code under test runs the real Git runner: isolate it from the host's Git config.
  savedEnv = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM }
  fs.writeFileSync(path.join(root, 'gitconfig'), '')
  process.env.GIT_CONFIG_GLOBAL = path.join(root, 'gitconfig'); process.env.GIT_CONFIG_NOSYSTEM = '1'
  const deep = path.join(root, 'deep-origin'), lib = path.join(root, 'lib-origin')
  fs.mkdirSync(deep); git(deep, 'init', '-q', '-b', 'main')
  write(path.join(deep, 'value.js'), 'module.exports = 41\n'); git(deep, 'add', '.'); git(deep, 'commit', '-qm', 'deep')
  fs.mkdirSync(lib); git(lib, 'init', '-q', '-b', 'main')
  write(path.join(lib, 'index.js'), "module.exports = () => require('./deep/value.js') + 1\n")
  fileGit(lib, 'submodule', 'add', '-q', deep, 'deep'); git(lib, 'add', '.'); git(lib, 'commit', '-qm', 'lib')
  app = path.join(root, 'app'); fs.mkdirSync(app); git(app, 'init', '-q', '-b', 'main')
  write(path.join(app, 'test.js'), "if (require('./libs/lib/index.js')() !== 42) process.exit(1)\n")
  git(app, 'add', '.'); git(app, 'commit', '-qm', 'init')
  fileGit(app, 'submodule', 'add', '-q', lib, 'libs/lib'); fileGit(app, 'submodule', 'update', '--init', '--recursive', '-q'); git(app, 'commit', '-qm', 'submodule')
})
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  fs.rmSync(root, { recursive: true, force: true })
})

const offline = () => { for (const origin of ['lib-origin', 'deep-origin']) fs.renameSync(path.join(root, origin), path.join(root, `${origin}-gone`)) }
const runTests = (dir: string) => execFileSync(process.execPath, ['test.js'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' })
async function runCheckout(ticketId = 1) {
  return createWorktree(defaultGitRunner, { repoDir: app, worktreesRoot: path.join(root, 'worktrees'), slug: 'app', ticketId, branch: `run-${ticketId}`, baseRef: 'main' })
}

describe('initializeWorktreeSubmodules', () => {
  it('populates nested submodules from the local checkout without network or config writes, so baseline tests pass', async () => {
    offline()
    const config = fs.readFileSync(path.join(app, '.git/config'), 'utf8')
    const { worktreePath } = await runCheckout()
    // What `git worktree add` alone leaves: an empty submodule directory, failing tests.
    expect(fs.readdirSync(path.join(worktreePath, 'libs/lib'))).toEqual([])
    expect(() => runTests(worktreePath)).toThrow()
    await initializeWorktreeSubmodules(defaultGitRunner, app, worktreePath)
    expect(runTests(worktreePath)).toBe('')
    expect(git(path.join(worktreePath, 'libs/lib'), 'rev-parse', 'HEAD')).toBe(git(app, 'rev-parse', 'HEAD:libs/lib'))
    expect(fs.readFileSync(path.join(app, '.git/config'), 'utf8')).toBe(config)
    // The clones are this worktree's own; the person's module store is untouched.
    expect(fs.readFileSync(path.join(worktreePath, 'libs/lib/.git'), 'utf8')).toContain('/worktrees/')
    expect(git(worktreePath, 'status', '--porcelain', '--ignore-submodules=none')).toBe('')
  })

  it('falls back to the submodule URL when the local copy lacks the recorded commit', async () => {
    const lib = path.join(root, 'lib-origin')
    write(path.join(lib, 'index.js'), "module.exports = () => require('./deep/value.js') + 1 // v2\n"); git(lib, 'commit', '-qam', 'v2')
    const v2 = git(lib, 'rev-parse', 'HEAD')
    // Record v2 without fetching it into the person's module store.
    git(app, 'update-index', '--cacheinfo', `160000,${v2},libs/lib`); git(app, 'commit', '-qm', 'bump lib')
    // A local-path remote needs the person's own (global) file-transport opt-in, as with plain Git.
    fs.writeFileSync(path.join(root, 'gitconfig'), '[protocol "file"]\n\tallow = always\n')
    const { worktreePath } = await runCheckout()
    await initializeWorktreeSubmodules(defaultGitRunner, app, worktreePath)
    expect(git(path.join(worktreePath, 'libs/lib'), 'rev-parse', 'HEAD')).toBe(v2)
    expect(runTests(worktreePath)).toBe('')
  })

  it('fails with a precise environment message when a submodule cannot be fetched from anywhere', async () => {
    const lib = path.join(root, 'lib-origin')
    write(path.join(lib, 'index.js'), 'module.exports = () => 0\n'); git(lib, 'commit', '-qam', 'unfetched')
    git(app, 'update-index', '--cacheinfo', `160000,${git(lib, 'rev-parse', 'HEAD')},libs/lib`); git(app, 'commit', '-qm', 'bump lib')
    offline()
    const config = fs.readFileSync(path.join(app, '.git/config'), 'utf8')
    const { worktreePath } = await runCheckout()
    const failure = await initializeWorktreeSubmodules(defaultGitRunner, app, worktreePath).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SubmoduleUnavailableError)
    expect((failure as SubmoduleUnavailableError).submodulePath).toBe('libs/lib')
    expect((failure as Error).message).toMatch(/^submodule_unavailable: The run checkout needs submodule libs\/lib at [0-9a-f]{12}, but it could not be populated from the local copy .+ or its URL .+lib-origin: .+\. Run "git submodule update --init --recursive" in .+app/)
    expect(fs.readFileSync(path.join(app, '.git/config'), 'utf8')).toBe(config)
  })

  it('leaves a submodule this checkout already populated exactly where the run moved it', async () => {
    offline()
    const { worktreePath } = await runCheckout()
    await initializeWorktreeSubmodules(defaultGitRunner, app, worktreePath)
    const sub = path.join(worktreePath, 'libs/lib')
    write(path.join(sub, 'extra.js'), 'x'); git(sub, 'add', '.'); git(sub, 'commit', '-qm', 'agent work')
    const moved = git(sub, 'rev-parse', 'HEAD')
    await initializeWorktreeSubmodules(defaultGitRunner, app, worktreePath)
    expect(git(sub, 'rev-parse', 'HEAD')).toBe(moved)
  })

  it('does nothing for a repository without submodules', async () => {
    const plain = path.join(root, 'plain'); fs.mkdirSync(plain); git(plain, 'init', '-q', '-b', 'main')
    write(path.join(plain, 'a'), 'a'); git(plain, 'add', '.'); git(plain, 'commit', '-qm', 'a')
    const calls: string[][] = []
    await initializeWorktreeSubmodules({ run: async (args, cwd) => { calls.push(args); return defaultGitRunner.run(args, cwd) } }, plain, plain)
    expect(calls).toEqual([['rev-parse', '--path-format=absolute', '--git-common-dir']])
  })
})

describe('removeWorktree with populated submodules', () => {
  it('keeps the non-force guard: removes a clean checkout and refuses one whose submodule changed', async () => {
    offline()
    const clean = await runCheckout(1)
    await initializeWorktreeSubmodules(defaultGitRunner, app, clean.worktreePath)
    await removeWorktree(defaultGitRunner, { repoDir: app, worktreePath: clean.worktreePath, branch: clean.branch, deleteBranch: false, force: false })
    expect(fs.existsSync(clean.worktreePath)).toBe(false)

    const dirty = await runCheckout(2)
    await initializeWorktreeSubmodules(defaultGitRunner, app, dirty.worktreePath)
    write(path.join(dirty.worktreePath, 'libs/lib/deep/value.js'), 'module.exports = 0\n')
    await expect(removeWorktree(defaultGitRunner, { repoDir: app, worktreePath: dirty.worktreePath, branch: dirty.branch, deleteBranch: false, force: false }))
      .rejects.toThrow(/modified or untracked files.*libs\/lib/)
    expect(fs.existsSync(path.join(dirty.worktreePath, 'libs/lib/deep/value.js'))).toBe(true)
  })
})

describe('run checkout materialization', () => {
  it('populates submodules by default with the real Git runner, so the baseline passes in the run checkout', async () => {
    offline()
    const prepared = await materializeIsolatedWorktree({
      repoDir: app, worktreesRoot: path.join(root, 'worktrees', 'run-a'), slug: 'app', ticketId: 9, baseRef: 'main',
      branch: 'run-9', branchOwnership: 'created', fresh: true, onDegraded: () => {},
      overlay: { sourceRoot: app, providerDir: '.claude', instructionsFilename: 'CLAUDE.md' },
    })
    expect(runTests(prepared.worktreePath)).toBe('')
    expect(prepared.initialSha).toBe(git(app, 'rev-parse', 'main'))
  })
})
