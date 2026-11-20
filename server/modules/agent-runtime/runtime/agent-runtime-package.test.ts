import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { retainAgentRuntime, resolveRetainedAgentRuntime, resolveRetainedAgentRuntimeForInspection, forgetRetainedPackageVerifications, runtimeEntryFingerprint, RETAINED_PACKAGE_VERIFY_TTL_MS } from './agent-runtime-package'

let root: string
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'runtime pin '))) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); forgetRetainedPackageVerifications(); vi.useRealTimers() })
function file(relative: string, contents: string): string {
  const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, contents); return target
}
function fixture() {
  file('active/package.json', JSON.stringify({ name: 'specrails-core', version: '5.3.0', dependencies: { fixture: '1' } }))
  file('active/node_modules/fixture/package.json', JSON.stringify({ name: 'fixture', version: '1.0.0', main: 'index.js' }))
  file('active/node_modules/fixture/index.js', 'module.exports="original dependency"')
  const cli = file('active/dist/agent-runtime/cli.js', 'console.log(require("fixture"))')
  const context = file('pipeline/run/desktop-context.json', '{}')
  return { cli, context }
}
it('retains the executable and dependency contents across replacement of the active package', async () => {
  const { cli, context } = fixture()
  const retained = retainAgentRuntime(cli, context)
  fs.writeFileSync(cli, 'throw Error("new executable")')
  fs.writeFileSync(path.join(root, 'active/node_modules/fixture/index.js'), 'throw Error("changed dependency")')
  expect(await resolveRetainedAgentRuntime(context)).toBe(retained)
  expect(execFileSync(process.execPath, [retained], { encoding: 'utf8' }).trim()).toBe('original dependency')
  expect(retainAgentRuntime(cli, context)).toBe(retained)
})
it('detects same-length edits with preserved timestamps and refuses a corrupt retained dependency', async () => {
  const { cli, context } = fixture()
  const before = runtimeEntryFingerprint(cli), stat = fs.statSync(cli)
  fs.writeFileSync(cli, 'console.log(require("fixturX"))'); fs.utimesSync(cli, stat.atime, stat.mtime)
  expect(runtimeEntryFingerprint(cli)).not.toBe(before)
  fs.writeFileSync(cli, 'console.log(require("fixture"))')
  const retained = retainAgentRuntime(cli, context)
  fs.writeFileSync(path.resolve(retained, '../../../node_modules/fixture/index.js'), 'module.exports="tampered"')
  await expect(resolveRetainedAgentRuntime(context)).rejects.toThrow('integrity')
})
it('never guesses an unrecorded original runtime from the active installation', async () => {
  const { context } = fixture()
  await expect(resolveRetainedAgentRuntime(context)).rejects.toThrow('unrecorded')
})
it('retains nested dependency versions without copying development packages', () => {
  const { cli, context } = fixture()
  file('active/node_modules/dev-only/index.js', 'throw Error("not runtime")')
  file('active/package.json', JSON.stringify({ name: 'specrails-core', version: '5.3.0', dependencies: { fixture: '1', common: '2' } }))
  file('active/node_modules/common/package.json', JSON.stringify({ name: 'common', version: '2.0.0', main: 'index.js' }))
  file('active/node_modules/common/index.js', 'module.exports="root"')
  file('active/node_modules/fixture/package.json', JSON.stringify({ name: 'fixture', version: '1.0.0', main: 'index.js', dependencies: { common: '1' } }))
  file('active/node_modules/fixture/index.js', 'module.exports=require("common")')
  file('active/node_modules/fixture/node_modules/common/package.json', JSON.stringify({ name: 'common', version: '1.0.0', main: 'index.js' }))
  file('active/node_modules/fixture/node_modules/common/index.js', 'module.exports="nested"')
  fs.writeFileSync(cli, 'console.log(require("fixture"), require("common"))')
  const retained = retainAgentRuntime(cli, context)
  expect(fs.existsSync(path.resolve(retained, '../../../node_modules/dev-only'))).toBe(false)
  expect(execFileSync(process.execPath, [retained], { encoding: 'utf8' }).trim()).toBe('nested root')
})


