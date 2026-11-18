import { execFile, execSync } from 'child_process'
import { checkSessionContract, type SessionContractBlock, type SessionContractCheck } from './modules/agent-sessions'
import fs from 'fs'
import path from 'path'
import { CHECKPOINTS } from './setup-manager'
import { getBundledCoreRoot } from './bundled-core'
import { getCoreRuntimeStatus } from './core-runtime'
import { binaryOnPathAsync, runProbeCommand, WHICH_TIMEOUT_MS } from './binary-probe'

// Windows has no `which`; probe PATH via `where` instead.
const WHICH_CMD = process.platform === 'win32' ? 'where' : 'which'

/** Paired development target; older supported contracts (5.1) remain compatible. */
export const EXPECTED_CORE_CONTRACT_SCHEMA_VERSION = '5.16'

// These must mirror KNOWN_VERBS in cli/specrails-desktop.ts
const DESKTOP_KNOWN_COMMANDS = new Set([
  'implement',
  'retry',
])
// Commands older Cores still ship that Desktop no longer invokes. They are
// tolerated (not drift) but never required: Batch was folded into implement.
const DESKTOP_TOLERATED_LEGACY_COMMANDS = new Set(['batch-implement'])
// Checkpoints that contract 5.1 still declares but Desktop retired: role agents
// are runtime-defined since contract 5.2, so `agent_generation` is tolerated
// (not drift) and never required.
const DESKTOP_TOLERATED_LEGACY_CHECKPOINTS = new Set(['agent_generation'])

