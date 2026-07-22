import { spawnSync, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, resolve as resolvePath } from 'path'
import { spawnCli, windowsSpawnEnv } from './util/win-spawn'
import { getBundledCoreCli, getBundledCoreRoot, getBundledCoreVersion } from './bundled-core'
import { getBundledOpenspecCli } from './bundled-openspec'
import { resolveBundledNodeExe } from './path-resolver'
import { FrameworkManager } from './framework-manager'
import { mirrorProjectEntry } from './artifact-registry'
import { installConfigPathForProvider } from './install-config-path'
import { workspacePathFor } from './workspace-manager'
import { CORE_PACKAGE_SPEC } from './core-package'
import { getAdapter } from './providers'

// ─── Offline workspace assemble (add-project-builder D4) ─────────────────────
//
// The single shared "assemble a project workspace from the BUNDLED framework"
// primitive, extracted from SetupManager's bundled-core fast path so the
// Project Builder's orchestrated commit can assemble WITHOUT the wizard's
// streaming/phase shell. Extract-don't-fork: SetupManager keeps its shell and
// its npx fallback. The Builder PREFERS the bundle (offline day 0) but falls
// back to `npx specrails-core` when no bundle is present — so `npm run dev` and
// any runtimes-less build still work. Only a DESKTOP build with a MISSING/
// corrupted bundle hard-fails (see `canAssembleProject`).

/**
 * Spawn the BUNDLED specrails-core `init` (offline framework + assemble).
 * Runs `node <bundled-cli> init <args>` with `SPECRAILS_CORE_SCRIPT_DIR`
 * pointed at the bundle so core's template/command sources resolve from the
 * app bundle, NOT a global install or npm registry. Forces RELOCATION (the
 * desktop keeps the user's repo pristine). When the app also ships
 * @fission-ai/openspec, `SPECRAILS_OPENSPEC_BIN`/`_NODE` make the last network
 * step offline too.
 *
 * Returns null when no bundled core is present. Callers may then use the npx
 * fallback outside the packaged desktop app.
 */