it.skipIf(!process.env.SPECRAILS_EFFICIENCY_CORE_ROOT)('boots the actual paired Core from its retained production dependency closure', async () => {
  const cli = path.join(process.env.SPECRAILS_EFFICIENCY_CORE_ROOT!, 'dist/agent-runtime/cli.js')
  const context = file('pipeline/paired/desktop-context.json', '{}')
  const retained = retainAgentRuntime(cli, context)
  const api = JSON.parse(execFileSync(process.execPath, [retained, 'api'], { encoding: 'utf8', timeout: 30000 }))
  expect(api).toMatchObject({ type: 'runtime-api', apiVersion: 1, workflowVersions: ['7'] })
  expect(await resolveRetainedAgentRuntime(context)).toBe(retained)
}, 120000)


it('retains a package reached through a directory alias using its real CLI path', async () => {
  const { context } = fixture()
  const alias = path.join(root, 'alias')
  fs.symlinkSync(path.join(root, 'active'), alias, process.platform === 'win32' ? 'junction' : 'dir')
  const retained = retainAgentRuntime(path.join(alias, 'dist/agent-runtime/cli.js'), context)
  expect(await resolveRetainedAgentRuntime(context)).toBe(retained)
  expect(execFileSync(process.execPath, [retained], { encoding: 'utf8' }).trim()).toBe('original dependency')
})

it('inspection resolves the same retained CLI with async verification and refuses a corrupt package', async () => {
  const { cli, context } = fixture()
  const retained = retainAgentRuntime(cli, context)
  expect(await resolveRetainedAgentRuntimeForInspection(context)).toBe(retained)
  fs.writeFileSync(path.resolve(retained, '../../../node_modules/fixture/index.js'), 'module.exports="tampered"')
  forgetRetainedPackageVerifications()
  await expect(resolveRetainedAgentRuntimeForInspection(context)).rejects.toThrow('integrity')
  await expect(resolveRetainedAgentRuntimeForInspection(file('pipeline/other/desktop-context.json', '{}'))).rejects.toThrow('unrecorded')
})

it('inspection shares one verification per retained package and re-verifies after the TTL', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const { cli, context } = fixture()
  const retained = retainAgentRuntime(cli, context)
  const reads = vi.spyOn(fs.promises, 'readFile')
  try {
    expect(await Promise.all([resolveRetainedAgentRuntimeForInspection(context), resolveRetainedAgentRuntimeForInspection(context)])).toEqual([retained, retained])
    const firstPass = reads.mock.calls.length
    expect(firstPass).toBeGreaterThan(0)
    expect(await resolveRetainedAgentRuntimeForInspection(context)).toBe(retained)
    expect(reads.mock.calls.length).toBe(firstPass)
    // A tampered package is caught again once the verification expires.
    fs.writeFileSync(path.resolve(retained, '../../../node_modules/fixture/index.js'), 'module.exports="tampered"')
    vi.setSystemTime(Date.now() + RETAINED_PACKAGE_VERIFY_TTL_MS)
    await expect(resolveRetainedAgentRuntimeForInspection(context)).rejects.toThrow('integrity')
  } finally { reads.mockRestore() }
})

it('execution keeps the uncached integrity check', async () => {
  const { cli, context } = fixture()
  const retained = retainAgentRuntime(cli, context)
  expect(await resolveRetainedAgentRuntimeForInspection(context)).toBe(retained)
  fs.writeFileSync(path.resolve(retained, '../../../node_modules/fixture/index.js'), 'module.exports="tampered"')
  await expect(resolveRetainedAgentRuntime(context)).rejects.toThrow('integrity')
})

it('retains one shared copy per Core build for every run instead of copying it into each run', async () => {
  const { cli } = fixture()
  const { configureSharedRuntimePackageCache, collectUnreferencedRuntimePackages } = await import('./agent-runtime-package')
  configureSharedRuntimePackageCache(path.join(root, 'shared'))
  try {
    const first = file('worktree-a/.specrails/pipeline/run-a/desktop-context.json', '{}')
    const second = file('worktree-b/.specrails/pipeline/run-b/desktop-context.json', '{}')
    const copies = vi.spyOn(fs, 'copyFileSync')
    const a = retainAgentRuntime(cli, first)
    const copiedOnce = copies.mock.calls.length
    expect(copiedOnce).toBeGreaterThan(0)
    const b = retainAgentRuntime(cli, second)
    expect(copies.mock.calls.length).toBe(copiedOnce)
    expect(b).toBe(a)
    expect(a.startsWith(path.join(root, 'shared'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'worktree-b/.specrails/pipeline/runtime-packages'))).toBe(false)
    expect(await resolveRetainedAgentRuntime(second)).toBe(a)
    expect(execFileSync(process.execPath, [b], { encoding: 'utf8' }).trim()).toBe('original dependency')
    // A per-pipeline collection ignores pins into the shared cache.
    expect(collectUnreferencedRuntimePackages(path.join(root, 'worktree-b/.specrails/pipeline'), { dryRun: true, minimumAgeMs: 86_400_000, now: Date.now() })).toEqual([])
    // A rebuilt Core is retained again, under its new content digest.
    fs.writeFileSync(path.join(root, 'active/node_modules/fixture/index.js'), 'module.exports="rebuilt dependency"')
    const third = file('worktree-c/.specrails/pipeline/run-c/desktop-context.json', '{}')
    const c = retainAgentRuntime(cli, third)
    expect(c).not.toBe(a)
    expect(execFileSync(process.execPath, [c], { encoding: 'utf8' }).trim()).toBe('rebuilt dependency')
    expect(execFileSync(process.execPath, [a], { encoding: 'utf8' }).trim()).toBe('original dependency')
  } finally { configureSharedRuntimePackageCache(null) }
})