// v1.0: cli.initArgs / cli.updateArgs (flat); checkpoints/commands as string[]
// v2.0: cli.claude / cli.codex (per-provider objects) + specrailsDir
// v3.0: providers/modelPresets/legacyCompat top-level; checkpoints is now an
//       object (key â description); `commands` field dropped from the contract
// v4.0: deterministic init/update lifecycle, provider workflows and local runtime;
//       removed enrichment is no longer required to prove provider support.
// v5.1: additive engine, nodeKinds and builtins descriptors are informational;
//       execution features are gated by runtime api capabilities.
// v5.2: the `agent_generation` checkpoint is removed (role agents are
//       runtime-defined, no `sr-*` files); `configSchema.agents` is optional.
interface IntegrationContract {
  schemaVersion: string
  agentRuntime?: { sessions?: SessionContractBlock }
  lifecycle?: { mode?: string; requiresEnrich?: boolean }
  coreVersion?: string
  // Legacy field name frozen in the external specrails-core contract file —
  // do not rename (specrails-core wire compat).
  minimumHubVersion?: string
  provider?: string
  cli?: {
    initArgs?: string[]
    updateArgs?: string[]
    claude?: { binary: string; initArgs: string[] }
    codex?: { binary: string; initArgs: string[] }
    tui?: { binary: string; initArgs: string[] }
  }
  specrailsDir?: { claude: string; codex: string }
  tiers?: ('quick' | 'full')[]
  configSchema?: {
    path: string
    schema?: string
  }
  // v1/v2: string[]; v3: { [key: string]: string }
  checkpoints: string[] | Record<string, string>
  // v1/v2 only â absent in v3
  commands?: string[]
  ticketProvider?: {
    type: string
    storagePath: string
    capabilities: string[]
  }
  providers?: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/**
 * A provider key alone is not proof that Core can render or launch it. Require
 * the common workflow surface and, for Kimi, the managed materialization runner
 * that Desktop depends on for every headless Core command.
 */
function isRenderedProviderContract(provider: string, value: unknown): boolean {
  if (!isRecord(value)) return false
  // Core 5 has a deterministic installer. Enrichment no longer exists and is
  // therefore not evidence of provider availability on this contract shape.
  // Core 6 (contract 5.0) dropped the standalone `update` command: Desktop
  // refreshes installs through init and the offline framework lifecycle.
  if (value.initCommand === 'init' && (value.updateCommand === undefined || value.updateCommand === 'update')) {
    if (!isRecord(value.cli) || !isRecord(value.workflows)) return false
    if (!isStringArray(value.cli.initArgs) || !value.cli.initArgs.includes('init')) return false
    if (value.updateCommand === 'update' && (!isStringArray(value.cli.updateArgs) || !value.cli.updateArgs.includes('update'))) return false
    const workflows = value.workflows
    if (!['implement', 'retry'].every(name => typeof workflows[name] === 'string' && workflows[name])) return false
    return provider !== 'kimi' || (value.cli.providerBinary === 'kimi'
      && value.cli.skillRunner === '.kimi-code/specrails/run-skill.mjs'
      && isStringArray(value.cli.workflowArgs) && value.cli.workflowArgs.includes(value.cli.skillRunner))
  }
  if (
    typeof value.enrichCommand !== 'string' ||
    value.enrichCommand.length === 0 ||
    !isStringArray(value.enrichArgs) ||
    typeof value.updateCommand !== 'string' ||
    value.updateCommand.length === 0 ||
    !isStringArray(value.updateArgs) ||
    !isRecord(value.cli)
  ) {
    return false
  }

  if (provider !== 'kimi') return true

  const cli = value.cli
  const skillRunner = cli.skillRunner
  return cli.providerBinary === 'kimi' &&
    typeof skillRunner === 'string' &&
    skillRunner === '.kimi-code/specrails/run-skill.mjs' &&
    isStringArray(cli.enrichArgs) &&
    cli.enrichArgs.includes(skillRunner)
}

export interface CoreCompatResult {
  compatible: boolean
  coreVersion: string | null
  desktopVersion: string
  missingCheckpoints: string[]
  extraCheckpoints: string[]
  missingCommands: string[]
  extraCommands: string[]
  contractFound: boolean
  contractSchemaVersion?: string
  supportedProviders: string[]
  /** Agent session host contract (optional capability; never makes the pair incompatible). */
  sessions?: SessionContractCheck | null
}

export async function findCoreContract(): Promise<string | null> {
  const selected = getCoreRuntimeStatus()
  if (selected.runtime) {
    const contract = path.join(selected.runtime.root, 'integration-contract.json')
    return fs.existsSync(contract) ? contract : null
  }
  // A broken selected runtime must not advertise a different package's contract.
  if (selected.error) return null
  // Strategy 1: the packaged Desktop's bundled Core is authoritative.
  const bundledRoot = getBundledCoreRoot()
  if (bundledRoot) {
    const contractPath = path.join(bundledRoot, 'integration-contract.json')
    if (fs.existsSync(contractPath)) return contractPath
  }

  // Strategy 2: Try require.resolve (works for local installs)
  try {
    const contractPath = require.resolve('specrails-core/integration-contract.json')
    if (fs.existsSync(contractPath)) return contractPath
  } catch { /* not locally installed */ }

  // Strategy 3: npm root -g (async, bounded, memoized — see globalNpmRoot)
  const globalRoot = await globalNpmRoot()
  if (globalRoot) {
    const contractPath = path.join(globalRoot, 'specrails-core', 'integration-contract.json')
    if (fs.existsSync(contractPath)) return contractPath
  }

  return null
}

// `npm root -g` boots npm (~0.3–1 s) and used to run through execSync with no
// timeout on every checkCoreCompat() — i.e. inside every provider detection
// cycle that saw Kimi. The global prefix practically never changes while the
// app runs, so resolve it off the event loop, bounded, and memoize it (a
// failure is memoized too; both expire after the TTL).
const NPM_ROOT_TIMEOUT_MS = 10_000
const NPM_ROOT_TTL_MS = 10 * 60_000
let _npmRoot: { at: number; value: Promise<string | null> } | null = null

function globalNpmRoot(): Promise<string | null> {
  const now = Date.now()
  if (_npmRoot && now - _npmRoot.at < NPM_ROOT_TTL_MS) return _npmRoot.value
  const value = runProbeCommand('npm root -g', { timeout: NPM_ROOT_TIMEOUT_MS })
    .then((out) => out || null)
    .catch(() => null /* npm not available or failed */)
  _npmRoot = { at: now, value }
  return value
}

/** Test-only: forget the memoized `npm root -g`. */
export function _resetGlobalNpmRootForTests(): void {
  _npmRoot = null
}

// âââ CLI detection ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

// Importing the providers barrel registers every bundled adapter so the
// detection helpers below walk the registry instead of hardcoding provider
// ids. Detection order follows registration order (claude first, codex
// second today) so behaviour is unchanged for existing callers that take
// the first non-null result.
import { listAdapters } from './providers'

export type CLIProvider = string

/**
 * Synchronously detect the first AI CLI available in the user's PATH.
 * Detection order is the registry order; today that means Claude before
 * Codex. Returns null if no registered provider's CLI is found.
 */
export function detectCLISync(): CLIProvider | null {
  for (const adapter of listAdapters()) {
    try {
      execSync(`${WHICH_CMD} ${adapter.binary}`, { stdio: 'ignore', timeout: WHICH_TIMEOUT_MS })
      return adapter.id
    } catch { /* keep looking */ }
  }
  return null
}

/**
 * Check which AI CLIs are available in the user's PATH. Returns a map of
 * provider id â available flag, one entry per registered adapter.
 */
export function detectAvailableCLIs(): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const adapter of listAdapters()) {
    try {
      execSync(`${WHICH_CMD} ${adapter.binary}`, { stdio: 'ignore', timeout: WHICH_TIMEOUT_MS })
      out[adapter.id] = true
    } catch {
      out[adapter.id] = false
    }
  }
  return out
}

