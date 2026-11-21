import fs from 'node:fs'
import path from 'node:path'
import { HEADLESS_ENV_KEY } from '../../../util/headless-env'

/**
 * Core's Electron headless guard for runs whose retained Core predates it.
 *
 * Core 6.12 (contract 5.17) ships `dist/pipeline/electron-headless-guard.cjs`
 * and puts it on `NODE_OPTIONS` of every agent and verification process it
 * starts while `SPECRAILS_HEADLESS=1`: Electron windows stay transparent,
 * click-through and unfocused. A run keeps the Core it started with, so a run
 * started (or forked from one started) before that Core only gets the marker
 * from Desktop and a project that does not read it opens real windows over the
 * person's screen.
 *
 * For those runs Desktop loads the guard into the Core process itself. In plain
 * Node the guard hands itself to every child that still carries the marker, and
 * older Cores pass `NODE_OPTIONS` through to agents and verification commands,
 * so it reaches the project's test runners and the Electron apps they launch.
 *
 * The guard file is copied once into the run's own runtime directory from the
 * installed Core: a real file on disk (also under the pkg sidecar), stable for
 * the life of the run (a Core update never moves or deletes it under a running
 * process, and the verification environment stays the same across resumes),
 * and removed with the run. A retained Core that ships the guard applies it
 * itself, so Desktop leaves `NODE_OPTIONS` alone and never requires it twice.
 */
export const ELECTRON_HEADLESS_GUARD_FILE = 'electron-headless-guard.cjs'

function isFile(file: string): boolean {
  try { return fs.statSync(file).isFile() } catch { return false }
}

/** The guard a Core package ships beside its pipeline module, from its `dist/agent-runtime/cli.js`; null when that Core predates it. */
export function coreHeadlessGuard(cli: string | null | undefined): string | null {
  if (!cli) return null
  const guard = path.resolve(path.dirname(cli), '..', 'pipeline', ELECTRON_HEADLESS_GUARD_FILE)
  return isFile(guard) ? guard : null
}

export type RunHeadlessGuard =
  /** `SPECRAILS_HEADLESS` is not `1`: the person opted out. */
  | { source: 'opted-out' }
  /** The run's retained Core applies its own guard. */
  | { source: 'core' }
  /** Desktop loads this copy into the Core process. */
  | { source: 'desktop'; path: string }
  /** Neither the run's Core nor the installed Core ships a guard. */
  | { source: 'unavailable'; reason: string }

/**
 * Which guard a Core process for this run needs. `env` is the environment the
 * Core process gets (after the headless marker); `runCli` is the run's retained
 * Core CLI; `currentCli` finds the installed Core, the copy's source.
 */
export function resolveRunHeadlessGuard(input: { env: NodeJS.ProcessEnv; runCli: string; runtimeDirectory: string; currentCli: () => string | null }): RunHeadlessGuard {
  if (input.env[HEADLESS_ENV_KEY] !== '1') return { source: 'opted-out' }
  if (coreHeadlessGuard(input.runCli)) return { source: 'core' }
  const copy = path.join(input.runtimeDirectory, ELECTRON_HEADLESS_GUARD_FILE)
  if (isFile(copy)) return { source: 'desktop', path: copy }
  let source: string | null
  try { source = coreHeadlessGuard(input.currentCli()) } catch { source = null }
  if (!source) return { source: 'unavailable', reason: 'neither this run\'s Core nor the installed Core ships the Electron headless guard' }
  try { fs.copyFileSync(source, copy, fs.constants.COPYFILE_EXCL) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return { source: 'unavailable', reason: `the guard could not be copied into the run (${(error as Error).message})` } }
  return { source: 'desktop', path: copy }
}

/**
 * `env` with `--require <guard>` added to `NODE_OPTIONS` (existing options
 * kept, same form Core uses). Unchanged when the person opted out or the guard
 * is already there. Never mutates `env`. The guard itself is also idempotent:
 * a second copy loaded in the same process returns immediately.
 */
export function withElectronHeadlessGuard(env: NodeJS.ProcessEnv, guard: string): NodeJS.ProcessEnv {
  if (env[HEADLESS_ENV_KEY] !== '1') return env
  const current = env.NODE_OPTIONS ?? ''
  // The option carries the path quoted (`JSON.stringify`), which doubles Windows backslashes:
  // look for that spelling as well as the bare path.
  const quoted = JSON.stringify(guard)
  if (current.includes(quoted) || current.includes(guard)) return env
  return { ...env, NODE_OPTIONS: `${current} --require ${quoted}`.trim() }
}

/** The run-log line for a guard decision Desktop made; null when Core owns it or the person opted out. */
export function headlessGuardLogLine(guard: RunHeadlessGuard): string | null {
  if (guard.source === 'desktop') return '[runtime] This run\'s Core predates the Electron headless guard; Desktop applies it so app windows stay hidden.\n'
  if (guard.source === 'unavailable') return `[runtime] Windows an app opens during this run may be visible: ${guard.reason}.\n`
  return null
}
