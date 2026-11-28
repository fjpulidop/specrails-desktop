import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initDb } from '../../../db'
import { chooseScheme, createMobileBuilder, type StepRunner } from '../adapters/mobile-build'
import { createMobileTestHandlers } from '../adapters/mobile-handlers'
import { createMobileRunsStore } from '../adapters/mobile-runs-store'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
const tempRepo = (tree: Record<string, string>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-repo-')); dirs.push(root)
  for (const [file, content] of Object.entries(tree)) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), content) }
  return root
}
const IOS = { 'Shop.xcodeproj/project.pbxproj': 'productType = "com.apple.product-type.application";\nSDKROOT = iphoneos;\n' }
const SDK = { sdk: '/sdk', jdk: null }
const ANDROID = { 'settings.gradle.kts': '', 'app/build.gradle.kts': 'plugins { id("com.android.application") }' }

describe('chooseScheme', () => {
  it('prefers the scheme named like the container and skips test and pod schemes', () => {
    expect(chooseScheme(['ShopTests', 'Pods-Shop', 'Shop'], 'Shop.xcworkspace')).toBe('Shop')
    expect(chooseScheme(['Pods-App', 'App Dev', 'AppTests'], 'Shop.xcodeproj')).toBe('App Dev')
    expect(chooseScheme(['ShopTests'], 'Shop.xcodeproj')).toBeNull()
  })
})

describe('mobile builder', () => {
  /** A runner that "builds" by creating the artifact the plan expects. */
  const fakeRunner = (repo: string, artifact: string | null, code = 0): StepRunner & { argv: string[][] } => {
    const argv: string[][] = []
    return { argv, run: async (step) => { argv.push([...step]); if (artifact && code === 0) { fs.mkdirSync(path.dirname(path.join(repo, artifact)), { recursive: true }); fs.mkdirSync(path.join(repo, artifact), { recursive: true }) } return { code, tail: code ? 'error: Build input file cannot be found' : '' } } }
  }

  it('resolves the scheme, builds the iOS app and returns the simulator .app', async () => {
    const repo = tempRepo(IOS)
    const runner = fakeRunner(repo, '.specrails/mobile-build/ios/Build/Products/Debug-iphonesimulator/Shop.app')
    const result = await createMobileBuilder({ runner, schemes: async () => ['ShopTests', 'Shop'] })(repo, ['ios'], () => {})
    expect(result).toEqual({ outcome: 'built', artifacts: [{ platform: 'ios', path: path.join(repo, '.specrails/mobile-build/ios/Build/Products/Debug-iphonesimulator/Shop.app') }] })
    expect(runner.argv[0]).toContain('-scheme')
    expect(runner.argv[0]).toContain('Shop')
  })

  it('reports a failing build with its command and log tail, and a missing artifact', async () => {
    const repo = tempRepo(ANDROID)
    const failed = await createMobileBuilder({ runner: fakeRunner(repo, null, 1), android: () => SDK })(repo, ['android'], () => {})
    expect(failed).toMatchObject({ outcome: 'failed', command: './gradlew :app:assembleDebug', tail: expect.stringContaining('cannot be found') })
    const empty = await createMobileBuilder({ runner: fakeRunner(repo, null, 0), android: () => SDK })(repo, ['android'], () => {})
    expect(empty).toMatchObject({ outcome: 'failed', detail: expect.stringContaining('no .apk') })
  })

  it('gives a Gradle build the SDK and JDK a worktree lacks, and stops early without an SDK', async () => {
    vi.stubEnv('ANDROID_HOME', ''); vi.stubEnv('ANDROID_SDK_ROOT', ''); vi.stubEnv('JAVA_HOME', '')
    try {
      const repo = tempRepo(ANDROID)
      const envs: Array<Record<string, string> | undefined> = []
      const runner: StepRunner = { run: async (step, _cwd, _line, _timeout, env) => { envs.push(env); fs.mkdirSync(path.join(repo, 'app/build/outputs/apk/debug'), { recursive: true }); fs.writeFileSync(path.join(repo, 'app/build/outputs/apk/debug/app-debug.apk'), ''); return { code: 0, tail: '' } } }
      const built = await createMobileBuilder({ runner, android: () => ({ sdk: '/sdk', jdk: '/jdk' }) })(repo, ['android'], () => {})
      expect(built).toMatchObject({ outcome: 'built', artifacts: [{ platform: 'android', path: expect.stringContaining('app-debug.apk') }] })
      expect(envs).toEqual([{ ANDROID_HOME: '/sdk', JAVA_HOME: '/jdk' }])
      const missing = await createMobileBuilder({ runner, android: () => ({ sdk: null, jdk: '/jdk' }) })(repo, ['android'], () => {})
      expect(missing).toMatchObject({ outcome: 'failed', detail: expect.stringContaining('No Android SDK') })
    } finally { vi.unstubAllEnvs() }
  })

  it('says there is nothing to build for a platform the project does not have, and asks to share an unlisted scheme', async () => {
    expect(await createMobileBuilder({ runner: fakeRunner(tempRepo(IOS), null) })(tempRepo(IOS), ['android'], () => {})).toMatchObject({ outcome: 'none' })
    expect(await createMobileBuilder({ runner: fakeRunner(tempRepo(IOS), null), schemes: async () => [] })(tempRepo(IOS), ['ios'], () => {})).toMatchObject({ outcome: 'failed', detail: expect.stringContaining('Shared') })
  })
})