/**
 * Non-blocking detectAvailableCLIs: the same PATH probe (`which`/`where`),
 * run as concurrent child processes so request handlers never stall the
 * event loop while it resolves.
 */
export async function detectAvailableCLIsAsync(): Promise<Record<string, boolean>> {
  const adapters = listAdapters()
  const found = await Promise.all(adapters.map((adapter) => new Promise<boolean>((resolve) => {
    execFile(WHICH_CMD, [adapter.binary], { windowsHide: true, timeout: 5000 }, (error) => resolve(!error))
  })))
  return Object.fromEntries(adapters.map((adapter, index) => [adapter.id, found[index]]))
}

/**
 * Async wrapper around detectCLISync for callers that prefer Promise-based API.
 */
export async function detectCLI(): Promise<CLIProvider | null> {
  return detectCLISync()
}

export interface CLIStatus {
  provider: CLIProvider | null
  version: string | null
}

/**
 * Detect the active CLI (first registered adapter on PATH) and its version.
 * Non-blocking: the PATH lookups share binaryOnPath's memo and the version
 * probe is a bounded async child (it used to freeze the server per request).
 */
export async function getCLIStatus(): Promise<CLIStatus> {
  let adapter: (ReturnType<typeof listAdapters>)[number] | undefined
  for (const candidate of listAdapters()) {
    if (await binaryOnPathAsync(candidate.binary)) { adapter = candidate; break }
  }
  if (!adapter) return { provider: null, version: null }
  const provider = adapter.id

  try {
    // Use the registry's binary name rather than the provider id (they match
    // for claude/codex but future providers MAY split them).
    const raw = await runProbeCommand(`${adapter.binary} --version`, { timeout: 3000 })
    // Extract semver-like token from output (e.g. "Claude Code 1.2.3" â "1.2.3")
    const match = raw.match(/\d+\.\d+\.\d+[\w.-]*/)
    return { provider, version: match ? match[0] : raw }
  } catch {
    return { provider, version: null }
  }
}

/** The running app's version (its package.json), or 'unknown'. */
export function readDesktopVersion(): string {
  // __dirname is server/ in dev (tsx) or server/dist/ when compiled
  const candidates = [
    path.join(__dirname, '..', 'package.json'),       // from server/ (dev)
    path.join(__dirname, '..', '..', 'package.json'), // from server/dist/ (compiled)
  ]
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(p, 'utf-8')) as { name?: string; version?: string }
      if (pkg.name === 'specrails-desktop' && pkg.version) return pkg.version
    } catch { /* skip */ }
  }
  return 'unknown'
}