it('collects old shared Core builds, keeping the recent ones and every one a run still pins', async () => {
  const { cli } = fixture()
  const { configureSharedRuntimePackageCache, collectSharedRuntimePackages, removeCollectedPackages } = await import('./agent-runtime-package')
  const cache = path.join(root, 'shared')
  configureSharedRuntimePackageCache(cache)
  try {
    // Five Core builds, each retained by one run, oldest first.
    const builds: Array<{ cli: string; context: string; digest: string }> = []
    for (let build = 0; build < 5; build++) {
      fs.writeFileSync(path.join(root, 'active/node_modules/fixture/index.js'), `module.exports="build ${build}"`)
      const context = file(`projects/app/worktrees/run-${build}/ticket-1/.specrails/pipeline/run-${build}/desktop-context.json`, '{}')
      const retained = retainAgentRuntime(cli, context)
      const digest = path.relative(cache, retained).split(path.sep)[0]!
      const at = new Date(Date.UTC(2026, 10, 1 + build))
      fs.utimesSync(path.join(cache, digest), at, at)
      builds.push({ cli: retained, context, digest })
    }
    // Build 0's run is still retained (a paused run that can resume); build 1's worktree was reaped.
    fs.rmSync(path.join(root, 'projects/app/worktrees/run-1'), { recursive: true })
    // Build 2's pin lives outside the data home (a run in the project's own checkout).
    const outside = file('repo/.specrails/pipeline/run-x/desktop-context.json', '{}')
    fs.rmSync(path.join(root, 'projects/app/worktrees/run-2'), { recursive: true })
    fs.writeFileSync(path.join(path.dirname(outside), 'desktop-runtime-package.json'), JSON.stringify({ schemaVersion: 1, packageVersion: '5.3.0', integrity: builds[2]!.digest, root: path.join(cache, builds[2]!.digest), cli: 'dist/agent-runtime/cli.js' }))
    const now = Date.UTC(2026, 10, 20)
    const options = { cache, projectsRoot: path.join(root, 'projects'), keepRecent: 2, minimumAgeMs: 3_600_000, now }
    // Without its pipeline root, build 2 is only protected by a pin Specrails can find.
    const dry = collectSharedRuntimePackages({ ...options, dryRun: true })
    expect(dry.collected).toEqual([builds[1]!.digest, builds[2]!.digest].sort())
    expect(fs.existsSync(path.join(cache, builds[1]!.digest))).toBe(true)
    const result = collectSharedRuntimePackages({ ...options, pipelineRoots: [path.join(root, 'repo/.specrails/pipeline')] })
    expect(result.collected).toEqual([builds[1]!.digest])
    expect(result.referenced).toEqual(expect.arrayContaining([builds[0]!.digest, builds[2]!.digest]))
    await removeCollectedPackages(result.garbage)
    expect(fs.readdirSync(cache).filter(name => /^[a-f0-9]{64}$/.test(name)).sort()).toEqual([builds[0]!.digest, builds[2]!.digest, builds[3]!.digest, builds[4]!.digest].sort())
    expect(fs.readdirSync(cache).some(name => name.startsWith('.garbage-'))).toBe(false)
    // The retained run still resumes on its own package; the current build is untouched.
    expect(await resolveRetainedAgentRuntime(builds[0]!.context)).toBe(builds[0]!.cli)
    expect(execFileSync(process.execPath, [builds[4]!.cli], { encoding: 'utf8' }).trim()).toBe('build 4')
    // A package used within the age floor is never collected, even when nothing pins it.
    fs.rmSync(path.join(root, 'projects/app/worktrees/run-3'), { recursive: true })
    const fresh = new Date(now - 60_000)
    fs.utimesSync(path.join(cache, builds[3]!.digest), fresh, fresh)
    expect(collectSharedRuntimePackages({ ...options, keepRecent: 1, dryRun: true }).collected).not.toContain(builds[3]!.digest)
    expect(() => collectSharedRuntimePackages({ ...options, keepRecent: 0 })).toThrow('keeps at least the current build')
  } finally { configureSharedRuntimePackageCache(null) }
})

