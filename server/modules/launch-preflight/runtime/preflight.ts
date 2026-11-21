/**
 * Launch preflight probes: free disk at the worktrees location, provider
 * sign-in (`claude auth status`, `codex login status`), `gh auth status` and
 * the provider quota. All probes run in parallel, each bounded by a timeout,
 * and never block the event loop. Sign-in results are cached briefly
 * (machine-wide account state) and concurrent asks share one probe.
 * Only exit codes are read: the commands' output can carry account details.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { diskChip, githubChip, headlessChip, providerChip, quotaChip, signInFromExit, summarize, type DesktopGuiFramework, type PreflightReport, type SignInStatus } from '../domain'

export const SIGN_IN_TTL_MS = 60_000
export const PROBE_TIMEOUT_MS = 5_000

/** The status subcommand of each provider CLI that reports sign-in by exit code. */
export const SIGN_IN_COMMANDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  claude: ['auth', 'status'],
  codex: ['login', 'status'],
})

export interface PreflightDeps {
  /** Run a command; `missing` when the binary does not exist. */
  exec(command: string, args: readonly string[], timeoutMs: number): Promise<{ code: number | null; timedOut: boolean; missing: boolean }>
  /** Free bytes on the filesystem holding `dir` (null when unknown). */
  freeBytes(dir: string): Promise<number | null>
  /** The executable of a provider CLI (null when not installed). */
  executable(providerId: string): Promise<string | null>
  quota(providerId: string): { providerId: string; level: string; usedPercent: number | null; rejectedUntil: string | null } | null
  /** The project's desktop GUI toolkit and whether it honours SPECRAILS_HEADLESS (null: not a desktop app). */
  desktopGui?(projectDir: string): Promise<{ framework: DesktopGuiFramework; honoured: boolean } | null>
  now(): number
}

export function createLaunchPreflight(deps: PreflightDeps) {
  const cache = new Map<string, { at: number; value: Promise<SignInStatus> }>()

  function cached(key: string, probe: () => Promise<SignInStatus>): Promise<SignInStatus> {
    const hit = cache.get(key)
    if (hit && deps.now() - hit.at < SIGN_IN_TTL_MS) return hit.value
    const value = probe().catch((): SignInStatus => 'unknown')
    cache.set(key, { at: deps.now(), value })
    // An unknown result (timeout) is not worth keeping: the next dialog asks again.
    void value.then((status) => { if (status === 'unknown' && cache.get(key)?.value === value) cache.delete(key) })
    return value
  }

  function providerSignIn(providerId: string): Promise<SignInStatus> {
    const args = SIGN_IN_COMMANDS[providerId]
    if (!args) return Promise.resolve('unknown')
    return cached(`provider:${providerId}`, async () => {
      const binary = await deps.executable(providerId)
      if (!binary) return 'missing'
      return signInFromExit(await deps.exec(binary, args, PROBE_TIMEOUT_MS))
    })
  }

  function githubSignIn(): Promise<SignInStatus> {
    return cached('github', async () => signInFromExit(await deps.exec('gh', ['auth', 'status'], PROBE_TIMEOUT_MS)))
  }

  async function run(input: { worktreesDir: string; providers: readonly string[]; github: boolean; fresh?: boolean; projectDir?: string }): Promise<PreflightReport> {
    if (input.fresh) cache.clear()
    const providers = [...new Set(input.providers)]
    const [free, signIns, github, gui] = await Promise.all([
      withTimeout(deps.freeBytes(input.worktreesDir), PROBE_TIMEOUT_MS, null),
      Promise.all(providers.map((id) => providerSignIn(id))),
      input.github ? githubSignIn() : Promise.resolve(null),
      input.projectDir && deps.desktopGui ? withTimeout(deps.desktopGui(input.projectDir), PROBE_TIMEOUT_MS, null) : Promise.resolve(null),
    ])
    const chips = [
      diskChip(free),
      ...providers.map((id, index) => providerChip(id, signIns[index]!)),
      ...(github ? [githubChip(github)] : []),
      ...providers.flatMap((id) => { const view = deps.quota(id); return view ? [quotaChip(view)] : [] }),
      // Only a desktop GUI project gets this chip: whether a run's windows stay hidden.
      ...(gui ? [headlessChip(gui.framework, gui.honoured)] : []),
    ]
    return summarize(chips, deps.now())
  }

  return { run, clear: () => cache.clear() }
}

export type LaunchPreflight = ReturnType<typeof createLaunchPreflight>

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([promise.catch(() => fallback), new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); timer.unref?.() })]).finally(() => clearTimeout(timer))
}

/** Free bytes on the filesystem that holds `dir`, from its nearest existing ancestor. */
export async function statfsFreeBytes(dir: string): Promise<number | null> {
  let current = path.resolve(dir)
  for (;;) {
    try {
      const stats = await fs.statfs(current)
      return Number(stats.bavail) * Number(stats.bsize)
    } catch (error) {
      const parent = path.dirname(current)
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === current) return null
      current = parent
    }
  }
}