export async function checkCoreCompat(): Promise<CoreCompatResult> {
  const desktopVersion = readDesktopVersion()
  const contractPath = await findCoreContract()

  if (!contractPath) {
    return {
      compatible: true,
      coreVersion: null,
      desktopVersion,
      missingCheckpoints: [],
      extraCheckpoints: [],
      missingCommands: [],
      extraCommands: [],
      contractFound: false,
      supportedProviders: [],
    }
  }

  const contract: IntegrationContract = JSON.parse(fs.readFileSync(contractPath, 'utf-8'))
  const supportedProviders =
    contract.providers && typeof contract.providers === 'object'
      ? Object.entries(contract.providers)
          .filter(([provider, providerContract]) =>
            isRenderedProviderContract(provider, providerContract),
          )
          .map(([provider]) => provider)
      : []

  const desktopCheckpointKeys = CHECKPOINTS.map((cp) => cp.key)
  // v1/v2 store checkpoints as a string[]; v3+ stores them as a description map.
  const contractCheckpoints: string[] = Array.isArray(contract.checkpoints)
    ? contract.checkpoints
    : (contract.checkpoints && typeof contract.checkpoints === 'object'
        ? Object.keys(contract.checkpoints)
        : [])

  const missingCheckpoints = contractCheckpoints.filter((c) => !desktopCheckpointKeys.includes(c) && !DESKTOP_TOLERATED_LEGACY_CHECKPOINTS.has(c))
  const deterministic = contract.lifecycle?.mode === 'deterministic' && contract.lifecycle.requiresEnrich === false
  // Supporting legacy installation checkpoints is compatible with Core 5;
  // demanding them from a deterministic installer would recreate enrich.
  const extraCheckpoints = deterministic ? [] : desktopCheckpointKeys.filter((k) => !contractCheckpoints.includes(k))

  // v3 dropped the `commands` field from the contract â when absent, the
  // command-set check is a no-op (cannot prove drift either way).
  const contractCommands: string[] = Array.isArray(contract.commands) ? contract.commands : []
  const missingCommands = contractCommands.filter((c) => !DESKTOP_KNOWN_COMMANDS.has(c) && !DESKTOP_TOLERATED_LEGACY_COMMANDS.has(c))
  const extraCommands = contract.commands === undefined
    ? []
    : [...DESKTOP_KNOWN_COMMANDS].filter((c) => !contractCommands.includes(c))

  const compatible =
    missingCheckpoints.length === 0 &&
    extraCheckpoints.length === 0 &&
    missingCommands.length === 0 &&
    extraCommands.length === 0

  return {
    compatible,
    coreVersion: contract.coreVersion ?? readCoreVersionNear(contractPath),
    desktopVersion,
    missingCheckpoints,
    extraCheckpoints,
    missingCommands,
    extraCommands,
    contractFound: true,
    contractSchemaVersion: contract.schemaVersion,
    supportedProviders,
    sessions: contract.agentRuntime?.sessions ? checkSessionContract(contract.agentRuntime.sessions) : null,
  }
}

/** True only when the located Core contract explicitly renders this provider. */
export function coreCompatSupportsProvider(
  result: Pick<CoreCompatResult, 'contractFound' | 'supportedProviders'>,
  provider: string,
): boolean {
  return result.contractFound &&
    Array.isArray(result.supportedProviders) &&
    result.supportedProviders.includes(provider)
}

// v3 contracts no longer include `coreVersion` at the top level â fall back
// to reading it from the package.json next to the contract file.
function readCoreVersionNear(contractPath: string): string | null {
  try {
    let dir = path.dirname(contractPath)
    for (let i = 0; i < 4; i++) {
      const pkgPath = path.join(dir, 'package.json')
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { name?: string; version?: string }
        if (pkg.name === 'specrails-core' && pkg.version) return pkg.version
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch { /* ignore */ }
  return null
}