it('re-pins an unchanged shared build under the package lock and marks it as just used', async () => {
  const { cli } = fixture()
  const { configureSharedRuntimePackageCache } = await import('./agent-runtime-package')
  const cache = path.join(root, 'shared')
  configureSharedRuntimePackageCache(cache)
  try {
    const first = retainAgentRuntime(cli, file('a/.specrails/pipeline/run-a/desktop-context.json', '{}'))
    const digest = path.relative(cache, first).split(path.sep)[0]!
    const old = new Date(Date.UTC(2026, 0, 1))
    fs.utimesSync(path.join(cache, digest), old, old)
    retainAgentRuntime(cli, file('b/.specrails/pipeline/run-b/desktop-context.json', '{}'))
    expect(fs.statSync(path.join(cache, digest)).mtimeMs).toBeGreaterThan(old.getTime())
    expect(fs.readdirSync(path.join(cache, '.refs', digest))).toHaveLength(2)
  } finally { configureSharedRuntimePackageCache(null) }
})

it('prepares the shared package off the event loop so the launch only pins it', async () => {
  const { configureSharedRuntimePackageCache, prepareRetainedAgentRuntime } = await import('./agent-runtime-package')
  const { cli, context } = fixture()
  configureSharedRuntimePackageCache(path.join(root, 'cache'))
  try {
    // Two launches at once share one preparation.
    await Promise.all([prepareRetainedAgentRuntime(cli), prepareRetainedAgentRuntime(cli)])
    const packages = fs.readdirSync(path.join(root, 'cache')).filter((name) => /^[a-f0-9]{64}$/.test(name))
    expect(packages).toHaveLength(1)
    expect(fs.readdirSync(path.join(root, 'cache')).filter((name) => name.startsWith('.staged-'))).toEqual([])
    // The synchronous retention then copies nothing: it pins the prepared package.
    const copy = vi.spyOn(fs, 'copyFileSync')
    const retained = retainAgentRuntime(cli, context)
    expect(copy).not.toHaveBeenCalled()
    expect(retained).toBe(path.join(root, 'cache', packages[0]!, 'dist/agent-runtime/cli.js'))
    expect(execFileSync(process.execPath, [retained], { encoding: 'utf8' }).trim()).toBe('original dependency')
    // The execution gate's async digest names the package exactly as the synchronous retention digest did.
    expect(await resolveRetainedAgentRuntime(context)).toBe(retained)
    copy.mockRestore()
  } finally {
    configureSharedRuntimePackageCache(null)
  }
})

it('the execution gate digests with async I/O and agrees with the synchronous retention digest', async () => {
  const { cli, context } = fixture()
  const retained = retainAgentRuntime(cli, context)
  const syncReads = vi.spyOn(fs, 'readFileSync')
  try {
    expect(await resolveRetainedAgentRuntime(context)).toBe(retained)
    // Only the small pin file is read synchronously; the package contents are not.
    expect(syncReads.mock.calls.map(([target]) => path.basename(String(target)))).toEqual(['desktop-runtime-package.json'])
  } finally { syncReads.mockRestore() }
})

