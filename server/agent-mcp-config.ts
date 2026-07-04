import fs from 'fs'
import path from 'path'
import os from 'os'
import { resolveBundledNodeExe } from './path-resolver'
import { stripWindowsVerbatimPrefix } from './util/win-spawn'
import { AGENT_TIER_ENV, AGENT_PROJECT_ENV, AGENT_CONVERSATION_ENV, tierNameForLevel, type AgentTierLevel } from './agent-tier'

// ─── Agent MCP wiring (design D8 / D1) ────────────────────────────────────────
//
// The in-app agent drives the app by talking to its OWN embedded MCP server. We
// spawn the AI CLI with `--mcp-config` pointing at a generated config whose sole
// server is the bundled `specrails-mcp` stdio bridge, which relays to
// `127.0.0.1:<port>/api/mcp` and reads the scoped token from disk (no token is
// ever written into the config file). The current Shift+Tab ladder level is
// forwarded via env → the bridge sets it as a loopback-only header so the tool
// guard enforces the agent ladder independently of the external Settings tiers.

function homeDir(): string {
  return process.env.SPECRAILS_REGISTRY_HOME || os.homedir()
}

function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

/**
 * Absolute path to the `specrails-mcp` bridge JS. Resolution order:
 *   1. SPECRAILS_BUNDLED_MCP_BRIDGE_PATH (set by the Tauri host in the packaged app)
 *   2. the staged copy under src-tauri/binaries/ (dev + bundled layouts)
 *   3. the mcp-bridge build output (mcp-bridge/dist/)
 * Climbs from this module so it works whether running from server/ or server/dist/.
 */
export function resolveBridgeScript(): string | null {
  // Tauri's resource_dir() delivers `\\?\C:\…` verbatim paths on Windows; a
  // `\\?\`-prefixed script argument crashes node's module loader (EISDIR
  // lstat 'C:'), leaving the MCP server perpetually "connecting". Strip here
  // as defence-in-depth even though ensureWindowsBaseEnv() normalizes the var.
  const fromEnv = process.env.SPECRAILS_BUNDLED_MCP_BRIDGE_PATH
  if (fromEnv) {
    const cleaned = stripWindowsVerbatimPrefix(fromEnv)
    if (fileExists(cleaned)) return cleaned
  }

  const roots = [
    path.resolve(__dirname, '..'),
    path.resolve(__dirname, '..', '..'),
    process.cwd(),
  ]
  const rels = [
    path.join('src-tauri', 'binaries', 'specrails-mcp.js'),
    path.join('mcp-bridge', 'dist', 'specrails-mcp.js'),
  ]
  for (const root of roots) {
    for (const rel of rels) {
      const candidate = path.join(root, rel)
      if (fileExists(candidate)) return candidate
    }
  }
  return null
}

/** The node executable that should run the bridge (bundled in the packaged app, else PATH `node`). */
export function resolveNodeCommand(): string {
  return resolveBundledNodeExe() ?? 'node'
}

export interface AgentMcpEntry {
  command: string
  args: string[]
  env: Record<string, string>
}

/** The launch-route contract for an origin conversation id (safe-pr-review-flow):
 *  must match rails-router's validation so a tagged launch is never 400'd. */
const ORIGIN_CONVERSATION_ID_RE = /^[A-Za-z0-9-]{1,64}$/

/** Build the `mcpServers.specrails` entry the agent (or a project workspace) uses. */
export function buildSpecrailsMcpEntry(opts: {
  port: number
  tierLevel?: AgentTierLevel
  activeProjectId?: string | null
  /** The launching agent-chat conversation id (safe-pr-review-flow origin link).
   *  Forwarded env → bridge header → tool ctx → rails launch body, so an
   *  MCP-launched rail's PR decision can be posted back into the conversation.
   *  Malformed values are silently omitted (never throw — degrade to untagged). */
  conversationId?: string | null
}): AgentMcpEntry | null {
  const bridge = resolveBridgeScript()
  if (!bridge) return null
  const env: Record<string, string> = {
    SPECRAILS_MCP_PORT: String(opts.port),
  }
  // Preserve the test-home override so the bridge reads the right token file.
  if (process.env.SPECRAILS_REGISTRY_HOME) env.SPECRAILS_REGISTRY_HOME = process.env.SPECRAILS_REGISTRY_HOME
  if (opts.tierLevel != null) env[AGENT_TIER_ENV] = tierNameForLevel(opts.tierLevel)
  if (opts.activeProjectId) env[AGENT_PROJECT_ENV] = opts.activeProjectId
  if (opts.conversationId && ORIGIN_CONVERSATION_ID_RE.test(opts.conversationId)) {
    env[AGENT_CONVERSATION_ENV] = opts.conversationId
  }
  return { command: resolveNodeCommand(), args: [bridge], env }
}

