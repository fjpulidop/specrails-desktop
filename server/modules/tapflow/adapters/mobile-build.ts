/**
 * Builds a mobile app for the simulator in a working copy: reads the repository (bounded), resolves the
 * Xcode scheme (`xcodebuild -list -json`), runs each step without a shell with a time limit (tree kill),
 * streams its lines to the run log, keeps a bounded tail for the failure reason, and finds the artifact.
 */
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import treeKill from 'tree-kill'
import { buildPlan, detectMobileApps, pickArtifact, type MobileApp, type MobilePlatform, type ProjectFiles } from '../mobile-project'

const READ_LIMIT = 512 * 1024

/** The repository as `ProjectFiles`, confined to `root` (no symlink escapes). */
export function projectFilesAt(root: string): ProjectFiles {
  const real = fs.realpathSync(root)
  const inside = (rel: string): string | null => {
    const abs = path.resolve(real, rel)
    return abs === real || abs.startsWith(real + path.sep) ? abs : null
  }
  return {
    exists: (rel) => { const abs = inside(rel); return abs !== null && fs.existsSync(abs) },
    list: (rel) => { const abs = inside(rel); try { return abs ? fs.readdirSync(abs) : [] } catch { return [] } },
    read: (rel) => {
      const abs = inside(rel)
      if (!abs) return null
      try {
        const stat = fs.statSync(abs)
        if (!stat.isFile() || stat.size > READ_LIMIT) return null
        return fs.readFileSync(abs, 'utf8')
      } catch { return null }
    },
  }
}

/** Picks the scheme to build: the one named like the app's container, else the first that is not a test/pod scheme. */
export function chooseScheme(schemes: readonly string[], container: string | undefined): string | null {
  const base = container ? path.basename(container).replace(/\.(xcworkspace|xcodeproj)$/, '') : null
  const usable = schemes.filter((scheme) => !/Tests?$|^Pods-|-Pods/.test(scheme))
  return (base && usable.find((scheme) => scheme === base)) ?? usable[0] ?? null
}

export interface StepRunner {
  run(argv: readonly string[], cwd: string, onLine: (line: string) => void, timeoutMs: number): Promise<{ code: number | null; tail: string }>
}

const TAIL_LINES = 40

export const processStepRunner: StepRunner = {
  run: (argv, cwd, onLine, timeoutMs) => new Promise((resolve) => {
    const tail: string[] = []
    const keep = (line: string) => { tail.push(line); if (tail.length > TAIL_LINES) tail.shift() }
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => { keep(`[timed out after ${Math.round(timeoutMs / 60_000)} min]`); if (child.pid) treeKill(child.pid, 'SIGKILL') }, timeoutMs)
    let pending = ''
    const feed = (chunk: Buffer) => {
      pending += chunk.toString('utf8')
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) { keep(line); onLine(line) }
    }
    child.stdout.on('data', feed)
    child.stderr.on('data', feed)
    child.on('error', (err) => { clearTimeout(timer); keep(err.message); resolve({ code: null, tail: tail.join('\n') }) })
    child.on('close', (code) => { clearTimeout(timer); if (pending) keep(pending); resolve({ code, tail: tail.join('\n') }) })
  }),
}

const listSchemes = (cwd: string, container?: string) => new Promise<string[]>((resolve) => {
  const args = ['-list', '-json', ...(container ? [container.endsWith('.xcworkspace') ? '-workspace' : '-project', container] : [])]
  execFile('xcodebuild', args, { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
    if (err) return resolve([])
    try {
      const parsed = JSON.parse(stdout) as { workspace?: { schemes?: string[] }; project?: { schemes?: string[] } }
      resolve(parsed.workspace?.schemes ?? parsed.project?.schemes ?? [])
    } catch { resolve([]) }
  })
})

export type BuildOutcome =
  | { outcome: 'built'; artifacts: Array<{ platform: MobilePlatform; path: string }> }
  | { outcome: 'none'; detail: string }
  | { outcome: 'failed'; detail: string; command?: string; tail?: string }

const STEP_TIMEOUT_MS = 30 * 60_000

export function createMobileBuilder(deps: { runner?: StepRunner; schemes?: (cwd: string, container?: string) => Promise<string[]>; files?: (root: string) => ProjectFiles } = {}) {
  const runner = deps.runner ?? processStepRunner
  const schemes = deps.schemes ?? listSchemes
  const filesAt = deps.files ?? projectFilesAt
  return async function build(targetPath: string, platforms: readonly MobilePlatform[], log: (line: string) => void): Promise<BuildOutcome> {
    const apps = detectMobileApps(filesAt(targetPath))
    const wanted = platforms.map((platform) => apps.find((app) => app.platform === platform)).filter((app): app is MobileApp => Boolean(app))
    if (!wanted.length) return { outcome: 'none', detail: `This project has no ${platforms.join(' or ')} app Specrails can build.` }
    const artifacts: Array<{ platform: MobilePlatform; path: string }> = []
    for (let app of wanted) {
      // Managed Expo: generate the native project first, then build it like React Native.
      if (app.stack === 'expo') {
        const prebuild = ['npx', '--yes', 'expo', 'prebuild', '--platform', app.platform, '--no-install']
        log(`$ ${prebuild.join(' ')}`)
        const generated = await runner.run(prebuild, targetPath, (line) => log(`  ${line}`), STEP_TIMEOUT_MS)
        if (generated.code !== 0) return { outcome: 'failed', detail: `expo prebuild exited with ${generated.code ?? 'no code'}.`, command: prebuild.join(' '), tail: generated.tail }
        const native = detectMobileApps(filesAt(targetPath)).find((candidate) => candidate.platform === app.platform && candidate.stack === 'react-native')
        if (!native) return { outcome: 'failed', detail: `expo prebuild did not produce a native ${app.platform} project.` }
        app = native
      }
      let scheme: string | undefined
      if (app.platform === 'ios' && app.stack !== 'flutter') {
        const listed = await schemes(path.join(targetPath, app.root), app.xcodeContainer)
        scheme = chooseScheme(listed, app.xcodeContainer) ?? undefined
        if (!scheme) return { outcome: 'failed', detail: `No buildable scheme found in ${app.xcodeContainer ?? app.root}. Share the app scheme in Xcode (Manage Schemes ▸ Shared).` }
      }
      const plan = buildPlan(app, { scheme })
      log(`Building the ${app.platform === 'ios' ? 'iOS' : 'Android'} app (${app.stack})…`)
      for (const step of plan.steps) {
        log(`$ ${step.join(' ')}`)
        const result = await runner.run(step, path.join(targetPath, plan.cwd), (line) => log(`  ${line}`), STEP_TIMEOUT_MS)
        if (result.code !== 0) return { outcome: 'failed', detail: `${step[0]} exited with ${result.code ?? 'no code'} while building the ${app.platform} app.`, command: step.join(' '), tail: result.tail }
      }
      const dir = path.join(targetPath, plan.artifactDir)
      const artifact = pickArtifact(fs.existsSync(dir) ? fs.readdirSync(dir) : [], plan.artifactExtension)
      if (!artifact) return { outcome: 'failed', detail: `The build finished but no ${plan.artifactExtension} was found in ${plan.artifactDir}.` }
      artifacts.push({ platform: app.platform, path: path.join(dir, artifact) })
      log(`Built ${artifact}.`)
    }
    return { outcome: 'built', artifacts }
  }
}
