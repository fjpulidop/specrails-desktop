import { spawn, spawnSync, ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { existsSync, readdirSync, rmSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'fs'
import { basename, isAbsolute, join, resolve as resolvePath } from 'path'
import { tmpdir } from 'os'
import treeKill from 'tree-kill'
import type { WsMessage } from './types'
import { findCoreContract, detectCLISync, CLIProvider } from './core-compat'
import { spawnAiCli } from './util/cli-prompt'
import { spawnCli, windowsSpawnEnv } from './util/win-spawn'
import { formatMissingSetupPrerequisites } from './setup-prerequisites'
import { CORE_PACKAGE_SPEC } from './core-package'
import { getAdapter, hasAdapter, type AdapterEvent } from './providers'
import {
  buildProviderEnv,
  buildProviderRepoAccessArgs,
  parseStreamEvents,
} from './providers/runtime'
import { finaliseInvocationResult } from './result-event'
import { recordInvocation, type InvocationStatus } from './ai-invocations'
import { randomUUID } from 'crypto'
import type { DbInstance } from './db'
import { mirrorProjectEntry, resolveArtifacts, resolveHome } from './artifact-registry'
import { installConfigPath, installConfigPathForProvider, type InstallConfigProject } from './install-config-path'
import { getBundledCoreCli, getBundledCoreVersion } from './bundled-core'
import { resolveBundledNodeExe } from './path-resolver'
import { spawnBundledCoreInit } from './offline-assemble'
import { FrameworkManager } from './framework-manager'
import { resolveProjectExecution } from './workspace-resolution'
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
    env: windowsSpawnEnv(),
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
    // Force RELOCATION: specrails-core installs in-repo by DEFAULT now (so a
    // standalone `npx specrails-core init` user's CLI finds the agents in their
    // repo). The desktop manages the cwd (spawns rails with cwd=workspace), so
    // it MUST relocate to keep the user's imported repo pristine — independent of
    // whether the registry mirror already ran. See specrails-core init's gate.
    env: { ...windowsSpawnEnv(), SPECRAILS_RELOCATE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

// The bundled-core `init` spawn primitive is shared with the Project Builder's
// orchestrated commit (extract-don't-fork, add-project-builder D4) — the wizard
// keeps its streaming/phase shell and npx fallback around it.
// (Imported: spawnBundledCoreInit from ./offline-assemble.)

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
    env: windowsSpawnEnv(),
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

/**
 * Resolve which install-config to READ for an install. Prefers the per-provider
 * `install-config.<provider>.yaml` (multi-provider installs write one config per
 * provider so configs are never clobbered to the last one) and falls back to the
 * shared `install-config.yaml` for single-provider / legacy callers.
 */
function resolveInstallConfigReadPath(project: InstallConfigProject, provider?: string): string {
  if (provider) {
    const perProvider = installConfigPathForProvider(project, provider)
    if (existsSync(perProvider)) return perProvider
  }
  return installConfigPath(project)
}

function readInstallConfig(project: InstallConfigProject, provider?: string): InstallConfigParsed | null {
  const configPath = resolveInstallConfigReadPath(project, provider)
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
  { key: 'agent_selection', name: 'Agent selection' },
  { key: 'codebase_analysis', name: 'Codebase analysis' },
  { key: 'vpc_discovery', name: 'VPC discovery' },
  { key: 'agent_generation', name: 'Agent generation' },
  { key: 'persona_synthesis', name: 'Persona synthesis' },
  { key: 'command_generation', name: 'Command generation' },
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

function checkFilesystem(
  projectPath: string,
  provider: CLIProvider = 'claude',
): Partial<Record<string, boolean>> {
  const adapter = hasAdapter(provider) ? getAdapter(provider) : getAdapter('claude')
  const dir = adapter.projectDirName
  const artifactState = setupArtifactState(projectPath, 'full', provider)
  const hasBaseInstall = existsSync(join(projectPath, '.specrails', 'specrails-version')) ||
    existsSync(join(projectPath, '.specrails-version'))
  const hasSetupTemplates = existsSync(join(projectPath, '.specrails', 'setup-templates')) ||
    existsSync(join(projectPath, dir, 'setup-templates'))
  const hasRules = existsSync(join(projectPath, dir, 'rules')) &&
    hasFiles(join(projectPath, dir, 'rules'), /\.md$/)
  const hasPersonas = artifactState.hasPersonas
  const hasAgents = artifactState.hasAgents
  const hasCommands = artifactState.hasCommands
  const instructionCandidates = [join(projectPath, adapter.instructionsFilename)]
  // Older Core releases sometimes placed a top-level instructions filename
  // inside the provider directory. Preserve that compatibility only for
  // actual filenames: Kimi's adapter already declares the provider-relative
  // `.kimi-code/AGENTS.md` path, so prefixing projectDirName again would probe
  // the nonsensical `.kimi-code/.kimi-code/AGENTS.md`.
  if (adapter.instructionsFilename === basename(adapter.instructionsFilename)) {
    instructionCandidates.push(join(projectPath, dir, adapter.instructionsFilename))
  }
  const hasInstructions = instructionCandidates.some((candidate) => existsSync(candidate))
  const hasInstallConfig = existsSync(join(projectPath, '.specrails', 'install-config.yaml')) ||
    existsSync(join(projectPath, dir, 'install-config.yaml'))
  const hasAgentConfig = existsSync(join(projectPath, dir, 'agents.yaml'))
  const hasBacklogConfig = existsSync(join(projectPath, dir, 'backlog-config.json'))

  return {
    base_install: hasBaseInstall,
    // Back-compat filesystem signals from older cores are translated to the
    // current integration-contract checkpoint keys.
    agent_selection: hasInstallConfig || hasAgentConfig || hasBacklogConfig || hasAgents || hasCommands,
    codebase_analysis: hasBaseInstall && (hasInstructions || hasSetupTemplates),
    vpc_discovery: hasPersonas,
    persona_synthesis: hasPersonas,
    agent_generation: hasAgents,
    command_generation: hasCommands || (hasAgents && hasRules),
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

  // Match phase headers from Claude's /specrails:enrich output (and legacy /setup).
  // Older specrails-core prompts used different checkpoint names; keep accepting
  // those phrases but emit only the current integration-contract keys.
  if (/phase\s*1|codebase\s*analysis|repository\s*analysis/i.test(text)) {
    hits.push({ key: 'codebase_analysis', detail: 'Analyzing codebase...' })
  }
  if (/phase\s*2|user\s*personas|product\s*discovery|vpc\s*discovery/i.test(text)) {
    hits.push({ key: 'vpc_discovery', detail: 'Discovering personas...' })
  }
  if (/phase\s*3|configuration|agent\s*selection|backlog\s*provider/i.test(text)) {
    hits.push({ key: 'agent_selection', detail: 'Configuring agents...' })
  }
  if (/generating\s*all\s*files|writing.*agent|sr-architect|sr-developer|sr-reviewer/i.test(text)) {
    hits.push({ key: 'agent_generation', detail: 'Generating agents...' })
  }
  if (/command\s*selection|installing.*commands|\.claude\/commands\/(sr|specrails)/i.test(text)) {
    hits.push({ key: 'command_generation', detail: 'Configuring commands...' })
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
    hits.push({ key: 'command_generation' })
  }
  if (/✓\s*installed|installation\s*complete|init\s*complete|update\s*complete/i.test(text)) {
    hits.push({ key: 'quick_complete' })
  }

  // File path detection in tool_use events
  if (text.includes('.specrails-version') || text.includes('specrails/specrails-version')) hits.push({ key: 'base_install' })
  if (text.includes('/agents/personas/') && text.includes('.md')) {
    hits.push({ key: 'persona_synthesis', detail: 'Writing personas...' })
  }
  // Claude path: .claude/agents/sr-<name>.md
  if (/\/agents\/sr-[^/]+\.md/.test(text)) {
    hits.push({ key: 'agent_generation', detail: 'Writing agents...' })
  }
  // Provider-native rail skills. Kimi's upstream discovery contract scans only
  // direct children of `.kimi-code/skills`, so its roles are top-level
  // `.kimi-code/skills/sr-*/SKILL.md` entries. Codex may also use `rails/`.
  if (
    /\.(?:codex|kimi-code)\/skills\/(?:rails\/)?sr-[^/]+\/SKILL\.md/.test(text)
  ) {
    hits.push({ key: 'agent_generation', detail: 'Writing agent skills...' })
  }
  if ((text.includes('/commands/sr/') || text.includes('/commands/specrails/')) && text.includes('.md')) {
    hits.push({ key: 'command_generation', detail: 'Writing commands...' })
  }
  // Provider-native enrich/doctor skills (the non-rail commands) also indicate
  // command_generation progress.
  if (/\.(?:codex|kimi-code)\/skills\/(?:specrails-)?(?:enrich|doctor)\/SKILL\.md/.test(text)) {
    hits.push({ key: 'command_generation', detail: 'Writing provider command skills...' })
  }
  if (text.includes('/rules/') && text.includes('.md')) {
    hits.push({ key: 'command_generation', detail: 'Writing conventions...' })
  }
  // Codex sandbox / approval policy lives inside .codex/config.toml
  // (top-level `sandbox_mode` + `approval_policy` keys, per codex
  // 0.128.0+). There is no separate Starlark rules file.
  if (/\.codex\/config\.toml/.test(text)) {
    hits.push({ key: 'agent_selection', detail: 'Writing codex sandbox config...' })
  }
  if (text.includes('.specrails-manifest.json') || text.includes('specrails/specrails-manifest.json')) {
    hits.push({ key: 'command_generation' })
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
    if (provider === 'codex' || provider === 'kimi') {
      // Codex/Kimi layout: every artefact ships as a SKILL under the provider's
      // `skills/` root.
      // - agents  = rail personas (`skills/rails/sr-*/SKILL.md`) + orchestrator
      //             skills at the root with an `sr-` prefix. Kimi roles MUST be
      //             direct children (`skills/sr-*/SKILL.md`) because upstream
      //             Kimi discovery is intentionally one level deep.
      // - opsxCommands     = `skills/openspec-*/SKILL.md`
      // - specrailsCommands = everything else under `skills/` (ported claude
      //   slash commands like propose-spec, explore-spec, retry, doctor,
      //   enrich, vpc-drift, …)
      // - personas = Kimi's provider-local `.kimi-code/personas/*.md`; Codex
      //              keeps its legacy nested skill representation.
      const skillsDir = join(
        projectPath,
        provider === 'kimi' ? '.kimi-code' : '.codex',
        'skills',
      )
      if (existsSync(skillsDir)) {
        // Codex retains its nested Rails catalog. Kimi cannot: nested skills
        // are not discoverable by the Kimi CLI.
        const railsDir = join(skillsDir, 'rails')
        if (provider === 'codex' && existsSync(railsDir)) {
          for (const entry of readdirSync(railsDir) as string[]) {
            if (entry === 'personas') {
              const personasDir = join(railsDir, entry)
              personas = (readdirSync(personasDir) as string[]).filter((persona) =>
                existsSync(join(personasDir, persona, 'SKILL.md')),
              ).length
            } else if (existsSync(join(railsDir, entry, 'SKILL.md'))) {
              agents++
            }
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
      if (provider === 'kimi') {
        const personasDir = join(projectPath, '.kimi-code', 'personas')
        if (existsSync(personasDir)) {
          personas = (readdirSync(personasDir) as string[])
            .filter((entry) => entry.endsWith('.md'))
            .length
        }
      }
    } else {
      // Claude / Gemini layout: agents at `<dir>/agents/sr-*.md`, slash commands
      // at `<dir>/commands/{specrails,opsx}/*.<ext>`. Gemini installs into
      // `.gemini/` and its commands are TOML (`.gemini/commands/specrails/*.toml`);
      // claude installs into `.claude/` with Markdown commands. Without the
      // per-provider dir + extension below, a gemini install summarised 0/0/0
      // because it probed `.claude/` for `.md` files that don't exist.
      const dir = provider === 'gemini' ? '.gemini' : SPECRAILS_DIR
      const commandExt = provider === 'gemini' ? '.toml' : '.md'
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
      const commandsDirLegacySr = join(projectPath, dir, 'commands', 'sr')
      const commandsDirOpsx = join(projectPath, dir, 'commands', 'opsx')
      if (existsSync(commandsDirSpecrails)) {
        specrailsCommands = (readdirSync(commandsDirSpecrails) as string[]).filter((f) => f.endsWith(commandExt)).length
      }
      if (specrailsCommands === 0 && existsSync(commandsDirLegacySr)) {
        // Core <=4.1 used commands/sr. Count it only when the canonical
        // specrails tree has no commands so a transition install is never
        // doubled but an empty pre-created directory cannot hide real legacy
        // artefacts.
        specrailsCommands = (readdirSync(commandsDirLegacySr) as string[]).filter((f) => f.endsWith(commandExt)).length
      }
      if (existsSync(commandsDirOpsx)) {
        opsxCommands = (readdirSync(commandsDirOpsx) as string[]).filter((f) => f.endsWith(commandExt)).length
      }
    }
  } catch {
    // non-fatal
  }

  return { agents, specrailsCommands, opsxCommands, personas, legacySrRemoved: 0, tier, provider }
}

interface SetupArtifactState {
  summary: SetupSummary
  hasAgents: boolean
  hasCommands: boolean
  hasPersonas: boolean
  complete: boolean
}

/**
 * Resolve completion against the selected provider's real filesystem layout.
 * A legacy `.claude` fallback remains intentional only for Codex/Gemini:
 * older Core releases scaffolded Claude artefacts for those selections.
 * Kimi never had such a released legacy Core target; accepting a mixed
 * project's `.claude` tree would falsely report a missing `.kimi-code` setup
 * as complete.
 */
function setupArtifactState(
  projectPath: string,
  tier: 'quick' | 'full',
  provider: CLIProvider,
): SetupArtifactState {
  const nativeSummary = computeSummary(projectPath, tier, provider)
  const supportsLegacyClaudeFallback = provider === 'codex' || provider === 'gemini'
  const legacySummary = supportsLegacyClaudeFallback
    ? computeSummary(projectPath, tier, 'claude')
    : nativeSummary
  const nativeHasCommands =
    nativeSummary.specrailsCommands + nativeSummary.opsxCommands > 0
  const legacyHasCommands =
    legacySummary.specrailsCommands + legacySummary.opsxCommands > 0
  const nativeComplete = nativeSummary.agents > 0 && nativeHasCommands
  const legacyComplete = legacySummary.agents > 0 && legacyHasCommands
  const selected = nativeComplete || !legacyComplete ? nativeSummary : legacySummary

  return {
    // Preserve the actual selected provider for UI labels even when the
    // artefacts came from the legacy Claude compatibility tree.
    summary: { ...selected, provider },
    hasAgents: nativeSummary.agents > 0 || legacySummary.agents > 0,
    hasCommands: nativeHasCommands || legacyHasCommands,
    hasPersonas: nativeSummary.personas > 0 || legacySummary.personas > 0,
    complete: nativeComplete || legacyComplete,
  }
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

/**
 * Persist the FULL install log to `~/.specrails/logs/` and return the path (or
 * null on failure). The in-error tail is only a window; the full log carries the
 * complete child stack — needed because a Node uncaught error prints the ORIGIN
 * frames ABOVE the entry frames, so an 8-line tail shows only the bottom of the
 * stack + the error object, never where it was thrown.
 */
function persistInstallLog(projectId: string, logBuffer: string[]): string | null {
  try {
    const dir = join(resolveHome(), '.specrails', 'logs')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = join(dir, `setup-${projectId}-${stamp}.log`)
    writeFileSync(file, logBuffer.join('\n') + '\n', { mode: 0o600 })
    return file
  } catch {
    return null
  }
}

function formatBufferedInstallError(baseMessage: string, logBuffer: string[], logPath?: string | null): string {
  // Show a generous tail: a Node uncaught-exception dump is ~15-30 lines (header,
  // stack frames, the `{errno,code,syscall,path}` object, version footer). 8 lines
  // truncated to just the entry frames + error object, hiding the throw origin.
  const recentLines = logBuffer
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-40)

  const parts = [baseMessage]
  if (recentLines.length > 0) {
    parts.push('', 'Recent output:', ...recentLines.map((line) => `- ${line}`))
  }
  if (logPath) {
    parts.push('', `Full log: ${logPath}`)
  }
  return parts.join('\n')
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
  // Project ids whose install/enrich was explicitly aborted — the close handler
  // checks this to suppress a spurious setup_error / double onSetupDone when the
  // SIGTERM'd child closes with a null exit code.
  private _abortedProjects: Set<string> = new Set()
  // projectId → registry slug (captured at startInstall) so post-install
  // validation/summary/checkpoint reads resolve the RELOCATED workspace artifact
  // root rather than the (pristine) repo path.
  private _projectSlugs: Map<string, string> = new Map()
  // Ring buffer for install log lines — allows clients to recover log on reconnect
  private _installLogBuffer: Map<string, string[]>
  // Track each project's chosen AI provider for binary selection
  private _projectProviders: Map<string, CLIProvider>
  // Multi-provider one-shot install: remaining providers to install after the
  // current one completes (chained sequentially in the install close handler).
  private _installQueue: Map<string, { projectPath: string; slug?: string; remaining: string[] }> = new Map()
  // Track each project's install tier (quick vs full)
  private _projectTiers: Map<string, InstallTier>
  // Track project names for codex context header injection
  private _projectNames: Map<string, string>

  // Optional accessor to the per-project jobs.sqlite so the wizard's phase-4
  // AI /setup chat spawns can be recorded to ai_invocations (surface='setup',
  // COST-ACCOUNTING-AUDIT LOW-2). SetupManager holds no DB of its own — the
  // registry passes this so recording resolves the project's DB at the moment a
  // setup turn finishes (the project row + DB already exist by phase 4). When
  // the accessor is absent, or returns null (DB genuinely not created yet), no
  // row is written and behaviour is byte-identical to before.
  private _dbForProject?: (projectId: string) => DbInstance | null | undefined

  constructor(
    broadcast: (msg: WsMessage) => void,
    onSessionCaptured?: (projectId: string, sessionId: string) => void,
    onSetupDone?: (projectId: string) => void,
    dbForProject?: (projectId: string) => DbInstance | null | undefined,
  ) {
    this._broadcast = broadcast
    this._onSessionCaptured = onSessionCaptured
    this._onSetupDone = onSetupDone
    this._dbForProject = dbForProject
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

  /**
   * Install ALL of the given providers in one shot: installs the first, then
   * chains the rest sequentially as each completes (in the install close
   * handler). A single-element list just delegates to `startInstall`. This is
   * what the MCP/agent path uses so "add project + install (claude, codex,
   * gemini)" provisions every provider without the caller looping.
   */
  startInstallProviders(projectId: string, projectPath: string, projectSlug?: string, providers?: string[]): void {
    const list = (providers ?? []).filter((p) => hasAdapter(p))
    if (list.length <= 1) {
      this.startInstall(projectId, projectPath, projectSlug, list[0])
      return
    }
    this._installQueue.set(projectId, { projectPath, slug: projectSlug, remaining: list.slice(1) })
    this.startInstall(projectId, projectPath, projectSlug, list[0])
  }

  startInstall(projectId: string, projectPath: string, projectSlug?: string, provider?: string): void {
    this._abortedProjects.delete(projectId) // fresh run — clear any prior abort flag
    if (projectSlug) this._projectSlugs.set(projectId, projectSlug)
    if (this._installProcesses.has(projectId)) {
      console.warn(`[SetupManager] install already running for ${projectId}`)
      return
    }

    // Relocate-artifacts: ensure the shared registry entry exists (slug
    // agreement) BEFORE core's `init` runs, so core resolves its workspace from
    // the registry and installs the relocated artifacts under desktop's slug.
    // addProject already mirrors the entry; this is belt-and-suspenders for the
    // (rare) case where the project was registered before the mirror existed.
    // Wrapped so a registry write failure never blocks install (core then
    // installs in-repo and the project simply stays legacy — gate-safe).
    if (projectSlug) {
      try {
        mirrorProjectEntry({ repoPath: projectPath, slug: projectSlug, desktopProjectId: projectId })
      } catch (err) {
        console.warn(`[SetupManager] registry mirror before install failed (non-fatal): ${(err as Error).message}`)
      }
    }

    // Relocate-artifacts: the install config lives in the per-project HOME dir
    // (NOT the repo). `--from-config` accepts any path, so the spawn below points
    // core at the relocated location.
    const installProject: InstallConfigProject = { slug: projectSlug, path: projectPath }
    // Prefer this provider's per-provider config (multi-provider installs write
    // one config per provider; the shared file is the legacy single-provider
    // fallback). See resolveInstallConfigReadPath.
    const configPath = resolveInstallConfigReadPath(installProject, provider)
    const hasConfig = existsSync(configPath)
    const parsedConfig = hasConfig ? readInstallConfig(installProject, provider) : null
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
        if (m && m[1] && hasAdapter(m[1])) {
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

    // ─── Bundled-core fast path (offline framework) ──────────────────────────
    // When the app ships specrails-core, materialize the versioned framework
    // ONCE (instant/offline) and run the BUNDLED core `init` (offline framework
    // assemble by symlink; openspec init is the only remaining network step) —
    // NO `npx specrails-core` round-trip. When NO bundled core is present we fall
    // through to the legacy npx probe + spawn, byte-identical to today.
    const useBundledCore = getBundledCoreCli() !== null

    if (useBundledCore) {
      // Materialize the framework for the selected provider (idempotent). The
      // subsequent bundled `init` finds it already present (ensureFramework
      // skips) and just assembles the workspace by symlink. Best-effort: a
      // materialize failure is surfaced but the bundled init also re-runs
      // ensureFramework, so it self-heals.
      const provider = this._projectProviders.get(projectId) ?? 'claude'
      try {
        const fm = new FrameworkManager({
          broadcast: (msg) => this._broadcast(msg as unknown as WsMessage),
        })
        const mat = fm.materialize(getBundledCoreVersion() ?? undefined, [provider])
        if (mat.ran && mat.errors.length > 0) {
          console.warn(
            `[SetupManager] framework materialize had errors: ${mat.errors.map((e) => `${e.provider}: ${e.message}`).join('; ')}`,
          )
        }
      } catch (err) {
        console.warn(`[SetupManager] framework materialize threw (non-fatal): ${(err as Error).message}`)
      }
    } else {
      // Legacy path: probe the npx-resolved core runtime (network) before spawn.
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

    // Seed the install log with a diagnostic header capturing the EXACT spawn
    // (node interpreter, cli entry, cwd) + relevant env. This lands in the
    // failure report so a Windows/packaged path issue (e.g. an EISDIR on the
    // entry realpath) is diagnosable without server-console access.
    const diagHeader: string[] = []
    if (useBundledCore) {
      diagHeader.push(
        `[diag] node=${resolveBundledNodeExe() ?? process.execPath}`,
        `[diag] cli=${getBundledCoreCli() ?? '<none>'}`,
        `[diag] cwd=${projectPath}`,
        `[diag] args=${initArgs.join(' ')}`,
        `[diag] SPECRAILS_BUNDLED_RUNTIMES_PATH=${process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH ?? '<unset>'}`,
        `[diag] SPECRAILS_BUNDLED_CORE_PATH=${process.env.SPECRAILS_BUNDLED_CORE_PATH ?? '<unset>'}`,
      )
    }

    // Bundled core (offline, node <cli> init) when available, else legacy npx.
    const child = useBundledCore
      ? spawnBundledCoreInit(initArgs, projectPath)!
      : spawnCoreInit(initArgs, projectPath)

    this._installProcesses.set(projectId, child)
    this._installLogBuffer.set(projectId, diagHeader)

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
      // Explicit abort already tore down + fired onSetupDone — don't surface a
      // spurious setup_error for the SIGTERM'd child's null exit.
      if (this._abortedProjects.has(projectId)) return
      if (code === 0) {
        // Relocated installs write artifacts to the workspace, not the repo —
        // validate/sweep/summarize against the resolved artifact root.
        const artifactRoot = this._artifactRoot(projectId, projectPath)
        const validation = validateInstalledCore(artifactRoot)
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
        const legacySrRemoved = sweepLegacySrCommands(artifactRoot)
        const summary: SetupSummary = { ...computeSummary(artifactRoot, tier, this._projectProviders.get(projectId) ?? 'claude'), legacySrRemoved }
        this._broadcast({
          type: 'setup_install_done',
          projectId,
          timestamp: new Date().toISOString(),
          summary,
        })
        validateCoreContract().catch(() => { /* non-fatal */ })
        // Multi-provider one-shot: chain the next queued provider's install.
        const queued = this._installQueue.get(projectId)
        if (queued && queued.remaining.length > 0) {
          const next = queued.remaining.shift()!
          if (queued.remaining.length === 0) this._installQueue.delete(projectId)
          this.startInstall(projectId, queued.projectPath, queued.slug, next)
        }
      } else {
        this._installQueue.delete(projectId) // a failed provider stops the chain
        const logBuffer = this._installLogBuffer.get(projectId) ?? []
        const logPath = persistInstallLog(projectId, logBuffer)
        this._broadcast({
          type: 'setup_error',
          projectId,
          error: formatBufferedInstallError(
            `${useBundledCore ? 'bundled specrails-core' : 'npx specrails-core'} exited with code ${code ?? 'unknown'}`,
            logBuffer,
            logPath,
          ),
        })
      }
    })
  }

  // ─── Enrich: claude -p "/specrails:enrich --from-config" ────────────────────

  startEnrich(projectId: string, projectPath: string, provider?: ProviderId, projectName?: string): void {
    this._abortedProjects.delete(projectId) // fresh run — clear any prior abort flag
    if (this._setupProcesses.has(projectId)) {
      console.warn(`[SetupManager] enrich already running for ${projectId}`)
      return
    }

    if (provider) this._projectProviders.set(projectId, provider)
    if (projectName) this._projectNames.set(projectId, projectName)
    this._projectTiers.set(projectId, 'full')

    this._initCheckpoints(projectId)

    // Resolve the relocated artifact workspace before touching any provider
    // directories. The imported source repo must remain pristine.
    const enrichSlug = resolveArtifacts(projectPath).entry?.slug
    if (enrichSlug) this._projectSlugs.set(projectId, enrichSlug)
    const enrichRoot = this._artifactRoot(projectId, projectPath)

    // Pre-create the directory structure that /specrails:enrich will write to.
    // Claude Code's Write tool does not create parent directories automatically —
    // if a target directory doesn't exist the write fails and Claude reports a
    // misleading "write permissions aren't enabled" error.  Creating the dirs
    // here ensures enrich runs transparently without any user intervention.
    try {
      mkdirSync(join(enrichRoot, SPECRAILS_DIR, 'agents', 'personas'), { recursive: true })
      mkdirSync(join(enrichRoot, SPECRAILS_DIR, 'commands', 'sr'), { recursive: true })
      mkdirSync(join(enrichRoot, SPECRAILS_DIR, 'commands', 'specrails'), { recursive: true })
      mkdirSync(join(enrichRoot, SPECRAILS_DIR, 'rules'), { recursive: true })
    } catch (err) {
      console.warn(`[SetupManager] Failed to pre-create enrich directories: ${err}`)
    }

    // Relocate-artifacts: the install config lives in the per-project HOME dir.
    // The slug was allocated at addProject and mirrored into the shared registry
    // before/at install time, so resolve it from there (legacy full-flow path —
    // not exercised by the app's quick flow).
    const configPath = installConfigPath({ slug: enrichSlug, path: projectPath })
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
   * Persist one surface='setup' ai_invocations row for a phase-4 wizard AI turn
   * (LOW-2). Cost is the provider's native `total_cost_usd` when a terminal
   * `result` event arrived, else the pricing-table estimate over the accumulated
   * per-assistant-event usage. Resolves the project DB lazily via the injected
   * accessor: if the accessor is absent or the DB does not exist yet, nothing is
   * recorded. Best-effort — a recording failure is logged, never thrown, so it
   * can never break the setup wizard.
   */
  private _recordSetupInvocation(
    projectId: string,
    adapter: ProviderAdapter,
    events: readonly AdapterEvent[],
    status: InvocationStatus,
    startedAtIso: string,
  ): void {
    const db = this._dbForProject?.(projectId)
    if (!db) return
    try {
      const finishedAt = new Date().toISOString()
      const { result, estimated } = finaliseInvocationResult(adapter, events, {
        fallbackModel: adapter.defaultModel(),
        durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAtIso)),
      })
      recordInvocation(db, {
        id: randomUUID(),
        project_id: projectId,
        provider: adapter.id,
        surface: 'setup',
        surface_ref_id: projectId,
        status,
        started_at: startedAtIso,
        finished_at: finishedAt,
        total_cost_usd_estimated: estimated,
        ...result,
      })
      this._broadcast({ type: 'spending.invalidated', projectId })
    } catch (err) {
      console.error('[SetupManager] recordInvocation failed:', err)
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
    const execution = resolveProjectExecution({
      slug: this._projectSlugs.get(projectId),
      path: projectPath,
    })

    // Provider-aware prompt resolution:
    //   - claude: pass the slash command unresolved so the CLI looks up
    //     `.claude/commands/specrails/enrich.md` natively. Honours the
    //     skills-resolution priority over CLAUDE.md.
    //   - codex: no slash-command support; fold the enrich.md content into
    //     the prompt with the PROJECT context header so codex knows the cwd.
    let effectivePrompt: string
    try {
      effectivePrompt = adapter.formatCoreCommand?.(opts.prompt, execution.cwd) ?? opts.prompt
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[SetupManager] provider command resolution failed for ${projectId}: ${message}`)
      this._stopFilesystemPoll(projectId)
      this._broadcast({
        type: 'setup_error',
        projectId,
        error: message,
      })
      return
    }
    if (
      adapter.id === 'codex' &&
      !adapter.capabilities.systemPromptArg &&
      (opts.prompt === '/specrails:enrich' || opts.prompt === '/specrails:enrich --from-config')
    ) {
      const enrichContent = readEnrichMdContent(execution.cwd)
      if (enrichContent) {
        const projectName = this._projectNames.get(projectId)
        const cwdContext = execution.relocated
          ? `CWD: ${execution.cwd}\nREPOSITORY: ${execution.repoDir}`
          : `CWD: ${projectPath}`
        effectivePrompt = projectName
          ? `PROJECT: ${projectName}\n${cwdContext}\n\n---\n\n${enrichContent}`
          : enrichContent
      } else {
        console.warn(`[SetupManager] Could not read enrich.md or setup.md — falling back to literal prompt`)
      }
    }

    const repoAccessArgs = execution.relocated
      ? buildProviderRepoAccessArgs(adapter, [execution.repoDir])
      : []
    const spawnOpts = {
      prompt: effectivePrompt,
      model: adapter.defaultModel(),
      sessionId: opts.sessionId,
      extraArgs: repoAccessArgs,
    }
    const args = adapter.buildArgs(opts.action as SpawnAction, spawnOpts)

    // No OTEL env injection here — SetupManager spawns drive the initial project
    // setup wizard, not repeatable pipeline jobs. Telemetry is scoped to
    // QueueManager pipeline runs only.
    const child = spawnAiCli(adapter.binary, args, {
      cwd: execution.cwd,
      env: buildProviderEnv(adapter, spawnOpts, { ...process.env, ...execution.env }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    this._setupProcesses.set(projectId, child)

    // Accumulate adapter events + spawn time so a killed/failed/aborted setup
    // turn is still costed to ai_invocations (surface='setup', LOW-2).
    const adapterEvents: AdapterEvent[] = []
    const turnStartedAt = new Date().toISOString()

    /* c8 ignore start -- spawn-failure path; exercised manually, not in CI */
    child.on('error', (err) => {
      console.error(`[SetupManager] ${adapter.binary} spawn failed for ${projectId}: ${err.message}`)
      this._recordSetupInvocation(projectId, adapter, adapterEvents, 'failed', turnStartedAt)
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
    let providerError: string | null = null

    const stdoutReader = createInterface({ input: child.stdout!, crlfDelay: Infinity })
    const stderrReader = createInterface({ input: child.stderr!, crlfDelay: Infinity })

    stdoutReader.on('line', (line) => {
      const parsedEvents = parseStreamEvents(adapter, line)
      if (parsedEvents.length === 0) {
        // Non-parseable line — emit as raw log.
        if (line) this._broadcast({ type: 'setup_log', projectId, line, stream: 'stdout' })
        return
      }

      for (const ev of parsedEvents) {
        adapterEvents.push(ev)
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
        case 'error':
          providerError = ev.message
          this._broadcast({ type: 'setup_log', projectId, line: ev.message, stream: 'stderr' })
          break
        case 'other':
          // Other event types (system progress markers) — already broadcast
          // implicitly through the line itself if useful. Skip.
          break
        }
      }
    })

    stderrReader.on('line', (line) => {
      this._broadcast({ type: 'setup_log', projectId, line, stream: 'stderr' })
    })

    child.on('close', (code) => {
      this._setupProcesses.delete(projectId)
      this._stopFilesystemPoll(projectId)
      // Explicit abort already tore down + fired onSetupDone — suppress the
      // failure branch (spurious error + a second onSetupDone) here. The tokens
      // burned before the abort are still real, so record an 'aborted' row.
      if (this._abortedProjects.has(projectId)) {
        this._recordSetupInvocation(projectId, adapter, adapterEvents, 'aborted', turnStartedAt)
        return
      }

      // Record the completed setup turn's spend (success on clean exit, failed
      // otherwise). LOW-2.
      const providerReportedFailure = providerError !== null
      this._recordSetupInvocation(
        projectId,
        adapter,
        adapterEvents,
        code === 0 && !providerReportedFailure ? 'success' : 'failed',
        turnStartedAt,
      )

      // Final filesystem sync
      this._syncFilesystemCheckpoints(projectId, projectPath)

      if (code === 0 && !providerReportedFailure) {
        // Sync filesystem checkpoints
        this._syncFilesystemCheckpoints(projectId, projectPath)

        // Relocated installs write artifacts to the workspace, not the repo —
        // resolve the has-agents/has-commands gate + summary against it.
        const artifactRoot = this._artifactRoot(projectId, projectPath)

        // Check completion against the selected provider's native artefacts.
        // In particular, Kimi rail roles are direct-child SKILL.md files under
        // `.kimi-code/skills/`, not Markdown agents/commands in `.claude`.
        const tier = this._projectTiers.get(projectId) ?? 'full'
        const provider = this._projectProviders.get(projectId) ?? 'claude'
        const artifactState = setupArtifactState(artifactRoot, tier, provider)
        const isComplete = artifactState.complete

        if (isComplete) {
          const legacySrRemoved = sweepLegacySrCommands(artifactRoot)
          const summary: SetupSummary = {
            ...artifactState.summary,
            legacySrRemoved,
          }
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
          error: providerError ?? `${adapter.binary} enrich exited with code ${code ?? 'unknown'}`,
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

  /** Resolve the artifact root for post-install reads. For a RELOCATED project
   *  (registry entry + populated workspace) the `.specrails`/provider dirs live
   *  in the workspace, NOT the pristine repo path — `resolveProjectExecution`
   *  returns that cwd. Falls back to the repo path (legacy) when no slug is
   *  known or the project isn't relocated. */
  private _artifactRoot(projectId: string, projectPath: string): string {
    const slug = this._projectSlugs.get(projectId)
    try {
      return resolveProjectExecution({ slug, path: projectPath }).cwd
    } catch {
      return projectPath
    }
  }

  private _syncFilesystemCheckpoints(projectId: string, projectPath: string): void {
    const statuses = this._checkpoints.get(projectId)
    if (!statuses) return

    const fsChecks = checkFilesystem(
      this._artifactRoot(projectId, projectPath),
      this._projectProviders.get(projectId) ?? 'claude',
    )

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
    // Mark aborted so the still-registered close handlers suppress their failure
    // branch (spurious setup_error + a second onSetupDone) when the SIGTERM'd
    // child closes with a null code. Cleared on the next startInstall/startEnrich.
    this._abortedProjects.add(projectId)
    this._stopFilesystemPoll(projectId)
    this._projectProviders.delete(projectId)
    this._projectTiers.delete(projectId)
    this._projectSlugs.delete(projectId)
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

  getSummary(project: InstallConfigProject): SetupSummary {
    const config = readInstallConfig(project)
    const tier = config?.tier ?? 'quick'
    // Provider is authoritative from install-config.yaml when present; we
    // do NOT fall back to filesystem heuristics because both `.codex/` and
    // `.claude/` can legitimately coexist (e.g. a project that's been
    // re-init'd) and a generic `existsSync` probe would mis-route.
    // Relocate-artifacts: the config lives in the per-project HOME dir.
    let provider: CLIProvider = 'claude'
    try {
      const text = readFileSync(installConfigPath(project), 'utf-8')
      const m = text.match(/^provider:\s*(\w+)/m)
      if (m && m[1] && hasAdapter(m[1])) provider = m[1]
    } catch {
      // Missing install-config — stay on claude default.
    }
    // Relocated installs intentionally keep the imported repository pristine:
    // provider artefacts live in the populated workspace. The immediate install
    // completion path already uses `_artifactRoot`; a later GET after reopening
    // must resolve the same root or Kimi (and every relocated provider) is
    // incorrectly summarised as 0 agents / 0 commands.
    let artifactRoot = project.path
    try {
      artifactRoot = resolveProjectExecution({
        slug: project.slug,
        path: project.path,
      }).cwd
    } catch {
      // Registry/workspace resolution is fail-open by contract. Legacy projects
      // continue to read their in-repo artefacts.
    }
    return computeSummary(artifactRoot, tier, provider)
  }
}
