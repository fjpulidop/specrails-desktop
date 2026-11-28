import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initDb } from '../../../db'
import { initDesktopDb } from '../../../desktop-db'
import type { ProjectContext } from '../../../project-registry'
import { mobileTestOptions, mobileTestRunView, startMobileTest, type MobileOfferEnv } from '../adapters/mobile-offer'
import { createMobileRunsStore } from '../adapters/mobile-runs-store'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
const temp = (prefix: string) => { const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); dirs.push(dir); return dir }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim()
const write = (root: string, file: string, content: string) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), content) }

const ANDROID_APP = { 'androidApp/settings.gradle.kts': '', 'androidApp/app/build.gradle.kts': 'plugins { id("com.android.application") }' }
const IOS_APP = { 'Shop.xcodeproj/project.pbxproj': 'productType = "com.apple.product-type.application";\nSDKROOT = iphoneos;\n' }

/** A repository whose checkout has an iOS app and whose `android` branch also has an Android one. */
function project() {
  const repo = temp('mobile-start-repo-')
  git(repo, 'init', '-q', '-b', 'main')
  for (const [file, content] of Object.entries(IOS_APP)) write(repo, file, content)
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'ios')
  git(repo, 'checkout', '-qb', 'android')
  for (const [file, content] of Object.entries(ANDROID_APP)) write(repo, file, content)
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'android')
  git(repo, 'checkout', '-q', 'main')
  const data = temp('mobile-start-data-')
  const runs: Array<Record<string, unknown>> = []
  let finish: () => void = () => {}
  const finished = new Promise<void>((resolve) => { finish = resolve })
  const c = {
    db: initDb(':memory:'),
    desktopDb: initDesktopDb(':memory:'),
    project: { id: 'p1', name: 'Shop', path: repo, db_path: path.join(data, 'jobs.sqlite'), provider: 'claude' },
    loopRunManager: { run: vi.fn(async (input: Record<string, unknown>) => { runs.push(input); await finished; return { runId: input.runId, outcome: 'success' } }) },
    onLoopRunFinished: vi.fn(),
  } as unknown as ProjectContext
  return { c, repo, data, runs, finish: () => { finish() } }
}

const env = (over: Partial<MobileOfferEnv> = {}): MobileOfferEnv => ({
  tapflowReady: async () => true,
  capabilities: async () => ({ engineV2: 1, workflowDefinitions: 1, hostTasks: 1 }),
  devices: async () => [{ id: 'avd:tapflow-phone', name: 'tapflow-phone', platform: 'android', booted: false }],
  ...over,
})

describe('starting Test in Mobile Device by hand', () => {
  it('[spec:mobile-device-testing/run-from-loops] runs the checkout as it is, with the chosen device', async () => {
    const { c, repo, runs, finish } = project()
    const started = await startMobileTest(c, { target: { kind: 'checkout' }, platforms: ['ios'], devices: { ios: 'D656F70B-FFE8', android: 'ignored' } }, env())
    expect(started).toMatchObject({ ok: true })
    const runId = (started as { runId: string }).runId
    expect(runs[0]).toMatchObject({ loopId: 'factory:mobile-test', cwd: repo, repoDir: repo, runId })
    expect(createMobileRunsStore(c.db).get(runId)).toMatchObject({ targetKind: 'checkout', targetPath: repo, deliveryId: null, devices: { ios: 'D656F70B-FFE8' } })
    expect(mobileTestRunView(c, runId)).toMatchObject({ state: 'running', platforms: ['ios'], targetKind: 'checkout', devices: [] })
    finish()
  })

  it('[spec:mobile-device-testing/run-from-loops] builds a branch in a temporary worktree and removes it when the run ends', async () => {
    const { c, repo, data, runs, finish } = project()
    const started = await startMobileTest(c, { target: { kind: 'branch', branch: 'android' }, platforms: ['android'] }, env())
    expect(started).toMatchObject({ ok: true })
    const scratch = runs[0]!.cwd as string
    expect(scratch.startsWith(path.join(data, 'mobile-test'))).toBe(true)
    expect(fs.existsSync(path.join(scratch, 'androidApp/app/build.gradle.kts'))).toBe(true)
    // The checkout itself never moved.
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    finish()
    await vi.waitFor(() => expect(fs.existsSync(scratch)).toBe(false))
    expect(git(repo, 'worktree', 'list')).not.toContain(scratch)
  })

  it('refuses what it cannot build: an unknown branch, a platform the code lacks, Tapflow missing, an old Core', async () => {
    const { c, runs, data } = project()
    expect(await startMobileTest(c, { target: { kind: 'branch', branch: 'nope' }, platforms: ['ios'] }, env())).toMatchObject({ ok: false, status: 404, code: 'branch_not_found' })
    expect(await startMobileTest(c, { target: { kind: 'branch', branch: '--upload-pack=x' }, platforms: ['ios'] }, env())).toMatchObject({ ok: false, code: 'branch_not_found' })
    expect(await startMobileTest(c, { target: { kind: 'checkout' }, platforms: ['android'] }, env())).toMatchObject({ ok: false, status: 409, code: 'no_app' })
    // A branch without the app leaves no worktree behind.
    expect(await startMobileTest(c, { target: { kind: 'branch', branch: 'main' }, platforms: ['android'] }, env())).toMatchObject({ ok: false, code: 'no_app' })
    expect(fs.readdirSync(path.join(data, 'mobile-test'))).toEqual([])
    expect(await startMobileTest(c, { target: { kind: 'checkout' }, platforms: ['ios'] }, env({ tapflowReady: async () => false }))).toMatchObject({ ok: false, code: 'tapflow_not_installed' })
    expect(await startMobileTest(c, { target: { kind: 'checkout' }, platforms: ['ios'] }, env({ capabilities: async () => ({ engineV2: 1 }) }))).toMatchObject({ ok: false, code: 'engine_unsupported' })
    expect(await startMobileTest(c, { target: { kind: 'delivery', deliveryId: 'ghost' }, platforms: ['ios'] }, env())).toMatchObject({ ok: false, status: 404 })
    expect(runs).toEqual([])
  })

  it('offers the checkout apps, the current branch, local branches and Tapflow devices', async () => {
    const { c } = project()
    const options = await mobileTestOptions(c, env())
    expect(options).toMatchObject({ ready: true, hostTasks: true, checkout: { branch: 'main', platforms: ['ios'], recommended: 'ios' }, deliveries: [] })
    expect(options.branches.sort()).toEqual(['android', 'main'])
    expect(options.devices).toEqual([{ id: 'avd:tapflow-phone', name: 'tapflow-phone', platform: 'android', booted: false }])
    // Tapflow off: no device list, the run lets Tapflow pick.
    expect((await mobileTestOptions(c, env({ tapflowReady: async () => false }))).devices).toBeNull()
  })
})
