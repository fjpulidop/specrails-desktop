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
import { finishMobileRun, mobileRunPid } from '../adapters/mobile-run-process'
import { listBackgroundProcesses } from '../../../transient-children'
import { missionTapflowRoots } from '../runtime'

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
  // The mission's Intent worktree: a copy with the Android app.
  const intent = temp('mobile-start-intent-')
  for (const [file, content] of Object.entries({ ...IOS_APP, ...ANDROID_APP })) write(intent, file, content)
  const runs: Array<Record<string, unknown>> = []
  let finish: () => void = () => {}
  const finished = new Promise<void>((resolve) => { finish = resolve })
  const c = {
    db: initDb(':memory:'),
    desktopDb: initDesktopDb(':memory:'),
    project: { id: 'p1', name: 'Shop', path: repo, db_path: path.join(data, 'jobs.sqlite'), provider: 'claude' },
    loopRunManager: { run: vi.fn(async (input: Record<string, unknown>) => { runs.push(input); await finished; return { runId: input.runId, outcome: 'success' } }) },
    onLoopRunFinished: vi.fn(),
    broadcast: vi.fn(),
    flow: { getByConversation: (id: string) => (id === 'mission-1' ? { id: 'flow-1', state: 'active', step: null, worktreePath: intent } : null) },
  } as unknown as ProjectContext
  c.desktopDb.prepare("INSERT INTO agent_conversations (id, pinned_project_id) VALUES ('mission-1', 'p1'), ('mission-elsewhere', 'p2')").run()
  return { c, repo, data, intent, runs, finish: () => { finish() } }
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

  it('[spec:mobile-device-testing/agent-runs-the-app] runs the mission\'s own Intent worktree and shows the run in its Processes', async () => {
    const { c, intent, runs, finish } = project()
    const started = await startMobileTest(c, { target: { kind: 'mission' }, platforms: ['android'], conversationId: 'mission-1' }, env())
    expect(started).toMatchObject({ ok: true })
    const runId = (started as { runId: string }).runId
    expect(runs[0]).toMatchObject({ cwd: intent, repoDir: intent })
    expect(createMobileRunsStore(c.db).get(runId)).toMatchObject({ targetKind: 'intent', targetPath: intent, conversationId: 'mission-1' })
    const [entry] = listBackgroundProcesses({ projectId: 'p1', chatId: 'mission-1' })
    expect(entry).toMatchObject({ observed: true, status: 'running', flowId: 'flow-1', command: 'Test in Mobile Device · Android · Intent session' })
    expect(c.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'background_process.started', projectId: 'p1' }))
    finish()
    await vi.waitFor(() => expect(listBackgroundProcesses({ projectId: 'p1', chatId: 'mission-1', includeFinished: true })[0]).toMatchObject({ status: 'failed' }))
  })

  it('refuses the mission target without an active Intent, and a mission of another project', async () => {
    const { c, runs } = project()
    c.desktopDb.prepare("INSERT INTO agent_conversations (id, pinned_project_id) VALUES ('mission-2', 'p1')").run()
    expect(await startMobileTest(c, { target: { kind: 'mission' }, platforms: ['ios'], conversationId: 'mission-2' }, env())).toMatchObject({ ok: false, status: 409, code: 'no_intent_session' })
    expect(await startMobileTest(c, { target: { kind: 'mission' }, platforms: ['ios'] }, env())).toMatchObject({ ok: false, code: 'no_intent_session' })
    expect(await startMobileTest(c, { target: { kind: 'checkout' }, platforms: ['ios'], conversationId: 'mission-elsewhere' }, env())).toMatchObject({ ok: false, status: 404, code: 'mission_not_found' })
    expect(runs).toEqual([])
  })

  it('[spec:mobile-device-testing/mission-resources] gives the mission its device, its build in progress and the Tapflow service', async () => {
    const { c, finish } = project()
    const started = await startMobileTest(c, { target: { kind: 'checkout' }, platforms: ['ios'], conversationId: 'mission-1' }, env())
    const runId = (started as { runId: string }).runId
    const UDID = 'D656F70B-FFE8-46C9-83BE-D1FBC13B8779'
    const table = [
      { pid: 100, ppid: 1, command: '/n/node /t/node_modules/tapflow/bin/tapflow.js start' },
      { pid: 200, ppid: 1, command: `launchd_sim /Users/me/Library/Developer/CoreSimulator/Devices/${UDID}/data/var/run/launchd_bootstrap.plist` },
      { pid: 210, ppid: 1, command: 'launchd_sim /Users/me/Library/Developer/CoreSimulator/Devices/AAAAAAAA-0000-0000-0000-000000000000/data/x' },
      { pid: 300, ppid: 1, command: 'xcodebuild build -scheme Shop' },
    ]
    mobileRunPid(runId, 300)
    expect(missionTapflowRoots(c.db, 'mission-1', table).map((root) => [root.kind, root.pid])).toEqual([['mobile-build', 300], ['tapflow-service', 100]])
    // Launched on the iPhone: that simulator (not another one booted) is the mission's.
    createMobileRunsStore(c.db).finish(runId, 'launched', { summary: 'iOS on iPhone 17 Pro', devices: [{ platform: 'ios', id: UDID, name: 'iPhone 17 Pro' }] })
    finishMobileRun(runId, 'exited')
    expect(missionTapflowRoots(c.db, 'mission-1', table).map((root) => [root.kind, root.pid])).toEqual([['mobile-device', 200], ['tapflow-service', 100]])
    expect(missionTapflowRoots(c.db, 'other-mission', table)).toEqual([])
    finish()
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