/**
 * Part A (design D8): surgically merge the `specrails` MCP server into a
 * project's app-managed WORKSPACE `.mcp.json` so the project's own rails/explore/
 * chat spawns can also call the Specrails MCP. NEVER touches the pristine repo.
 * Additive + idempotent: preserves any existing (e.g. plugin) mcpServers entries,
 * writes atomically (temp + rename), inlines NO token. Returns true when written.
 */
export function mergeSpecrailsIntoWorkspaceMcp(workspaceDir: string, port: number): boolean {
  const entry = buildSpecrailsMcpEntry({ port })
  if (!entry) return false
  const file = path.join(workspaceDir, '.mcp.json')
  let current: { mcpServers?: Record<string, unknown>; [k: string]: unknown } = {}
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
      if (parsed && typeof parsed === 'object') current = parsed
    }
  } catch {
    // Corrupt file → start fresh rather than crash assembly.
    current = {}
  }
  const mcpServers = { ...(current.mcpServers ?? {}), specrails: entry }
  const next = { ...current, mcpServers }
  const tmp = `${file}.tmp-${process.pid}`
  fs.mkdirSync(workspaceDir, { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
  fs.renameSync(tmp, file)
  return true
}

/**
 * Writes a per-conversation `--mcp-config` file for the agent and returns the
 * `['--mcp-config', <file>]` argv to inject into SpawnOptions.extraArgs. Uses the
 * bundled `specrails-mcp` stdio bridge (shipped inside the app — the user installs
 * nothing; 100% unattended) which relays to this process's `/api/mcp`. Returns
 * `[]` when the bridge can't be located (agent then runs tool-less / degraded).
 */
export function buildAgentMcpArgs(opts: {
  conversationId: string
  port: number
  tierLevel: AgentTierLevel
  activeProjectId?: string | null
}): string[] {
  const entry = buildSpecrailsMcpEntry({
    port: opts.port,
    tierLevel: opts.tierLevel,
    activeProjectId: opts.activeProjectId,
    conversationId: opts.conversationId,
  })
  if (!entry) return []
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(opts.conversationId)) {
    throw new Error(`unsafe agent conversation id: ${opts.conversationId}`)
  }
  const dir = path.join(homeDir(), '.specrails', 'agent', opts.conversationId)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'mcp.json')
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { specrails: entry } }, null, 2), { mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* best-effort on platforms without chmod */
  }
  return ['--mcp-config', file]
}

// ─── Provider-aware agent MCP wiring ──────────────────────────────────────────
//
// Each provider registers MCP servers differently, so the agent's specrails MCP
// is wired per adapter. All three run the SAME bundled bridge (with tier/project
// env → loopback headers); only the REGISTRATION mechanism differs:
//   claude  → `--mcp-config <file>`         (extraArgs)
//   codex   → per-conversation CODEX_HOME with config.toml [mcp_servers.specrails]
//             (+ copied auth.json so login still works)  (env: CODEX_HOME)
//   gemini/other project-json → `.mcp.json` written in the spawn cwd

export interface AgentMcpWiring {
  extraArgs: string[]
  env: Record<string, string>
}