describe('mobile test host tasks', () => {
  const invocation = (runId: string) => ({ projectId: 'p', runId, interruptId: 'i', request: { task: '', input: {}, outcomes: [], effect: 'read' as const, candidate: { hash: null, verified: false } }, signal: new AbortController().signal, log: () => {} })

  function setup(build: ReturnType<typeof vi.fn>, deliver: ReturnType<typeof vi.fn>) {
    const db = initDb(':memory:')
    const store = createMobileRunsStore(db)
    store.create({ runId: 'r1', projectId: 'p', platforms: ['ios', 'android'], targetPath: '/w', targetKind: 'review', deliveryId: 'd1', conversationId: 'c1' })
    const finished: string[] = []
    const handlers = createMobileTestHandlers({ store, build, deliver, onFinished: (runId) => finished.push(runId) })
    return { store, handlers, finished }
  }

  it('builds, then launches each platform and records the devices for the card', async () => {
    const build = vi.fn(async () => ({ outcome: 'built', artifacts: [{ platform: 'ios', path: '/w/Shop.app' }, { platform: 'android', path: '/w/app-debug.apk' }] }))
    const deliver = vi.fn(async ({ platform }: { platform: string }) => ({ outcome: 'launched', device: { id: platform, name: platform === 'ios' ? 'iPhone 17' : 'tapflow-phone', platform }, buildId: 1, sessionId: 's', watchUrl: null }))
    const { store, handlers, finished } = setup(build, deliver)
    expect(await handlers['mobile.build'](invocation('r1'))).toEqual({ outcome: 'built', output: { artifacts: [{ platform: 'ios', file: 'Shop.app' }, { platform: 'android', file: 'app-debug.apk' }] } })
    expect(build).toHaveBeenCalledWith('/w', ['ios', 'android'], expect.any(Function))
    const delivered = await handlers['tapflow.deliver'](invocation('r1'))
    expect(delivered).toMatchObject({ outcome: 'launched', output: { summary: 'iOS on iPhone 17, Android on tapflow-phone' } })
    expect(store.get('r1')).toMatchObject({ state: 'launched' })
    expect(finished).toEqual(['r1'])
  })

  it('ends the run on a build failure with its detail, and on Tapflow being off as unavailable', async () => {
    const failing = setup(vi.fn(async () => ({ outcome: 'failed', detail: 'xcodebuild exited with 65', command: 'xcodebuild …', tail: 'error' })), vi.fn())
    expect(await failing.handlers['mobile.build'](invocation('r1'))).toMatchObject({ outcome: 'error', output: { detail: 'xcodebuild exited with 65', command: 'xcodebuild …' } })
    expect(failing.store.get('r1')).toMatchObject({ state: 'failed', result: { detail: 'xcodebuild exited with 65' } })
    const off = setup(vi.fn(async () => ({ outcome: 'built', artifacts: [{ platform: 'ios', path: '/w/Shop.app' }] })), vi.fn(async () => ({ outcome: 'unavailable', detail: 'Tapflow is off.' })))
    await off.handlers['mobile.build'](invocation('r1'))
    expect(await off.handlers['tapflow.deliver'](invocation('r1'))).toMatchObject({ outcome: 'unavailable', output: { detail: 'iOS: Tapflow is off.' } })
  })

  it('refuses a run that was not started from the offer', async () => {
    const { handlers } = setup(vi.fn(), vi.fn())
    expect(await handlers['mobile.build'](invocation('unknown'))).toMatchObject({ outcome: 'error' })
    expect(await handlers['tapflow.deliver'](invocation('unknown'))).toMatchObject({ outcome: 'error' })
  })
})
