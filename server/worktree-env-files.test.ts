import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { materializeIsolatedWorktree } from './modules/delivery/runtime/isolated-worktree'
import { captureSettlementIgnoredPaths } from './modules/delivery/runtime/rail-isolated-launch-support'
import { commitWorktreeAndVerify, defaultGitRunner } from './worktree-manager'
import { createDiagnosticRedactor } from './modules/diagnostics/adapters/redaction'
import {
  ENV_EXCLUDE_MARKER_BEGIN, MAX_ENV_FILE_BYTES, copiedEnvFilePaths, envFileValues, isCopyableEnvFileName,
  projectEnvFileSecretValues, readEnvFileSecretValues, redactEnvValues, syncWorktreeEnvFiles,
} from './worktree-env-files'

// Real repositories: the person's checkout with gitignored env files, and run worktrees cut from it.
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()
const FAKE_KEY = 'base64:FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0000000000='

let root: string, app: string, savedEnv: Record<string, string | undefined>, runs = 0
function write(file: string, content: string | Buffer) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content) }

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt env files ')))
  savedEnv = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM }
  fs.writeFileSync(path.join(root, 'gitconfig'), '')
  process.env.GIT_CONFIG_GLOBAL = path.join(root, 'gitconfig'); process.env.GIT_CONFIG_NOSYSTEM = '1'
  app = path.join(root, 'app'); fs.mkdirSync(app); git(app, 'init', '-q', '-b', 'main')
  write(path.join(app, '.gitignore'), '.env*\n!.env.example\n!.env.ci\n')
  write(path.join(app, '.env.example'), 'APP_KEY=\n')
  write(path.join(app, '.env.ci'), 'CI=1\n')
  write(path.join(app, 'test.js'), "if (!require('fs').readFileSync('.env', 'utf8').includes('APP_KEY=base64:')) process.exit(1)\n")
  git(app, 'add', '.'); git(app, 'commit', '-qm', 'init')
  // The person's gitignored files.
  write(path.join(app, '.env'), `APP_KEY=${FAKE_KEY}\nAPP_ENV=local\n`)
  write(path.join(app, '.env.local'), 'DB_PASSWORD="fake-local-password"\n')
  write(path.join(app, '.env.testing'), 'DB_DATABASE=testing_database\n')
})
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  fs.rmSync(root, { recursive: true, force: true })
})

async function materialize(copyEnvFiles: boolean | undefined, repoDir = app) {
  runs += 1
  return materializeIsolatedWorktree({
    repoDir, worktreesRoot: path.join(root, 'worktrees', `run-${runs}`), slug: 'app', ticketId: runs, baseRef: 'main',
    branch: `run-${runs}`, branchOwnership: 'created', fresh: true, onDegraded: () => {},
    overlay: { sourceRoot: repoDir, providerDir: '.claude', instructionsFilename: 'CLAUDE.md' },
    ...(copyEnvFiles === undefined ? {} : { copyEnvFiles }),
  })
}
const mode = (file: string) => fs.statSync(file).mode & 0o777

describe('names', () => {
  it('accepts .env and .env.<name>, never the templates', () => {
    for (const name of ['.env', '.env.local', '.env.test', '.env.testing', '.env.production.local']) expect(isCopyableEnvFileName(name)).toBe(true)
    for (const name of ['.env.example', '.env.sample', '.env.template', '.env.example.local', '.envrc', 'env', '.env.', '.env/x', 'x.env']) expect(isCopyableEnvFileName(name)).toBe(false)
  })
})

