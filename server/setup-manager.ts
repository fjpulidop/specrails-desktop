import { spawn, spawnSync, ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { existsSync, readdirSync, rmSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'fs'
import { isAbsolute, join, resolve as resolvePath } from 'path'
import { tmpdir } from 'os'
import treeKill from 'tree-kill'
import type { WsMessage } from './types'
import { findCoreContract, detectCLISync, CLIProvider } from './core-compat'
import { spawnAiCli } from './util/cli-prompt'
import { spawnCli } from './util/win-spawn'
import { formatMissingSetupPrerequisites } from './setup-prerequisites'
import { CORE_PACKAGE_SPEC } from './core-package'
import { getAdapter } from './providers'
import type { ProviderAdapter, SpawnAction, ProviderId } from './providers/types'

/**
 * specrails-core's installer (Node-native from v4.2.0 onward, bash
 * prior) always scaffolds into `.claude/` regardless of which AI
 * CLI the project uses. The provider choice affects which binary
 * runs (claude vs codex), not where the framework files live.
 */
const SPECRAILS_DIR = '.claude'

// ─── specrails-core binary resolution ────────────────────────────────────────
// Default: npx CORE_PACKAGE_SPEC (major-pinned range, see core-package.ts)
// Override: set SPECRAILS_CORE_BIN to use a local/linked version, e.g.
//   SPECRAILS_CORE_BIN=specrails-core npm run dev

const WHICH_CMD = process.platform === 'win32' ? 'where' : 'which'

function resolveCoreBinary(bin: string): string {
  if (isAbsolute(bin)) return bin
  if (bin.includes('/') || bin.includes('\\')) return resolvePath(bin)

  const result = spawnSync(WHICH_CMD, [bin], {
    env: process.env,
    shell: process.platform === 'win32',
    encoding: 'utf-8',
    timeout: 5_000,
  })
  if (result.error || (result.status ?? 1) !== 0) return bin

  const first = `${result.stdout ?? ''}`.trim().split(/\r?\n/)[0]?.trim()
  return first && first.length > 0 ? first : bin
}

function getCoreCommand(): { bin: string; pkg: string } {
  const override = process.env.SPECRAILS_CORE_BIN
  if (override) {
    return { bin: resolveCoreBinary(override), pkg: '' }
  }
  return { bin: 'npx', pkg: CORE_PACKAGE_SPEC }
}

function buildCoreArgs(args: string[]): { bin: string; fullArgs: string[] } {
  const { bin, pkg } = getCoreCommand()
  const fullArgs = pkg ? ['--yes', '--prefer-online', pkg, ...args] : args
  return { bin, fullArgs }
}

function spawnCoreInit(args: string[], cwd: string): ChildProcess {
  const { bin, fullArgs } = buildCoreArgs(['init', ...args])
  console.log(`[SetupManager] spawning core: ${bin} ${fullArgs.join(' ')} (cwd=${cwd}) (SPECRAILS_CORE_BIN=${process.env.SPECRAILS_CORE_BIN ?? '<unset>'})`)
  // M15: use the cross-spawn wrapper instead of `spawn(..., { shell: win32 })`.
  // With shell:true, Node concatenates the argv into one cmd.exe command line and
  // does NOT quote individual args, so `--from-config C:\Users\John Doe\...yaml`
  // (and `--root-dir <path with spaces>`) split on the space and break install on
  // any Windows account/project path containing a space. cross-spawn resolves the
  // .cmd shim AND quotes each arg, so spaces (and newlines) survive intact.
  return spawnCli(bin, fullArgs, {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

// H19: hard cap on the runtime probe. `npx --yes --prefer-online
// <CORE_PACKAGE_SPEC> version` does a network round-trip to the npm
// registry, and spawnSync blocks the single event loop — without a timeout a
// hung network froze the WHOLE app indefinitely during Add Project. On
// timeout the probe degrades to ok:false, which the install paths surface as
// a setup_error instead of hanging.
const CORE_PROBE_TIMEOUT_MS = 60_000

function probeCoreRuntimeVersion(cwd: string): { ok: boolean; bin: string; version?: string; error?: string } {
  const { bin, fullArgs } = buildCoreArgs(['version'])
  const result = spawnSync(bin, fullArgs, {
    cwd,
    env: process.env,
    shell: process.platform === 'win32',
    encoding: 'utf-8',
    timeout: CORE_PROBE_TIMEOUT_MS,
  })

  if (result.error) {
    const timedOut = (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
    return {
      ok: false,
      bin,
      error: timedOut
        ? `probe timed out after ${CORE_PROBE_TIMEOUT_MS / 1000}s — npm registry unreachable?`
        : result.error.message,
    }
  }
  if ((result.status ?? 1) !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : ''
    const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : ''
    return { ok: false, bin, error: stderr || stdout || `exit code ${result.status ?? 'unknown'}` }
  }

  const output = `${result.stdout ?? ''}`.trim()
  const match = output.match(/\d+\.\d+\.\d+/)
  if (!match) {
    return { ok: false, bin, error: `could not parse version from output: ${output}` }
  }

  return { ok: true, bin, version: match[0] }
}

// ─── YAML helpers ─────────────────────────────────────────────────────────────

function writeSpawnInstallConfig(projectId: string, yamlText: string): string {
  const tmpDir = tmpdir()
  const tempPath = join(tmpDir, `specrails-desktop-install-config-${projectId}-${Date.now()}.yaml`)
  writeFileSync(tempPath, yamlText, 'utf-8')
  return tempPath
}

// ─── Install config reader ───────────────────────────────────────────────────

interface InstallConfigParsed {
  tier: 'quick' | 'full'
  selectedAgents: string[]
}

function readInstallConfig(projectPath: string): InstallConfigParsed | null {
  const configPath = join(projectPath, '.specrails', 'install-config.yaml')
  try {
    const text = readFileSync(configPath, 'utf-8')
    const tierMatch = text.match(/^tier:\s*(\w+)/m)
    const tier = (tierMatch?.[1] === 'quick' ? 'quick' : 'full') as 'quick' | 'full'

    let selectedAgents: string[] = []
    // Inline format: selected: [a, b, c]
    const inlineMatch = text.match(/selected:\s*\[([^\]]*)\]/)
    if (inlineMatch) {
      selectedAgents = inlineMatch[1].split(',').map((s) => s.trim()).filter(Boolean)
    } else {
      // Multi-line format: selected:\n    - a\n    - b
      const multilineMatch = text.match(/selected:\s*\n((?:\s+-\s+\S+\n?)+)/)
      if (multilineMatch) {
        selectedAgents = multilineMatch[1].match(/- (\S+)/g)?.map((m) => m.replace('- ', '')) ?? []
      }
    }
    return { tier, selectedAgents }
  } catch {
    return null
  }
}

// ─── Template deployment (post-install) ──────────────────────────────────────

function deployTemplates(projectPath: string, selectedAgents: string[]): { agents: number; commands: number; personas: number } {
  const templatesDir = join(projectPath, '.specrails', 'setup-templates')
  const targetDir = join(projectPath, SPECRAILS_DIR)
  let agents = 0, commands = 0, personas = 0

  // Deploy selected agent templates
  const agentTemplatesDir = join(templatesDir, 'agents')
  const agentTargetDir = join(targetDir, 'agents')
  if (existsSync(agentTemplatesDir)) {
    mkdirSync(agentTargetDir, { recursive: true })
    for (const file of readdirSync(agentTemplatesDir) as string[]) {
      if (!file.endsWith('.md')) continue
      const agentId = file.replace(/\.md$/, '')
      if (selectedAgents.length > 0 && !selectedAgents.includes(agentId)) continue
      copyFileSync(join(agentTemplatesDir, file), join(agentTargetDir, file))
      agents++
    }
  }

  // Deploy persona templates
  const personaTemplatesDir = join(templatesDir, 'personas')
  const personaTargetDir = join(agentTargetDir, 'personas')
  if (existsSync(personaTemplatesDir)) {
    mkdirSync(personaTargetDir, { recursive: true })
    for (const file of readdirSync(personaTemplatesDir) as string[]) {
      if (!file.endsWith('.md')) continue
      copyFileSync(join(personaTemplatesDir, file), join(personaTargetDir, file))
      personas++
    }
  }

  // Deploy command templates
  const cmdTemplatesDir = join(templatesDir, 'commands', 'specrails')
  const cmdTargetDir = join(targetDir, 'commands', 'specrails')
  if (existsSync(cmdTemplatesDir)) {
    mkdirSync(cmdTargetDir, { recursive: true })
    for (const file of readdirSync(cmdTemplatesDir) as string[]) {
      if (!file.endsWith('.md')) continue
      copyFileSync(join(cmdTemplatesDir, file), join(cmdTargetDir, file))
      commands++
    }
  }

  return { agents, commands, personas }
}

// ─── Checkpoint definitions ───────────────────────────────────────────────────

export interface CheckpointDefinition {
  key: string
  name: string
}

// Full install: 7-phase enrichment flow (claude /specrails:enrich)
export const CHECKPOINTS: CheckpointDefinition[] = [
  { key: 'base_install', name: 'Base installation' },
  { key: 'repo_analysis', name: 'Repository analysis' },
  { key: 'stack_conventions', name: 'Stack & conventions' },
  { key: 'product_discovery', name: 'Product discovery' },
  { key: 'agent_generation', name: 'Agent generation' },
  { key: 'command_config', name: 'Command configuration' },
  { key: 'final_verification', name: 'Final verification' },
]

// Quick install: 3-phase non-interactive flow (npx init --from-config)
export const QUICK_CHECKPOINTS: CheckpointDefinition[] = [
  { key: 'config_written', name: 'Config written' },
  { key: 'base_install', name: 'Base installation' },
  { key: 'quick_complete', name: 'Quick install complete' },
]

export type InstallTier = 'quick' | 'full'

// ─── Checkpoint filesystem checks ─────────────────────────────────────────────

export interface CheckpointStatus {
  key: string
  name: string
  status: 'pending' | 'running' | 'done'
  detail?: string
  duration_ms?: number
}

function checkFilesystem(projectPath: string): Partial<Record<string, boolean>> {
  const dir = SPECRAILS_DIR
  const hasBaseInstall = existsSync(join(projectPath, '.specrails', 'specrails-version')) ||
    existsSync(join(projectPath, '.specrails-version'))
  const hasSetupTemplates = existsSync(join(projectPath, '.specrails', 'setup-templates')) ||
    existsSync(join(projectPath, dir, 'setup-templates'))
  const hasRules = existsSync(join(projectPath, dir, 'rules')) &&
    hasFiles(join(projectPath, dir, 'rules'), /\.md$/)
  const hasPersonas = existsSync(join(projectPath, dir, 'agents', 'personas')) &&
    hasFiles(join(projectPath, dir, 'agents', 'personas'), /\.md$/)
  const hasAgents = existsSync(join(projectPath, dir, 'agents')) &&
    hasFiles(join(projectPath, dir, 'agents'), /^sr-.*\.md$/)
  const hasCommands = (
    (existsSync(join(projectPath, dir, 'commands', 'sr')) && hasFiles(join(projectPath, dir, 'commands', 'sr'), /\.md$/)) ||
    (existsSync(join(projectPath, dir, 'commands', 'specrails')) && hasFiles(join(projectPath, dir, 'commands', 'specrails'), /\.md$/))
  )
  const hasCLAUDE = existsSync(join(projectPath, 'CLAUDE.md'))

  return {
    base_install: hasBaseInstall,
    // repo_analysis: detected when setup templates exist and CLAUDE.md is written
    // (Claude writes CLAUDE.md after analyzing the repo)
    repo_analysis: hasBaseInstall && (hasCLAUDE || hasSetupTemplates),
    // stack_conventions: detected when rules files are generated
    stack_conventions: hasRules,
    product_discovery: hasPersonas,
    agent_generation: hasAgents,
    command_config: hasCommands,
    // Final verification: agents + commands must exist (manifest from install.sh is unreliable —
    // it's created during scaffolding before /setup generates the actual artifacts)
    final_verification: hasAgents && hasCommands,
  }
}

function hasFiles(dir: string, pattern: RegExp): boolean {
  try {
    return readdirSync(dir).some((f) => pattern.test(f as string))
  } catch {
    return false
  }
}

// ─── Enrich.md content resolver (shared by start + resume enrich paths) ─────

/**
 * Reads the enrich command's body from the project's specrails dir, falling
 * back across the three known locations:
 *   1. `.claude/commands/sr/enrich.md`        (modern; written by core ≥ 4.2)
 *   2. `.claude/commands/specrails/enrich.md` (legacy; written by core 4.1.x)
 *   3. `.claude/commands/setup.md`            (very legacy; before enrich rename)
 *
 * For codex projects the .codex/skills/<name>/SKILL.md layout is read by the
 * codex CLI directly when the slash command is forwarded — when the legacy
 * codex flow needs the literal content (synthetic-session resume), the same
 * .claude/ paths are consulted because specrails-core scaffolds both trees.
 *
 * Returns an empty string when no file is found; callers fall back to passing
 * the literal slash command and let the CLI surface the missing-command error.
 */
function readEnrichMdContent(projectPath: string): string {
  const enrichMdPathSr = join(projectPath, SPECRAILS_DIR, 'commands', 'sr', 'enrich.md')
  const enrichMdPathSpecrails = join(projectPath, SPECRAILS_DIR, 'commands', 'specrails', 'enrich.md')
  const legacyMdPath = join(projectPath, SPECRAILS_DIR, 'commands', 'setup.md')
  for (const p of [enrichMdPathSr, enrichMdPathSpecrails, legacyMdPath]) {
    try {
      return readFileSync(p, 'utf-8')
    } catch { /* try next */ }
  }
  return ''
}

// ─── Stream-based checkpoint detection ───────────────────────────────────────

export function detectCheckpointFromText(
  text: string
): { key: string; detail?: string }[] {
  const hits: { key: string; detail?: string }[] = []

  // Match phase headers from Claude's /specrails:enrich output (and legacy /setup)
  if (/phase\s*1|codebase\s*analysis|repository\s*analysis/i.test(text)) {
    hits.push({ key: 'repo_analysis', detail: 'Analyzing codebase...' })
  }
  if (/phase\s*2|user\s*personas|product\s*discovery/i.test(text)) {
    hits.push({ key: 'product_discovery', detail: 'Generating personas...' })
  }
  if (/phase\s*3|configuration|agent\s*selection|backlog\s*provider/i.test(text)) {
    hits.push({ key: 'stack_conventions', detail: 'Configuring stack...' })
  }
  if (/generating\s*all\s*files|writing.*agent|sr-architect|sr-developer|sr-reviewer/i.test(text)) {
    hits.push({ key: 'agent_generation', detail: 'Generating agents...' })
  }
  if (/command\s*selection|installing.*commands|\.claude\/commands\/(sr|specrails)/i.test(text)) {
    hits.push({ key: 'command_config', detail: 'Configuring commands...' })
  }

  // TUI output patterns from specrails-core init --from-config.
  // Covers both the retired bash installer (✓ config loaded, reading
  // install-config.yaml) and the Node installer ≥ v4.2.0 (Loaded
  // install config from <path>, Phase 1 / 2 / 3 step headers, final
  // `init complete` sentinel).
  if (/✓\s*config\s*loaded|reading.*install-config|loaded\s*install\s*config|from-config/i.test(text)) {
    hits.push({ key: 'config_written' })
  }
  if (/installing\s*specrails|phase\s*2\s*&\s*3|placing\s*agents/i.test(text)) {
    hits.push({ key: 'agent_generation', detail: 'Installing specrails artefacts...' })
  }
  if (/writing\s*manifest|wrote\s+.*specrails-manifest/i.test(text)) {
    hits.push({ key: 'final_verification' })
  }
  if (/✓\s*installed|installation\s*complete|init\s*complete|update\s*complete/i.test(text)) {
    hits.push({ key: 'quick_complete' })
  }

  // File path detection in tool_use events
  if (text.includes('.specrails-version') || text.includes('specrails/specrails-version')) hits.push({ key: 'base_install' })
  if (text.includes('/agents/personas/') && text.includes('.md')) {
    hits.push({ key: 'product_discovery', detail: 'Writing personas...' })
  }
  // Claude path: .claude/agents/sr-<name>.md
  if (/\/agents\/sr-[^/]+\.md/.test(text)) {
    hits.push({ key: 'agent_generation', detail: 'Writing agents...' })
  }
  // Codex path: .codex/skills/sr-<name>/SKILL.md (rail skills ship in
  // specrails-core 4.6.0+ — see openspec/.../specs/setup-wizard… for the
  // checkpoint protocol shared across providers).
  if (/\.codex\/skills\/sr-[^/]+\/SKILL\.md/.test(text)) {
    hits.push({ key: 'agent_generation', detail: 'Writing agent skills...' })
  }
  if ((text.includes('/commands/sr/') || text.includes('/commands/specrails/')) && text.includes('.md')) {
    hits.push({ key: 'command_config', detail: 'Writing commands...' })
  }
  // Codex enrich/doctor skills (the non-rail commands) also indicate
  // command_config progress.
  if (/\.codex\/skills\/(enrich|doctor)\/SKILL\.md/.test(text)) {
    hits.push({ key: 'command_config', detail: 'Writing codex command skills...' })
  }
  if (text.includes('/rules/') && text.includes('.md')) {
    hits.push({ key: 'stack_conventions', detail: 'Writing conventions...' })
  }
  // Codex sandbox / approval policy lives inside .codex/config.toml
  // (top-level `sandbox_mode` + `approval_policy` keys, per codex
  // 0.128.0+). There is no separate Starlark rules file.
  if (/\.codex\/config\.toml/.test(text)) {
    hits.push({ key: 'stack_conventions', detail: 'Writing codex sandbox config...' })
  }
  if (text.includes('.specrails-manifest.json') || text.includes('specrails/specrails-manifest.json')) {
    hits.push({ key: 'final_verification' })
  }

  return hits
}

// ─── Setup summary computation ────────────────────────────────────────────────

export interface SetupSummary {
  agents: number
  specrailsCommands: number
  opsxCommands: number
  personas: number
  legacySrRemoved: number
  tier: 'quick' | 'full'
  /** Provider used during the install — drives label phrasing on the
   *  completion screen (codex shows "Skills" instead of "/specrails:*",
   *  "OpenSpec" instead of "/opsx:*"). Optional for back-compat with
   *  callers that haven't been updated; defaults to 'claude' on read. */
  provider?: CLIProvider
}

export const EMPTY_SUMMARY: SetupSummary = {
  agents: 0,
  specrailsCommands: 0,
  opsxCommands: 0,
  personas: 0,
  legacySrRemoved: 0,
  tier: 'quick',
  provider: 'claude',
}

const MIN_NODE_NATIVE_CORE_VERSION = '4.1.0'

interface InstallValidationResult {
  ok: boolean
  reasons: string[]
}

function compareSemver(a: string, b: string): number | null {
  const aParts = a.trim().split('.').map((n) => parseInt(n, 10))
  const bParts = b.trim().split('.').map((n) => parseInt(n, 10))
  if (aParts.length < 3 || bParts.length < 3) return null
  if ([...aParts, ...bParts].some((n) => Number.isNaN(n))) return null

  for (let i = 0; i < 3; i++) {
    if (aParts[i]! > bParts[i]!) return 1
    if (aParts[i]! < bParts[i]!) return -1
  }
  return 0
}

export function validateInstalledCore(projectPath: string): InstallValidationResult {
  const reasons: string[] = []

  const versionCandidates = [
    join(projectPath, '.specrails', 'specrails-version'),
    join(projectPath, '.specrails-version'),
  ]

  for (const candidate of versionCandidates) {
    if (!existsSync(candidate)) continue
    try {
      const raw = readFileSync(candidate, 'utf-8').trim()
      const cmp = compareSemver(raw, MIN_NODE_NATIVE_CORE_VERSION)
      if (cmp !== null && cmp < 0) {
        reasons.push(
          `installed specrails-core version ${raw} is older than required ${MIN_NODE_NATIVE_CORE_VERSION}`,
        )
      }
      break
    } catch {
      reasons.push(`failed to read installed specrails-core version from ${candidate}`)
      break
    }
  }

  const legacyMarkers = [
    { path: join(projectPath, '.specrails', 'bin', 'doctor.sh'), reason: 'legacy bash doctor detected' },
    {
      path: join(projectPath, '.specrails', 'setup-templates', 'settings', 'integration-contract.json'),
      reason: 'legacy integration-contract copy detected in setup-templates',
    },
  ]

  for (const marker of legacyMarkers) {
    if (existsSync(marker.path)) reasons.push(marker.reason)
  }

  return { ok: reasons.length === 0, reasons }
}

function formatLegacyInstallError(reasons: string[]): string {
  return [
    'Installed specrails-core is legacy; expected the Node-native installer.',
    '',
    ...reasons.map((reason) => `- ${reason}`),
  ].join('\n')
}

export function computeSummary(
  projectPath: string,
  tier: 'quick' | 'full',
  provider: CLIProvider = 'claude',
): SetupSummary {
  let agents = 0
  let personas = 0
  let specrailsCommands = 0
  let opsxCommands = 0

  try {
    if (provider === 'codex') {
      // Codex layout: every artefact ships as a SKILL under `.codex/skills/`.
      // - agents  = rail personas (`skills/rails/sr-*/SKILL.md`) + orchestrator
      //             skills at the root with an `sr-` prefix (sr-implement,
      //             sr-batch-implement, …)
      // - opsxCommands     = `skills/openspec-*/SKILL.md`
      // - specrailsCommands = everything else under `skills/` (ported claude
      //   slash commands like propose-spec, explore-spec, retry, doctor,
      //   enrich, vpc-drift, …)
      // - personas = 0 today; codex VPC pass not implemented yet.
      const skillsDir = join(projectPath, '.codex', 'skills')
      if (existsSync(skillsDir)) {
        // Rails (always counted as agents).
        const railsDir = join(skillsDir, 'rails')
        if (existsSync(railsDir)) {
          for (const entry of readdirSync(railsDir) as string[]) {
            if (existsSync(join(railsDir, entry, 'SKILL.md'))) agents++
          }
        }
        // Top-level skill dirs.
        for (const entry of readdirSync(skillsDir) as string[]) {
          if (entry === 'rails') continue
          if (!existsSync(join(skillsDir, entry, 'SKILL.md'))) continue
          if (/^sr-/.test(entry)) agents++
          else if (/^openspec-/.test(entry)) opsxCommands++
          else specrailsCommands++
        }
      }
    } else {
      // Claude layout (unchanged).
      const dir = SPECRAILS_DIR
      const agentsDir = join(projectPath, dir, 'agents')
      if (existsSync(agentsDir)) {
        const files = readdirSync(agentsDir) as string[]
        agents = files.filter((f) => /^sr-.*\.md$/.test(f)).length
        const personasDir = join(agentsDir, 'personas')
        if (existsSync(personasDir)) {
          personas = (readdirSync(personasDir) as string[]).filter((f) => f.endsWith('.md')).length
        }
      }
      const commandsDirSpecrails = join(projectPath, dir, 'commands', 'specrails')
      const commandsDirOpsx = join(projectPath, dir, 'commands', 'opsx')
      if (existsSync(commandsDirSpecrails)) {
        specrailsCommands = (readdirSync(commandsDirSpecrails) as string[]).filter((f) => f.endsWith('.md')).length
      }
      if (existsSync(commandsDirOpsx)) {
        opsxCommands = (readdirSync(commandsDirOpsx) as string[]).filter((f) => f.endsWith('.md')).length
      }
    }
  } catch {
    // non-fatal
  }

  return { agents, specrailsCommands, opsxCommands, personas, legacySrRemoved: 0, tier, provider }
}

/**
 * Deletes the deprecated `.claude/commands/sr/` directory (if present) and returns
 * the number of `.md` files that were removed. Safe to call even if the directory
 * does not exist. Never throws — errors are logged at info level.
 */
export function sweepLegacySrCommands(projectPath: string): number {
  const srDir = join(projectPath, SPECRAILS_DIR, 'commands', 'sr')
  try {
    if (!existsSync(srDir)) return 0
    const files = (readdirSync(srDir) as string[]).filter((f) => f.endsWith('.md'))
    const count = files.length
    rmSync(srDir, { recursive: true, force: true })
    console.info(`[SetupManager] Swept ${count} legacy /specrails:* command(s) from ${srDir}`)
    return count
  } catch (err) {
    console.info(`[SetupManager] sweepLegacySrCommands failed (non-fatal): ${err}`)
    return 0
  }
}

// ─── Core contract validation ────────────────────────────────────────────────

async function validateCoreContract(): Promise<void> {
  const contractPath = await findCoreContract()
  if (!contractPath) {
    // specrails-core does not yet ship integration-contract.json (planned in RFC-003).
    // Fall back silently to runtime defaults — Specrails works fine without the contract.
    console.debug('[Specrails] integration-contract.json not found — using runtime defaults')
    return
  }

  let contract: { checkpoints?: string[]; commands?: string[] }
  try {
    const raw = require('fs').readFileSync(contractPath, 'utf-8') as string
    contract = JSON.parse(raw) as { checkpoints?: string[]; commands?: string[] }
  } catch {
    console.debug('[Specrails] integration-contract.json failed to parse — using runtime defaults')
    return
  }

  if (contract.checkpoints) {
    const missingCheckpoints = contract.checkpoints.filter(
      (c) => !CHECKPOINTS.some((cp) => cp.key === c)
    )
    const extraCheckpoints = CHECKPOINTS
      .filter((cp) => !contract.checkpoints!.includes(cp.key))
      .map((cp) => cp.key)

    if (missingCheckpoints.length > 0 || extraCheckpoints.length > 0) {
      console.warn('[Specrails] ⚠️  specrails-core contract checkpoint mismatch:')
      if (missingCheckpoints.length > 0)
        console.warn(`  Checkpoints in Core but not in the app: ${missingCheckpoints.join(', ')}`)
      if (extraCheckpoints.length > 0)
        console.warn(`  Checkpoints in the app but not in Core: ${extraCheckpoints.join(', ')}`)
    }
  }
}

// ─── SetupManager ─────────────────────────────────────────────────────────────

const INSTALL_LOG_BUFFER_MAX = 2000

function formatBufferedInstallError(baseMessage: string, logBuffer: string[]): string {
  const recentLines = logBuffer
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8)

  if (recentLines.length === 0) return baseMessage

  return [
    baseMessage,
    '',
    'Recent output:',
    ...recentLines.map((line) => `- ${line}`),
  ].join('\n')
}

export class SetupManager {
  private _broadcast: (msg: WsMessage) => void
  private _onSessionCaptured?: (projectId: string, sessionId: string) => void
  private _onSetupDone?: (projectId: string) => void
  // Map from projectId → active child processes
  private _installProcesses: Map<string, ChildProcess>
  private _setupProcesses: Map<string, ChildProcess>
  // Track checkpoint states per project
  private _checkpoints: Map<string, Map<string, CheckpointStatus>>
  // Track checkpoint start times
  private _checkpointStart: Map<string, Map<string, number>>
  // Ring buffer for install log lines — allows clients to recover log on reconnect
  private _installLogBuffer: Map<string, string[]>
  // Track each project's chosen AI provider for binary selection
  private _projectProviders: Map<string, CLIProvider>
  // Track each project's install tier (quick vs full)
  private _projectTiers: Map<string, InstallTier>
  // Track project names for codex context header injection
  private _projectNames: Map<string, string>

  constructor(
    broadcast: (msg: WsMessage) => void,
    onSessionCaptured?: (projectId: string, sessionId: string) => void,
    onSetupDone?: (projectId: string) => void
  ) {
    this._broadcast = broadcast
    this._onSessionCaptured = onSessionCaptured
    this._onSetupDone = onSetupDone
    this._installProcesses = new Map()
    this._setupProcesses = new Map()
    this._checkpoints = new Map()
    this._checkpointStart = new Map()
    this._pollTimers = new Map()
    this._installLogBuffer = new Map()
    this._projectProviders = new Map()
    this._projectTiers = new Map()
    this._projectNames = new Map()
  }

  // ─── Full Install: TUI installer (npx specrails-core) ────────────────────────

  startInstall(projectId: string, projectPath: string): void {
    if (this._installProcesses.has(projectId)) {
      console.warn(`[SetupManager] install already running for ${projectId}`)
      return
    }

    const configPath = join(projectPath, '.specrails', 'install-config.yaml')
    const hasConfig = existsSync(configPath)
    const parsedConfig = hasConfig ? readInstallConfig(projectPath) : null
    const tier = parsedConfig?.tier ?? 'full'
    this._projectTiers.set(projectId, tier)
    // Pull provider out of the just-written install-config.yaml so the
    // completion-summary path can label tiles correctly (codex → "Skills"
    // etc.). Without this, summary.provider stays undefined and the client
    // renders the claude labels with 0/0/0 counts because the codex skill
    // walker never gets selected.
    if (hasConfig) {
      try {
        const text = readFileSync(configPath, 'utf-8')
        const m = text.match(/^provider:\s*(\w+)/m)
        if (m && (m[1] === 'claude' || m[1] === 'codex')) {
          this._projectProviders.set(projectId, m[1])
        }
      } catch {
        // Ignore — falls back to claude default downstream.
      }
    }
    this._initCheckpoints(projectId)

    const missingPrerequisites = formatMissingSetupPrerequisites()
    if (missingPrerequisites) {
      this._broadcast({
        type: 'setup_error',
        projectId,
        error: missingPrerequisites,
      })
      return
    }

    const probe = probeCoreRuntimeVersion(projectPath)
    if (!probe.ok) {
      this._broadcast({
        type: 'setup_error',
        projectId,
        error: `Failed to verify specrails-core runtime before install: ${probe.error ?? 'unknown error'}`,
      })
      return
    }
    console.log(`[SetupManager] core runtime probe: ${probe.bin} -> ${probe.version}`)
    const probeCmp = compareSemver(probe.version!, MIN_NODE_NATIVE_CORE_VERSION)
    if (probeCmp !== null && probeCmp < 0) {
      this._broadcast({
        type: 'setup_error',
        projectId,
        error:
          `Resolved specrails-core@${probe.version} is legacy; expected Node-native >= ${MIN_NODE_NATIVE_CORE_VERSION}.`,
      })
      return
    }

    let spawnConfigPath: string | null = null
    if (hasConfig) {
      try {
        spawnConfigPath = writeSpawnInstallConfig(projectId, readFileSync(configPath, 'utf-8'))
      } catch (err) {
        console.warn(`[SetupManager] Failed to write temp install-config.yaml: ${err}`)
      }
    }

    const initArgs = hasConfig
      ? ['--yes', '--from-config', spawnConfigPath ?? configPath]
      : ['--yes', '--root-dir', projectPath]

    const child = spawnCoreInit(initArgs, projectPath)

    this._installProcesses.set(projectId, child)
    this._installLogBuffer.set(projectId, [])

    // spawnCoreInit uses shell:false on POSIX, so a spawn failure emits 'error'
    // (and NOT 'close') — without this handler the temp config file leaks and
    // the unhandled 'error' event would crash the app.
    /* c8 ignore start -- spawn-failure path; exercised manually, not in CI */
    child.on('error', (err) => {
      console.error(`[SetupManager] core spawn failed for ${projectId}: ${err.message}`)
      this._installProcesses.delete(projectId)
      if (spawnConfigPath) {
        try { rmSync(spawnConfigPath, { force: true }) } catch { /* non-fatal */ }
      }
      this._broadcast({
        type: 'setup_error',
        projectId,
        error: `Failed to launch specrails-core: ${err.message}`,
      })
    })
    /* c8 ignore stop */

    const stdoutReader = createInterface({ input: child.stdout!, crlfDelay: Infinity })
    const stderrReader = createInterface({ input: child.stderr!, crlfDelay: Infinity })

    const appendLog = (line: string) => {
      const buf = this._installLogBuffer.get(projectId) ?? []
      buf.push(line)
      if (buf.length > INSTALL_LOG_BUFFER_MAX) buf.splice(0, buf.length - INSTALL_LOG_BUFFER_MAX)
      this._installLogBuffer.set(projectId, buf)
    }

    stdoutReader.on('line', (line) => {
      appendLog(line)
      this._broadcast({ type: 'setup_log', projectId, line, stream: 'stdout' })
      const hits = detectCheckpointFromText(line)
      for (const hit of hits) {
        this._advanceCheckpoint(projectId, hit.key, hit.detail)
      }
    })

    stderrReader.on('line', (line) => {
      appendLog(line)
      this._broadcast({ type: 'setup_log', projectId, line, stream: 'stderr' })
    })

    child.on('close', (code) => {
      if (spawnConfigPath) {
        try { rmSync(spawnConfigPath, { force: true }) } catch { /* non-fatal */ }
      }
      this._installProcesses.delete(projectId)
      if (code === 0) {
        const validation = validateInstalledCore(projectPath)
        if (!validation.ok) {
          this._broadcast({
            type: 'setup_error',
            projectId,
            error: formatLegacyInstallError(validation.reasons),
          })
          return
        }
        this._advanceCheckpoint(projectId, 'base_install')
        this._completeCheckpoint(projectId, 'base_install')
        const legacySrRemoved = sweepLegacySrCommands(projectPath)
        const summary: SetupSummary = { ...computeSummary(projectPath, tier, this._projectProviders.get(projectId) ?? 'claude'), legacySrRemoved }
        this._broadcast({
          type: 'setup_install_done',
          projectId,
          timestamp: new Date().toISOString(),
          summary,
        })
        validateCoreContract().catch(() => { /* non-fatal */ })
      } else {
        const logBuffer = this._installLogBuffer.get(projectId) ?? []
        this._broadcast({
          type: 'setup_error',
          projectId,
          error: formatBufferedInstallError(
            `npx specrails-core exited with code ${code ?? 'unknown'}`,
            logBuffer,
          ),
        })
      }
    })
  }

  // ─── Enrich: claude -p "/specrails:enrich --from-config" ────────────────────

  startEnrich(projectId: string, projectPath: string, provider?: ProviderId, projectName?: string): void {
    if (this._setupProcesses.has(projectId)) {
      console.warn(`[SetupManager] enrich already running for ${projectId}`)
      return
    }

    if (provider) this._projectProviders.set(projectId, provider)
    if (projectName) this._projectNames.set(projectId, projectName)
    this._projectTiers.set(projectId, 'full')

    this._initCheckpoints(projectId)

    // Pre-create the directory structure that /specrails:enrich will write to.
    // Claude Code's Write tool does not create parent directories automatically —
    // if a target directory doesn't exist the write fails and Claude reports a
    // misleading "write permissions aren't enabled" error.  Creating the dirs
    // here ensures enrich runs transparently without any user intervention.
    try {
      mkdirSync(join(projectPath, SPECRAILS_DIR, 'agents', 'personas'), { recursive: true })
      mkdirSync(join(projectPath, SPECRAILS_DIR, 'commands', 'sr'), { recursive: true })
      mkdirSync(join(projectPath, SPECRAILS_DIR, 'commands', 'specrails'), { recursive: true })
      mkdirSync(join(projectPath, SPECRAILS_DIR, 'rules'), { recursive: true })
    } catch (err) {
      console.warn(`[SetupManager] Failed to pre-create enrich directories: ${err}`)
    }

    const configPath = join(projectPath, '.specrails', 'install-config.yaml')
    const hasConfig = existsSync(configPath)
    const enrichCmd = hasConfig ? '/specrails:enrich --from-config' : '/specrails:enrich'

    this._spawnSetupWithAdapter(projectId, projectPath, {
      action: 'setup-enrich',
      prompt: enrichCmd,
      provider,
    })
  }

  /** @deprecated Use startEnrich() instead */
  startSetup(projectId: string, projectPath: string, provider?: ProviderId): void {
    return this.startEnrich(projectId, projectPath, provider)
  }

  resumeEnrich(projectId: string, projectPath: string, sessionId: string, userMessage: string, provider?: ProviderId): void {
    if (this._setupProcesses.has(projectId)) {
      console.warn(`[SetupManager] enrich already running for ${projectId}`)
      return
    }

    if (provider) this._projectProviders.set(projectId, provider)

    const resolvedProvider = (provider ?? this._projectProviders.get(projectId)) as ProviderId | undefined
    const adapter = getAdapter(resolvedProvider ?? 'claude')

    // Synthetic codex session ids (from before §10) can't be resumed against
    // a real codex thread — detect and fall back to a fresh enrich respawn
    // that folds enrich.md content + the user reply, matching the legacy UX.
    const isSyntheticSession = sessionId.startsWith('codex-') && !/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(sessionId)

    if (adapter.id === 'codex' && isSyntheticSession) {
      const enrichContent = readEnrichMdContent(projectPath)
      const prompt = enrichContent
        ? `${enrichContent}\n\n---\nIMPORTANT: This is a continuation of a previous enrich run. Check which artifacts already exist in the project before regenerating anything. The user responded to your question with:\n\n${userMessage}`
        : userMessage
      this._spawnSetupWithAdapter(projectId, projectPath, {
        action: 'setup-enrich',
        prompt,
        provider: resolvedProvider,
      })
      return
    }

    // Modern path: real session id (claude or post-§10 codex) — use the
    // adapter's resume action.
    this._spawnSetupWithAdapter(projectId, projectPath, {
      action: 'setup-enrich-resume',
      prompt: userMessage,
      sessionId,
      provider: resolvedProvider,
    })
  }

  /** @deprecated Use resumeEnrich() instead */
  resumeSetup(projectId: string, projectPath: string, sessionId: string, userMessage: string, provider?: ProviderId): void {
    return this.resumeEnrich(projectId, projectPath, sessionId, userMessage, provider)
  }

  // Active filesystem poll timers per project
  private _pollTimers: Map<string, ReturnType<typeof setInterval>>

  private _startFilesystemPoll(projectId: string, projectPath: string): void {
    this._stopFilesystemPoll(projectId)
    const timer = setInterval(() => {
      this._syncFilesystemCheckpoints(projectId, projectPath)
    }, 3000)
    this._pollTimers.set(projectId, timer)
  }

  private _stopFilesystemPoll(projectId: string): void {
    const timer = this._pollTimers.get(projectId)
    if (timer) {
      clearInterval(timer)
      this._pollTimers.delete(projectId)
    }
  }

  /**
   * Adapter-driven enrich spawn. Provider-aware prompt resolution
   * (slash command for claude vs file-content fold for codex), real
   * thread_id capture from `session-started` events (no more synthetic
   * `codex-<id>-<ts>` ids), uniform stream parsing via
   * `adapter.parseStreamLine`.
   */
  private _spawnSetupWithAdapter(
    projectId: string,
    projectPath: string,
    opts: {
      action: 'setup-enrich' | 'setup-enrich-resume'
      prompt: string
      sessionId?: string
      provider?: ProviderId
    },
  ): void {
    const resolvedProvider = opts.provider ?? detectCLISync()
    if (resolvedProvider === null) {
      console.warn('[SetupManager] No AI CLI detected. Falling back to claude.')
    }
    const adapter: ProviderAdapter = getAdapter(resolvedProvider ?? 'claude')

    // Provider-aware prompt resolution:
    //   - claude: pass the slash command unresolved so the CLI looks up
    //     `.claude/commands/specrails/enrich.md` natively. Honours the
    //     skills-resolution priority over CLAUDE.md.
    //   - codex: no slash-command support; fold the enrich.md content into
    //     the prompt with the PROJECT context header so codex knows the cwd.
    let effectivePrompt = opts.prompt
    if (
      !adapter.capabilities.systemPromptArg &&
      (opts.prompt === '/specrails:enrich' || opts.prompt === '/specrails:enrich --from-config')
    ) {
      const enrichContent = readEnrichMdContent(projectPath)
      if (enrichContent) {
        const projectName = this._projectNames.get(projectId)
        effectivePrompt = projectName
          ? `PROJECT: ${projectName}\nCWD: ${projectPath}\n\n---\n\n${enrichContent}`
          : enrichContent
      } else {
        console.warn(`[SetupManager] Could not read enrich.md or setup.md — falling back to literal prompt`)
      }
    }

    const args = adapter.buildArgs(opts.action as SpawnAction, {
      prompt: effectivePrompt,
      model: adapter.defaultModel(),
      sessionId: opts.sessionId,
    })

    // No OTEL env injection here — SetupManager spawns drive the initial project
    // setup wizard, not repeatable pipeline jobs. Telemetry is scoped to
    // QueueManager pipeline runs only.
    const child = spawnAiCli(adapter.binary, args, {
      cwd: projectPath,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    this._setupProcesses.set(projectId, child)

    /* c8 ignore start -- spawn-failure path; exercised manually, not in CI */
    child.on('error', (err) => {
      console.error(`[SetupManager] ${adapter.binary} spawn failed for ${projectId}: ${err.message}`)
      this._setupProcesses.delete(projectId)
      this._stopFilesystemPoll(projectId)
      this._broadcast({
        type: 'setup_error',
        projectId,
        error: `Failed to launch ${adapter.binary}: ${err.message}`,
      })
    })
    /* c8 ignore stop */

    // Start periodic filesystem polling for checkpoint detection
    this._startFilesystemPoll(projectId, projectPath)

    let capturedSessionId: string | null = null

    const stdoutReader = createInterface({ input: child.stdout!, crlfDelay: Infinity })
    const stderrReader = createInterface({ input: child.stderr!, crlfDelay: Infinity })

    stdoutReader.on('line', (line) => {
      const ev = adapter.parseStreamLine(line)
      if (!ev) {
        // Non-parseable line — emit as raw log.
        if (line) this._broadcast({ type: 'setup_log', projectId, line, stream: 'stdout' })
        return
      }

      switch (ev.kind) {
        case 'session-started': {
          if (!capturedSessionId) {
            capturedSessionId = ev.sessionId
            this._onSessionCaptured?.(projectId, ev.sessionId)
          }
          break
        }
        case 'text-delta': {
          // Run checkpoint detection over the assistant text and surface it
          // both to the collapsible log viewer and the wizard chat panel.
          this._broadcast({ type: 'setup_log', projectId, line: ev.text, stream: 'stdout' })
          this._broadcast({ type: 'setup_chat', projectId, text: ev.text, role: 'assistant' })
          const hits = detectCheckpointFromText(ev.text)
          for (const hit of hits) {
            this._advanceCheckpoint(projectId, hit.key, hit.detail)
          }
          // Also sync filesystem (cheap mtime/exists checks, see helper).
          this._syncFilesystemCheckpoints(projectId, projectPath)
          break
        }
        case 'tool-use': {
          this._broadcast({ type: 'setup_log', projectId, line: `[tool] ${ev.name}`, stream: 'stdout' })
          // Tool inputs commonly mention the paths being written — feed the
          // input preview into the checkpoint detector so writes to
          // .claude/agents/sr-*.md or .codex/skills/sr-*/SKILL.md advance
          // the checkpoint state immediately.
          const hits = detectCheckpointFromText(ev.inputPreview)
          for (const hit of hits) {
            this._advanceCheckpoint(projectId, hit.key, hit.detail)
          }
          break
        }
        case 'result': {
          // Claude's `result` event also carries session_id; use it as a
          // backstop if `session-started` wasn't observed earlier.
          const sid = (ev.payload as { session_id?: string }).session_id
          if (sid && !capturedSessionId) {
            capturedSessionId = sid
            this._onSessionCaptured?.(projectId, sid)
          }
          break
        }
        case 'other':
          // Other event types (system progress markers) — already broadcast
          // implicitly through the line itself if useful. Skip.
          break
      }
    })

    stderrReader.on('line', (line) => {
      this._broadcast({ type: 'setup_log', projectId, line, stream: 'stderr' })
    })

    child.on('close', (code) => {
      this._setupProcesses.delete(projectId)
      this._stopFilesystemPoll(projectId)

      // Final filesystem sync
      this._syncFilesystemCheckpoints(projectId, projectPath)

      if (code === 0) {
        // Sync filesystem checkpoints
        this._syncFilesystemCheckpoints(projectId, projectPath)

        // Check if setup is truly complete — real artifacts must exist
        const hasAgents = existsSync(join(projectPath, SPECRAILS_DIR, 'agents')) &&
          hasFiles(join(projectPath, SPECRAILS_DIR, 'agents'), /^sr-.*\.md$/)
        const hasCommands = (
          (existsSync(join(projectPath, SPECRAILS_DIR, 'commands', 'sr')) && hasFiles(join(projectPath, SPECRAILS_DIR, 'commands', 'sr'), /\.md$/)) ||
          (existsSync(join(projectPath, SPECRAILS_DIR, 'commands', 'specrails')) && hasFiles(join(projectPath, SPECRAILS_DIR, 'commands', 'specrails'), /\.md$/))
        )
        const isComplete = hasAgents && hasCommands

        if (isComplete) {
          const legacySrRemoved = sweepLegacySrCommands(projectPath)
          const tier = this._projectTiers.get(projectId) ?? 'full'
          const summary: SetupSummary = { ...computeSummary(projectPath, tier, this._projectProviders.get(projectId) ?? 'claude'), legacySrRemoved }
          this._onSetupDone?.(projectId)
          this._broadcast({
            type: 'setup_complete',
            projectId,
            sessionId: capturedSessionId ?? undefined,
            summary,
          })
        } else {
          // Claude finished one turn but setup isn't done yet.
          // Emit turn_done so the wizard knows to wait for user input.
          this._broadcast({
            type: 'setup_turn_done',
            projectId,
            sessionId: capturedSessionId ?? undefined,
          })
        }
      } else {
        this._onSetupDone?.(projectId)
        this._broadcast({
          type: 'setup_error',
          projectId,
          error: `${adapter.binary} enrich exited with code ${code ?? 'unknown'}`,
        })
      }
    })
  }

  private _initCheckpoints(projectId: string): void {
    const tier = this._projectTiers.get(projectId) ?? 'full'
    const defs = tier === 'quick' ? QUICK_CHECKPOINTS : CHECKPOINTS
    const statuses = new Map<string, CheckpointStatus>()
    const starts = new Map<string, number>()
    for (const def of defs) {
      statuses.set(def.key, { key: def.key, name: def.name, status: 'pending' })
    }
    this._checkpoints.set(projectId, statuses)
    this._checkpointStart.set(projectId, starts)
  }

  private _advanceCheckpoint(projectId: string, key: string, detail?: string): void {
    const statuses = this._checkpoints.get(projectId)
    if (!statuses) return

    const checkpoint = statuses.get(key)
    if (!checkpoint || checkpoint.status === 'done') return

    const starts = this._checkpointStart.get(projectId)!

    // When a later checkpoint starts, auto-complete all earlier ones
    const tier = this._projectTiers.get(projectId) ?? 'full'
    const checkpointDefs = tier === 'quick' ? QUICK_CHECKPOINTS : CHECKPOINTS
    const checkpointKeys = checkpointDefs.map((c) => c.key)
    const targetIdx = checkpointKeys.indexOf(key)
    for (let i = 0; i < targetIdx; i++) {
      const prevKey = checkpointKeys[i]
      const prev = statuses.get(prevKey)
      if (prev && prev.status !== 'done') {
        this._completeCheckpoint(projectId, prevKey)
      }
    }

    if (checkpoint.status === 'pending') {
      checkpoint.status = 'running'
      starts.set(key, Date.now())
      if (detail) checkpoint.detail = detail
      this._broadcast({ type: 'setup_checkpoint', projectId, checkpoint: key, status: 'running', detail })
    }
  }

  private _completeCheckpoint(projectId: string, key: string): void {
    const statuses = this._checkpoints.get(projectId)
    if (!statuses) return

    const checkpoint = statuses.get(key)
    if (!checkpoint || checkpoint.status === 'done') return

    const starts = this._checkpointStart.get(projectId)!
    const startTime = starts.get(key) ?? Date.now()
    const duration_ms = Date.now() - startTime
    starts.delete(key)

    checkpoint.status = 'done'
    checkpoint.duration_ms = duration_ms

    this._broadcast({ type: 'setup_checkpoint', projectId, checkpoint: key, status: 'done', duration_ms })
  }

  private _syncFilesystemCheckpoints(projectId: string, projectPath: string): void {
    const statuses = this._checkpoints.get(projectId)
    if (!statuses) return

    const fsChecks = checkFilesystem(projectPath)

    for (const [key, exists] of Object.entries(fsChecks)) {
      if (!exists) continue
      const cp = statuses.get(key)
      if (!cp) continue

      if (cp.status === 'pending') {
        // Fast-path: mark running then done immediately
        this._advanceCheckpoint(projectId, key)
        this._completeCheckpoint(projectId, key)
      } else if (cp.status === 'running') {
        this._completeCheckpoint(projectId, key)
      }
    }
  }

  // ─── Checkpoint poll endpoint ─────────────────────────────────────────────────

  getCheckpointStatus(projectId: string, projectPath: string): CheckpointStatus[] {
    // Sync from filesystem before returning
    this._syncFilesystemCheckpoints(projectId, projectPath)

    const tier = this._projectTiers.get(projectId) ?? 'full'
    const defs = tier === 'quick' ? QUICK_CHECKPOINTS : CHECKPOINTS
    const statuses = this._checkpoints.get(projectId)
    if (!statuses) {
      // Return all-pending if install hasn't started
      return defs.map((def) => ({ key: def.key, name: def.name, status: 'pending' as const }))
    }

    return defs.map((def) => statuses.get(def.key) ?? { key: def.key, name: def.name, status: 'pending' as const })
  }

  getInstallLog(projectId: string): string[] {
    return this._installLogBuffer.get(projectId) ?? []
  }

  // ─── Abort ────────────────────────────────────────────────────────────────────

  abort(projectId: string): void {
    this._stopFilesystemPoll(projectId)
    this._projectProviders.delete(projectId)
    this._projectTiers.delete(projectId)
    this._onSetupDone?.(projectId)

    const installChild = this._installProcesses.get(projectId)
    if (installChild?.pid) {
      this._terminateWithEscalation(installChild.pid)
      this._installProcesses.delete(projectId)
    }

    const setupChild = this._setupProcesses.get(projectId)
    if (setupChild?.pid) {
      this._terminateWithEscalation(setupChild.pid)
      this._setupProcesses.delete(projectId)
    }
  }

  /**
   * SIGTERM a process tree, then escalate to SIGKILL after a grace window if it
   * is still alive — mirroring QueueManager._kill. The Map entry is deleted
   * immediately by the caller, so the pid is captured locally here; without the
   * escalation a child that ignores SIGTERM (npm/npx scaffolding, a hung CLI)
   * would be orphaned for the host's lifetime with no remaining handle.
   */
  private _terminateWithEscalation(pid: number): void {
    try { treeKill(pid, 'SIGTERM') } catch { /* best-effort */ }
    const grace = setTimeout(() => {
      try { treeKill(pid, 'SIGKILL', () => { /* ignore */ }) } catch { /* best-effort */ }
    }, 5000)
    if (typeof grace.unref === 'function') grace.unref()
  }

  isInstalling(projectId: string): boolean {
    return this._installProcesses.has(projectId)
  }

  isEnriching(projectId: string): boolean {
    return this._setupProcesses.has(projectId)
  }

  /** @deprecated Use isEnriching() instead */
  isSettingUp(projectId: string): boolean {
    return this.isEnriching(projectId)
  }

  getInstallTier(projectId: string): InstallTier | undefined {
    return this._projectTiers.get(projectId)
  }

  getSummary(projectPath: string): SetupSummary {
    const config = readInstallConfig(projectPath)
    const tier = config?.tier ?? 'quick'
    // Provider is authoritative from install-config.yaml when present; we
    // do NOT fall back to filesystem heuristics because both `.codex/` and
    // `.claude/` can legitimately coexist (e.g. a project that's been
    // re-init'd) and a generic `existsSync` probe would mis-route.
    let provider: CLIProvider = 'claude'
    try {
      const text = readFileSync(join(projectPath, '.specrails', 'install-config.yaml'), 'utf-8')
      const m = text.match(/^provider:\s*(\w+)/m)
      if (m && m[1] === 'codex') provider = 'codex'
    } catch {
      // Missing install-config — stay on claude default.
    }
    return computeSummary(projectPath, tier, provider)
  }
}