export function spawnBundledCoreInit(args: string[], cwd: string): ChildProcess | null {
  const cli = getBundledCoreCli()
  const coreRoot = getBundledCoreRoot()
  if (!cli || !coreRoot) return null
  const fullArgs = [cli, 'init', ...args]
  const env: NodeJS.ProcessEnv = { ...windowsSpawnEnv(), SPECRAILS_CORE_SCRIPT_DIR: coreRoot, SPECRAILS_RELOCATE: '1' }

  const openspecCli = getBundledOpenspecCli()
  if (openspecCli) {
    env.SPECRAILS_OPENSPEC_BIN = openspecCli
    // MUST be a REAL node executable — NOT process.execPath (the packaged
    // `specrails-server` pkg binary cannot run openspec's ESM CLI).
    env.SPECRAILS_OPENSPEC_NODE = resolveBundledNodeExe() ?? 'node'
  }

  // Run the core CLI with the REAL bundled node — process.execPath only in
  // dev/tests where it IS node.
  const nodeBin = resolveBundledNodeExe() ?? process.execPath
  console.log(
    `[offline-assemble] spawning BUNDLED core: ${nodeBin} ${fullArgs.join(' ')} (cwd=${cwd})` +
      (openspecCli ? ' [bundled openspec: offline]' : ' [openspec: npx fallback]'),
  )
  return spawnCli(nodeBin, fullArgs, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** True when the bundled specrails-core is present (offline assemble possible). */
export function hasOfflineCore(): boolean {
  return getBundledCoreCli() !== null
}

const WHICH_CMD = process.platform === 'win32' ? 'where' : 'which'

/** Resolve a core binary override to an absolute path (mirrors SetupManager). */
function resolveCoreBinary(bin: string): string {
  if (isAbsolute(bin)) return bin
  if (bin.includes('/') || bin.includes('\\')) return resolvePath(bin)
  const result = spawnSync(WHICH_CMD, [bin], {
    env: windowsSpawnEnv(), shell: process.platform === 'win32', encoding: 'utf-8', timeout: 5_000,
  })
  if (result.error || (result.status ?? 1) !== 0) return bin
  const first = `${result.stdout ?? ''}`.trim().split(/\r?\n/)[0]?.trim()
  return first && first.length > 0 ? first : bin
}

/**
 * Spawn `npx specrails-core init` (or the `SPECRAILS_CORE_BIN` override) —
 * the network fallback SetupManager uses when no bundle is present. Forces
 * RELOCATION so the user's repo stays pristine.
 */
export function spawnNpxCoreInit(args: string[], cwd: string): ChildProcess {
  const override = process.env.SPECRAILS_CORE_BIN
  const bin = override ? resolveCoreBinary(override) : 'npx'
  const fullArgs = override ? ['init', ...args] : ['--yes', '--prefer-online', CORE_PACKAGE_SPEC, 'init', ...args]
  console.log(`[offline-assemble] spawning npx core: ${bin} ${fullArgs.join(' ')} (cwd=${cwd})`)
  return spawnCli(bin, fullArgs, {
    cwd,
    env: { ...windowsSpawnEnv(), SPECRAILS_RELOCATE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/**
 * Whether the Project Builder can assemble a workspace at all. True when the
 * bundle is present (offline path) OR we're NOT in a packaged desktop build
 * (dev / runtimes-less server → npx fallback). Only a DESKTOP build with a
 * missing/corrupted bundle returns false → the "reinstall the app" error.
 */
export function canAssembleProject(): boolean {
  return getBundledCoreCli() !== null || process.env.SPECRAILS_IS_DESKTOP !== '1'
}

export interface OfflineAssembleOptions {
  /** The freshly-created repo path (already git-initialized by the caller). */
  projectPath: string
  /** Registry slug — allocated by the caller before assemble. */
  slug: string
  /** Future desktop project id (registered LAST by the caller). */
  desktopProjectId: string
  /** Providers to assemble, first = primary. */
  providers: string[]
  /**
   * Legacy single-provider override for the install config's default model.
   * Multi-provider callers must use `defaultModels` so a model alias belonging
   * to one provider can never leak into another provider's config.
   */
  defaultModel?: string
  /** Explicit per-provider default-model overrides. */
  defaultModels?: Readonly<Record<string, string | undefined>>
  /**
   * Silent-add mode (global-core-zero-friction): keep assembling remaining
   * providers when one fails, reporting per-provider results instead of
   * throwing on the first failure. Default false = legacy throw-on-first.
   */
  continueOnError?: boolean
  /** Progress hooks for per-provider status surfaces (silent-add WS events). */
  onProviderStart?: (provider: string) => void
  onProviderResult?: (result: AssembleProviderResult) => void
  /** Test seam. */
  io?: {
    spawnInit?: typeof spawnBundledCoreInit
    materialize?: (providers: string[]) => void
  }
}

export interface AssembleProviderResult {
  provider: string
  ok: boolean
  error?: string
}

function buildQuickInstallConfigYaml(provider: string, defaultModel: string): string {
  // Matches serializeInstallConfigYaml's shape (specrails-core tui-installer
  // format) for a quick/template install with the default agent set.
  return [
    '# specrails install config — generated by Specrails Project Builder',
    'version: 1',
    `provider: ${provider}`,
    'tier: quick',
    'agents:',
    '  selected: []',
    '  excluded: []',
    'models:',
    '  preset: balanced',
    `  defaults: { model: ${defaultModel} }`,
    '  overrides: {}',
    'agent_teams: false',
    '',
  ].join('\n')
}

function defaultModelForProvider(opts: OfflineAssembleOptions, provider: string): string {
  const providerOverride = opts.defaultModels?.[provider]
  if (providerOverride) return providerOverride

  // Preserve the original override API for its unambiguous use case. Applying
  // one alias across a mixed-provider install is unsafe: `sonnet`, for example,
  // is a Claude alias and is not a valid Kimi/Codex/Gemini default.
  if (opts.providers.length === 1 && opts.defaultModel) return opts.defaultModel

  return getAdapter(provider).defaultModel()
}

/**
 * Assemble a project workspace from the bundled framework when available, or
 * from the npx fallback in development/runtimes-less builds: registry mirror
 * → framework materialize (idempotent) → one `init` per provider. Throws on
 * any failure — the caller surfaces it as a failed step; nothing here registers
 * the project. With `continueOnError` it instead reports per-provider results
 * (silent-add mode).
 */
export async function assembleProjectOffline(opts: OfflineAssembleOptions): Promise<AssembleProviderResult[]> {
  const { projectPath, slug, desktopProjectId, providers } = opts
  if (!canAssembleProject() && !opts.io?.spawnInit) {
    throw new Error('specrails-core is not available — reinstall the Specrails app')
  }
  if (providers.length === 0) throw new Error('at least one provider is required')
  // Bundle present ⇒ offline bundled init; otherwise (dev / no bundle) ⇒ npx.
  const useBundled = hasOfflineCore()

  // Registry entry BEFORE core's init so core resolves its workspace from the
  // registry and relocates under the desktop's slug (same reasoning as
  // SetupManager.startInstall's pre-install mirror).
  mirrorProjectEntry({
    repoPath: projectPath,
    slug,
    providers,
    primaryProvider: providers[0],
    desktopProjectId,
  })

  // Materialize the bundled framework for the selected providers (idempotent —
  // core's ensureFramework skips when already present). Best-effort: the
  // bundled init re-runs ensureFramework, so it self-heals.
  const materialize = opts.io?.materialize ?? ((provs: string[]) => {
    try {
      const fm = new FrameworkManager({ broadcast: () => { /* headless */ } })
      const mat = fm.materialize(getBundledCoreVersion() ?? undefined, provs)
      if (mat.ran && mat.errors.length > 0) {
        console.warn(
          `[offline-assemble] framework materialize had errors: ${mat.errors.map((e) => `${e.provider}: ${e.message}`).join('; ')}`,
        )
      }
    } catch (err) {
      console.warn(`[offline-assemble] framework materialize threw (non-fatal): ${(err as Error).message}`)
    }
  })
  materialize(providers)

  const spawnInit = opts.io?.spawnInit ?? (useBundled ? spawnBundledCoreInit : spawnNpxCoreInit)
  const coreLabel = useBundled ? 'bundled core' : 'npx core'
  const results: AssembleProviderResult[] = []
  const assembleOne = async (provider: string): Promise<void> => {
    const configPath = installConfigPathForProvider({ slug, path: projectPath }, provider)
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, buildQuickInstallConfigYaml(provider, defaultModelForProvider(opts, provider)), 'utf-8')

    const child = spawnInit(['--yes', '--from-config', configPath], projectPath)
    if (!child) {
      throw new Error('specrails-core is not available — reinstall the Specrails app')
    }
    const stderrChunks: string[] = []
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk.toString())
    })
    child.stdout?.resume() // drain so the child never blocks on a full pipe
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', (err) => reject(new Error(`failed to launch ${coreLabel}: ${err.message}`)))
      child.once('close', (exitCode) => resolve(exitCode))
    })
    if (code !== 0) {
      const tail = stderrChunks.join('').split('\n').filter(Boolean).slice(-5).join(' ').slice(0, 500)
      throw new Error(`${coreLabel} init failed for ${provider} (exit ${code})${tail ? `: ${tail}` : ''}`)
    }
  }
  for (const provider of providers) {
    opts.onProviderStart?.(provider)
    try {
      await assembleOne(provider)
      const result: AssembleProviderResult = { provider, ok: true }
      results.push(result)
      opts.onProviderResult?.(result)
    } catch (err) {
      const result: AssembleProviderResult = {
        provider,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }
      results.push(result)
      opts.onProviderResult?.(result)
      if (!opts.continueOnError) throw err
    }
  }

  // The activation gate (workspace-resolution) requires a populated workspace;
  // verify assemble actually produced one so a silent core no-op cannot leave
  // a half-created project that would spawn from a repo cwd. In
  // continueOnError mode this only applies when at least one provider
  // succeeded (an all-failed run already carries its per-provider errors).
  const workspace = workspacePathFor(slug)
  if (!existsSync(workspace) && results.some((r) => r.ok)) {
    throw new Error(`assemble completed but workspace was not created at ${workspace}`)
  }
  if (!opts.continueOnError && !existsSync(workspace)) {
    throw new Error(`assemble completed but workspace was not created at ${workspace}`)
  }
  return results
}