describe('run worktree materialization', () => {
  it('copies nothing when the setting is off (the default)', async () => {
    for (const setting of [false, undefined]) {
      const run = await materialize(setting)
      expect(run.envFiles).toEqual([])
      expect(fs.readdirSync(run.worktreePath).filter((name) => name.startsWith('.env')).sort()).toEqual(['.env.ci', '.env.example'])
    }
  })

  it('copies the gitignored env files with mode 0600 so the tests that need them pass', async () => {
    const run = await materialize(true)
    expect(run.envFiles.sort()).toEqual(['.env', '.env.local', '.env.testing'])
    expect(run.overlayExcludes).toEqual(expect.arrayContaining(['.env', '.env.local', '.env.testing']))
    for (const name of run.envFiles) {
      expect(fs.readFileSync(path.join(run.worktreePath, name), 'utf8')).toBe(fs.readFileSync(path.join(app, name), 'utf8'))
      expect(mode(path.join(run.worktreePath, name))).toBe(0o600)
    }
    execFileSync(process.execPath, ['test.js'], { cwd: run.worktreePath })
    expect(copiedEnvFilePaths(run.worktreePath).sort()).toEqual(['.env', '.env.local', '.env.testing'])
    // The tracked .env.ci keeps the committed bytes; the example is the checkout's.
    expect(fs.readFileSync(path.join(run.worktreePath, '.env.ci'), 'utf8')).toBe('CI=1\n')
  })

  it('never copies tracked, example, linked, oversized or out-of-repository files', async () => {
    write(path.join(root, 'outside.env'), 'SECRET=outside-the-repository\n')
    fs.symlinkSync(path.join(root, 'outside.env'), path.join(app, '.env.linked'))
    write(path.join(app, '.env.huge'), Buffer.alloc(MAX_ENV_FILE_BYTES + 1, 'a'))
    fs.mkdirSync(path.join(app, '.env.dir'))
    write(path.join(app, 'nested', '.env'), 'NESTED=not-at-the-root\n')
    write(path.join(app, '.env.ci'), 'CI=changed-locally\n') // tracked: never overwritten
    const run = await materialize(true)
    expect(run.envFiles.sort()).toEqual(['.env', '.env.local', '.env.testing'])
    expect(fs.existsSync(path.join(run.worktreePath, '.env.linked'))).toBe(false)
    expect(fs.existsSync(path.join(run.worktreePath, '.env.huge'))).toBe(false)
    expect(fs.existsSync(path.join(run.worktreePath, '.env.dir'))).toBe(false)
    expect(fs.existsSync(path.join(run.worktreePath, 'nested', '.env'))).toBe(false)
    expect(fs.readFileSync(path.join(run.worktreePath, '.env.ci'), 'utf8')).toBe('CI=1\n')
  })

  it('reports each skip with its reason, and never follows a link planted at the destination', async () => {
    fs.symlinkSync(path.join(root, 'nowhere'), path.join(app, '.env.linked'))
    const run = await materialize(false)
    fs.symlinkSync(path.join(root, 'planted'), path.join(run.worktreePath, '.env'))
    const result = await syncWorktreeEnvFiles({ git: defaultGitRunner, repoDir: app, worktreePath: run.worktreePath, enabled: true })
    expect(result.skipped).toEqual(expect.arrayContaining([
      { path: '.env', reason: 'destination-occupied' },
      { path: '.env.ci', reason: 'tracked' },
      { path: '.env.linked', reason: 'symlink' },
    ]))
    expect(fs.existsSync(path.join(root, 'planted'))).toBe(false)
    expect(fs.lstatSync(path.join(run.worktreePath, '.env')).isSymbolicLink()).toBe(true)
  })

  it('never stages, shows or commits the copies', async () => {
    const run = await materialize(true)
    expect(git(run.worktreePath, 'status', '--porcelain', '--untracked-files=all')).toBe('')
    write(path.join(run.worktreePath, 'feature.js'), 'module.exports = 1\n')
    const commit = await commitWorktreeAndVerify(defaultGitRunner, run.worktreePath, 'feature', run.overlayExcludes)
    expect(commit.committed).toBe(true)
    const files = git(run.worktreePath, 'show', '--name-only', '--format=', 'HEAD').split('\n')
    expect(files).toEqual(['feature.js'])
    // Neither the diff a review packet or PR body is built from nor the patch holds a value.
    const diff = git(run.worktreePath, 'diff', `${run.initialSha}..HEAD`)
    expect(diff).not.toContain(FAKE_KEY)
    expect(git(run.worktreePath, 'diff', '--name-only', `${run.initialSha}..HEAD`)).toBe('feature.js')
    // Nor are they the run's own ignored output at settlement.
    expect(await captureSettlementIgnoredPaths(defaultGitRunner, run.worktreePath, [])).toEqual([])
  })

  it('excludes a copy the repository does not ignore through the Specrails block of info/exclude, never .gitignore', async () => {
    const plain = path.join(root, 'plain'); fs.mkdirSync(plain); git(plain, 'init', '-q', '-b', 'main')
    write(path.join(plain, 'a.js'), '1\n'); git(plain, 'add', '.'); git(plain, 'commit', '-qm', 'a')
    write(path.join(plain, '.env'), `APP_KEY=${FAKE_KEY}\n`)
    const run = await materialize(true, plain)
    expect(run.envFiles).toEqual(['.env'])
    expect(fs.existsSync(path.join(run.worktreePath, '.gitignore'))).toBe(false)
    expect(fs.existsSync(path.join(plain, '.gitignore'))).toBe(false)
    const exclude: string = fs.readFileSync(path.join(plain, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude).toContain(`${ENV_EXCLUDE_MARKER_BEGIN}\n/.env\n`)
    expect(git(run.worktreePath, 'status', '--porcelain', '--untracked-files=all')).toBe('')
    // Idempotent across runs: one block, the same single entry.
    await materialize(true, plain)
    const after = fs.readFileSync(path.join(plain, '.git', 'info', 'exclude'), 'utf8')
    expect(after.split(ENV_EXCLUDE_MARKER_BEGIN)).toHaveLength(2)
    expect(after.match(/^\/\.env$/gm)).toEqual(['/.env'])
    // The person's own checkout ignores it too, so it cannot be committed from there either.
    expect(git(plain, 'status', '--porcelain', '--untracked-files=all')).toBe('')
  })

  it('recopies on every materialization and removes stale copies; turning the setting off removes them', async () => {
    const run = await materialize(true)
    write(path.join(app, '.env'), 'APP_KEY=base64:CHANGEDCHANGEDCHANGED=\n')
    fs.rmSync(path.join(app, '.env.local'))
    const again = await syncWorktreeEnvFiles({ git: defaultGitRunner, repoDir: app, worktreePath: run.worktreePath, enabled: true })
    expect(again.copied.sort()).toEqual(['.env', '.env.testing'])
    expect(again.removed).toEqual(['.env.local'])
    expect(fs.readFileSync(path.join(run.worktreePath, '.env'), 'utf8')).toContain('CHANGED')
    const off = await syncWorktreeEnvFiles({ git: defaultGitRunner, repoDir: app, worktreePath: run.worktreePath, enabled: false })
    expect(off.removed.sort()).toEqual(['.env', '.env.testing'])
    expect(copiedEnvFilePaths(run.worktreePath)).toEqual([])
    // The person's checkout is only ever read.
    expect(fs.readFileSync(path.join(app, '.env'), 'utf8')).toContain('CHANGED')
  })

  it('keeps a project subdirectory: env files of a project inside a larger checkout land in the same folder', async () => {
    const mono = path.join(root, 'mono'); fs.mkdirSync(path.join(mono, 'api'), { recursive: true }); git(mono, 'init', '-q', '-b', 'main')
    write(path.join(mono, '.gitignore'), '.env\n'); write(path.join(mono, 'api', 'a.js'), '1\n'); git(mono, 'add', '.'); git(mono, 'commit', '-qm', 'a')
    write(path.join(mono, 'api', '.env'), 'API=api-secret-value\n')
    const run = await materialize(false, mono)
    const result = await syncWorktreeEnvFiles({ git: defaultGitRunner, repoDir: path.join(mono, 'api'), worktreePath: run.worktreePath, enabled: true })
    expect(result.copied).toEqual(['api/.env'])
    expect(fs.readFileSync(path.join(run.worktreePath, 'api', '.env'), 'utf8')).toBe('API=api-secret-value\n')
  })
})

describe('redaction values', () => {
  it('reads the assigned values, dropping quotes, comments and short words', () => {
    expect(envFileValues(`APP_KEY=${FAKE_KEY}\nexport TOKEN='quoted-token-value' # c\nAPP_ENV=local\n# KEY=commented-out-value\nURL=https://example.test/x # tail\n`))
      .toEqual([FAKE_KEY, 'quoted-token-value', 'https://example.test/x'])
  })

  it('redacts every value of the project env files from a text', () => {
    const values = readEnvFileSecretValues([app])
    expect(values).toEqual(expect.arrayContaining([FAKE_KEY, 'fake-local-password', 'testing_database']))
    expect(redactEnvValues(`key ${FAKE_KEY} and fake-local-password`, values)).toBe('key [redacted] and [redacted]')
  })

  it('problem reports redact the values of a project that copies its env files, and only then', () => {
    const project = { id: 'p', path: app }
    const report = `server log: APP_KEY=${FAKE_KEY} db fake-local-password`
    expect(createDiagnosticRedactor(() => projectEnvFileSecretValues(project, true))(report)).not.toMatch(/FAKEFAKE|fake-local-password/)
    expect(projectEnvFileSecretValues(project, false)).toEqual([])
  })
})