function agentDir(conversationId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(conversationId)) {
    throw new Error(`unsafe agent conversation id: ${conversationId}`)
  }
  const dir = path.join(homeDir(), '.specrails', 'agent', conversationId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Codex registers the specrails MCP via inline `-c mcp_servers.specrails.*`
 * config overrides. This keeps codex on the USER's real CODEX_HOME (auth + model
 * settings intact — no all-or-nothing 401 from a CODEX_HOME override) and cannot
 * break codex startup the way an unknown `--mcp-config` flag does: `-c` is a known
 * flag and unknown config keys are simply set. TOML scalar values reuse JSON
 * escaping (compatible for our command/path/env inputs).
 */
function codexMcpOverrides(entry: AgentMcpEntry): string[] {
  const c = (kv: string): string[] => ['-c', kv]
  const args: string[] = [
    ...c(`mcp_servers.specrails.command=${JSON.stringify(entry.command)}`),
    ...c(`mcp_servers.specrails.args=[${entry.args.map((a) => JSON.stringify(a)).join(', ')}]`),
  ]
  for (const [k, v] of Object.entries(entry.env)) {
    args.push(...c(`mcp_servers.specrails.env.${k}=${JSON.stringify(v)}`))
  }
  return args
}

/**
 * Prepares the specrails MCP for the given provider and returns the spawn
 * extraArgs + env to merge. Returns empty wiring when the bridge is unavailable
 * (agent then runs tool-less / degraded).
 */
export function prepareAgentMcp(opts: {
  adapterId: string
  conversationId: string
  cwd: string
  port: number
  tierLevel: AgentTierLevel
  activeProjectId?: string | null
}): AgentMcpWiring {
  const entry = buildSpecrailsMcpEntry({
    port: opts.port,
    tierLevel: opts.tierLevel,
    activeProjectId: opts.activeProjectId,
    conversationId: opts.conversationId,
  })
  if (!entry) return { extraArgs: [], env: {} }

  if (opts.adapterId === 'codex') {
    // Inline -c overrides — no CODEX_HOME override, no file mutation; auth intact.
    return { extraArgs: codexMcpOverrides(entry), env: {} }
  }

  if (opts.adapterId === 'claude') {
    return { extraArgs: buildAgentMcpArgs(opts), env: {} }
  }

  // gemini + any other project-json provider: write .mcp.json in the spawn cwd.
  const file = path.join(opts.cwd, '.mcp.json')
  mergeServerIntoJsonFile(file, entry)

  if (opts.adapterId === 'gemini') {
    // gemini-cli has NEVER read .mcp.json (a Claude convention) — its only MCP
    // surface is `mcpServers` in settings.json (user or <cwd>/.gemini project
    // scope), and an UNTRUSTED cwd suppresses MCP entirely (headless run exits
    // 55 with FatalUntrustedWorkspaceError on 0.49). So: register in the
    // project-scope settings file AND trust the app-owned agent cwd per-spawn
    // via env — the same pattern every other gemini spawn path already uses
    // (chat-manager / queue-manager / cli-prompt). Verified empirically against
    // gemini-cli 0.49.0 (see docs/internals note on FQN tool prefixing).
    const geminiDir = path.join(opts.cwd, '.gemini')
    fs.mkdirSync(geminiDir, { recursive: true })
    mergeServerIntoJsonFile(path.join(geminiDir, 'settings.json'), entry)
    return { extraArgs: [], env: { GEMINI_CLI_TRUST_WORKSPACE: 'true' } }
  }

  return { extraArgs: [], env: {} }
}

/** Merge `mcpServers.specrails` into a JSON config file (read-if-exists,
 *  preserve every other key, corrupt file → start fresh, chmod 600). Shape is
 *  shared by claude-style `.mcp.json` and gemini `.gemini/settings.json` —
 *  both carry a top-level `mcpServers` object. */
function mergeServerIntoJsonFile(file: string, entry: AgentMcpEntry): void {
  let current: { mcpServers?: Record<string, unknown>; [k: string]: unknown } = {}
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
      if (parsed && typeof parsed === 'object') current = parsed
    }
  } catch {
    current = {}
  }
  const next = { ...current, mcpServers: { ...(current.mcpServers ?? {}), specrails: entry } }
  fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 })
}