it('a burst of execution gates never reuses a digest that started before the request', async () => {
  const { cli } = fixture()
  const { configureSharedRuntimePackageCache } = await import('./agent-runtime-package')
  configureSharedRuntimePackageCache(path.join(root, 'shared'))
  try {
    const contexts = ['a', 'b', 'c', 'd'].map(run => file(`w-${run}/.specrails/pipeline/run-${run}/desktop-context.json`, '{}'))
    const retained = contexts.map(context => retainAgentRuntime(cli, context))
    expect(new Set(retained).size).toBe(1)
    const original = fs.promises.readFile.bind(fs.promises) as (...args: unknown[]) => Promise<Buffer>
    const reads = vi.spyOn(fs.promises, 'readFile')
    const fileCount = async () => { reads.mockClear(); await resolveRetainedAgentRuntime(contexts[0]!); return reads.mock.calls.length }
    const perDigest = await fileCount()
    expect(perDigest).toBeGreaterThan(0)
    // Four simultaneous resumes on one shared package: one running digest plus one queued behind it.
    reads.mockClear()
    expect(await Promise.all(contexts.map(context => resolveRetainedAgentRuntime(context)))).toEqual(retained)
    expect(reads.mock.calls.length).toBe(2 * perDigest)
    // A tamper landing after a digest already read the file is caught by every later request:
    // the first digest has read the original bytes and is held before it finishes.
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let readsDone = 0
    reads.mockImplementation((async (...args: unknown[]) => { const content = await original(...args); readsDone++; await held; return content }) as typeof fs.promises.readFile)
    const first = resolveRetainedAgentRuntime(contexts[0]!)
    while (readsDone < perDigest) await new Promise(resolve => setImmediate(resolve))
    fs.writeFileSync(path.resolve(retained[0]!, '../../../node_modules/fixture/index.js'), 'module.exports="tampered"')
    const later = resolveRetainedAgentRuntime(contexts[1]!)
    release()
    expect(await first).toBe(retained[0])
    await expect(later).rejects.toThrow('integrity')
    reads.mockRestore()
  } finally { configureSharedRuntimePackageCache(null) }
})

it('a launch stamps the Core source once: its retention reuses the stamp its preparation just took', async () => {
  const { configureSharedRuntimePackageCache, prepareRetainedAgentRuntime } = await import('./agent-runtime-package')
  const { cli } = fixture()
  configureSharedRuntimePackageCache(path.join(root, 'cache'))
  try {
    await prepareRetainedAgentRuntime(cli)
    retainAgentRuntime(cli, file('w1/.specrails/pipeline/r1/desktop-context.json', '{}'))
    // Every later launch: one fast-path preparation (one source walk), then a retention that walks nothing.
    const stats = vi.spyOn(fs, 'statSync')
    expect(await prepareRetainedAgentRuntime(cli)).toBe(false)
    const walk = stats.mock.calls.length
    expect(walk).toBeGreaterThan(0)
    retainAgentRuntime(cli, file('w2/.specrails/pipeline/r2/desktop-context.json', '{}'))
    const pinOnly = stats.mock.calls.length - walk
    expect(pinOnly).toBeLessThan(walk)
    // The hand-off is single use: a retention without a fresh preparation stamps the source itself.
    retainAgentRuntime(cli, file('w3/.specrails/pipeline/r3/desktop-context.json', '{}'))
    expect(stats.mock.calls.length - walk - pinOnly).toBe(walk + pinOnly)
    stats.mockRestore()
  } finally { configureSharedRuntimePackageCache(null) }
})

it('announces a preparation to every launch that waits for it and stays quiet once the build is retained', async () => {
  const { configureSharedRuntimePackageCache, prepareRetainedAgentRuntime } = await import('./agent-runtime-package')
  const { cli } = fixture()
  configureSharedRuntimePackageCache(path.join(root, 'cache'))
  try {
    const first = vi.fn(), joined = vi.fn(), later = vi.fn()
    expect(await Promise.all([prepareRetainedAgentRuntime(cli, { onPreparing: first }), prepareRetainedAgentRuntime(cli, { onPreparing: joined })])).toEqual([true, true])
    expect(first).toHaveBeenCalledTimes(1)
    expect(joined).toHaveBeenCalledTimes(1)
    expect(await prepareRetainedAgentRuntime(cli, { onPreparing: later })).toBe(false)
    expect(later).not.toHaveBeenCalled()
    // A throwing observer never stops the preparation.
    fs.writeFileSync(path.join(root, 'active/node_modules/fixture/index.js'), 'module.exports="rebuilt"')
    expect(await prepareRetainedAgentRuntime(cli, { onPreparing: () => { throw new Error('log closed') } })).toBe(true)
    expect(fs.readdirSync(path.join(root, 'cache')).filter((name) => /^[a-f0-9]{64}$/.test(name))).toHaveLength(2)
  } finally { configureSharedRuntimePackageCache(null) }
})

it('does not announce anything without a shared package cache', async () => {
  const { prepareRetainedAgentRuntime } = await import('./agent-runtime-package')
  const { cli } = fixture()
  const observer = vi.fn()
  expect(await prepareRetainedAgentRuntime(cli, { onPreparing: observer })).toBe(false)
  expect(observer).not.toHaveBeenCalled()
})
