import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { CHECKPOINTS } from './setup-manager'
import { getBundledCoreRoot } from './bundled-core'

// Windows has no `which`; probe PATH via `where` instead.
const WHICH_CMD = process.platform === 'win32' ? 'where' : 'which'

// These must mirror KNOWN_VERBS in cli/specrails-desktop.ts
const DESKTOP_KNOWN_COMMANDS = new Set([
  'implement',
  'batch-implement',
  'why',
  'product-backlog',
  'update-product-driven-backlog',
  'refactor-recommender',
  'health-check',
  'compat-check',
  'enrich',
])

// v1.0: cli.initArgs / cli.updateArgs (flat); checkpoints/commands as string[]
// v2.0: cli.claude / cli.codex (per-provider objects) + specrailsDir
// v3.0: providers/modelPresets/legacyCompat top-level; checkpoints is now an
//       object (key â description); `commands` field dropped from the contract
interface IntegrationContract {
  schemaVersion: string
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
}

export async function findCoreContract(): Promise<string | null> {
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

  // Strategy 3: npm root -g
  try {
    const globalRoot = execSync('npm root -g', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim()
    const contractPath = path.join(globalRoot, 'specrails-core', 'integration-contract.json')
    if (fs.existsSync(contractPath)) return contractPath
  } catch { /* npm not available or failed */ }

  return null
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
      execSync(`${WHICH_CMD} ${adapter.binary}`, { stdio: 'ignore' })
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
      execSync(`${WHICH_CMD} ${adapter.binary}`, { stdio: 'ignore' })
      out[adapter.id] = true
    } catch {
      out[adapter.id] = false
    }
  }
  return out
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
 * Detect the active CLI and its version.
 */
export function getCLIStatus(): CLIStatus {
  const provider = detectCLISync()
  if (!provider) return { provider: null, version: null }

  try {
    const versionFlag = '--version'
    // Look up the binary name from the registry rather than using the
    // provider id as the binary (they happen to match for claude/codex but
    // future providers MAY split them).
    const adapter = listAdapters().find((a) => a.id === provider)
    const binary = adapter?.binary ?? provider
    const raw = execSync(`${binary} ${versionFlag}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim()
    // Extract semver-like token from output (e.g. "Claude Code 1.2.3" â "1.2.3")
    const match = raw.match(/\d+\.\d+\.\d+[\w.-]*/)
    return { provider, version: match ? match[0] : raw }
  } catch {
    return { provider, version: null }
  }
}

function readDesktopVersion(): string {
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

  const missingCheckpoints = contractCheckpoints.filter((c) => !desktopCheckpointKeys.includes(c))
  const extraCheckpoints = desktopCheckpointKeys.filter((k) => !contractCheckpoints.includes(k))

  // v3 dropped the `commands` field from the contract â when absent, the
  // command-set check is a no-op (cannot prove drift either way).
  const contractCommands: string[] = Array.isArray(contract.commands) ? contract.commands : []
  const missingCommands = contractCommands.filter((c) => !DESKTOP_KNOWN_COMMANDS.has(c))
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
