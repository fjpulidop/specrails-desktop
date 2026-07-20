import fs from 'fs'
import path from 'path'
import os from 'os'
import { randomBytes } from 'crypto'
import { resolveBundledNodeExe } from './path-resolver'
import { stripWindowsVerbatimPrefix } from './util/win-spawn'
import { AGENT_CAPABILITY_FILE_ENV } from './agent-tier'
import { getAdapter } from './providers'

const AGENT_CONVERSATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

// ─── Agent MCP wiring (design D8 / D1) ────────────────────────────────────────
//
// The in-app agent drives the app by talking to its OWN embedded MCP server. We
// spawn the AI CLI with `--mcp-config` pointing at a generated config whose sole
// server is the bundled `specrails-mcp` stdio bridge, which relays to
// `127.0.0.1:<port>/api/mcp` and reads the scoped token from disk (no token is
// ever written into the config file). A per-turn, server-minted capability is
// written to a 0600 file and the config carries only that file path. The bridge
// reads the secret and presents it to the server; tier/project/conversation are
// derived from the server-side capability binding, never client headers.

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

/** Build the `mcpServers.specrails` entry the agent (or a project workspace) uses. */
export function buildSpecrailsMcpEntry(opts: {
  port: number
  /** Path to the 0600 per-turn capability file. External/workspace MCP entries
   *  omit it and therefore remain governed by the Settings tiers. */
  capabilityFile?: string
}): AgentMcpEntry | null {
  const bridge = resolveBridgeScript()
  if (!bridge) return null
  const env: Record<string, string> = {
    SPECRAILS_MCP_PORT: String(opts.port),
  }
  // Preserve the test-home override so the bridge reads the right token file.
  if (process.env.SPECRAILS_REGISTRY_HOME) env.SPECRAILS_REGISTRY_HOME = process.env.SPECRAILS_REGISTRY_HOME
  if (opts.capabilityFile) env[AGENT_CAPABILITY_FILE_ENV] = opts.capabilityFile
  return { command: resolveNodeCommand(), args: [bridge], env }
}

/**
 * Part A (design D8): surgically merge the `specrails` MCP server into a
 * project's app-managed WORKSPACE `.mcp.json` so the project's own rails/explore/
 * chat spawns can also call the Specrails MCP. NEVER touches the pristine repo.
 * Additive + idempotent: preserves any existing (e.g. plugin) mcpServers entries,
 * writes atomically (temp + rename), inlines NO token. Returns true when written.
 */
export function mergeSpecrailsIntoWorkspaceMcp(
  workspaceDir: string,
  port: number,
  providerId: string = 'claude',
): boolean {
  const entry = buildSpecrailsMcpEntry({ port })
  if (!entry) return false
  const adapter = getAdapter(providerId)
  const file = adapter.projectMcpPath?.(workspaceDir) ?? path.join(workspaceDir, '.mcp.json')
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
  fs.mkdirSync(path.dirname(file), { recursive: true })
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
  capability: string
}): string[] {
  const entry = buildAgentTurnEntry(opts)
  if (!entry) return []
  const dir = agentDir(opts.conversationId)
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
// is wired per adapter. All three run the SAME bundled bridge (with a capability
// file path in env); only the REGISTRATION mechanism differs:
//   claude  → `--mcp-config <file>`         (extraArgs)
//   codex   → per-conversation CODEX_HOME with config.toml [mcp_servers.specrails]
//             (+ copied auth.json so login still works)  (env: CODEX_HOME)
//   gemini/other project-json → `.mcp.json` written in the spawn cwd

export interface AgentMcpWiring {
  extraArgs: string[]
  env: Record<string, string>
}

function agentDir(conversationId: string): string {
  if (!AGENT_CONVERSATION_ID_RE.test(conversationId)) {
    throw new Error(`unsafe agent conversation id: ${conversationId}`)
  }
  const dir = path.join(homeDir(), '.specrails', 'agent', conversationId)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(dir, 0o700) } catch { /* best-effort on platforms without chmod */ }
  return dir
}

function capabilityFilePath(conversationId: string): string {
  return path.join(agentDir(conversationId), 'mcp.capability')
}

function buildAgentTurnEntry(opts: {
  conversationId: string
  port: number
  capability: string
}): AgentMcpEntry | null {
  const capabilityFile = capabilityFilePath(opts.conversationId)
  const entry = buildSpecrailsMcpEntry({ port: opts.port, capabilityFile })
  if (!entry) return null
  const tmp = `${capabilityFile}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
  try {
    // `wx` prevents a pre-planted symlink from redirecting the bearer write.
    fs.writeFileSync(tmp, opts.capability, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    try { fs.chmodSync(tmp, 0o600) } catch { /* best-effort on platforms without chmod */ }
    // Windows rename does not replace an existing destination. A stale file can
    // remain after a hard crash, but its server-side capability is already gone.
    try { fs.unlinkSync(capabilityFile) } catch { /* first turn / already absent */ }
    fs.renameSync(tmp, capabilityFile)
    try { fs.chmodSync(capabilityFile, 0o600) } catch { /* best-effort on platforms without chmod */ }
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* never leave a bearer-bearing temp file */ }
    throw err
  }
  return entry
}

/** Delete the on-disk bearer as soon as its owning agent turn settles. */
export function removeAgentCapabilityFile(conversationId: string): void {
  if (!AGENT_CONVERSATION_ID_RE.test(conversationId)) return
  const file = path.join(homeDir(), '.specrails', 'agent', conversationId, 'mcp.capability')
  try { fs.unlinkSync(file) } catch { /* absent/already removed */ }
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
  capability: string
}): AgentMcpWiring {
  const adapter = getAdapter(opts.adapterId)
  if (adapter.id === 'claude') {
    return { extraArgs: buildAgentMcpArgs(opts), env: {} }
  }

  const entry = buildAgentTurnEntry(opts)
  if (!entry) return { extraArgs: [], env: {} }

  if (adapter.mcpRegistration === 'cli-add') {
    // Inline -c overrides contain only the capability FILE PATH, never its secret.
    return { extraArgs: codexMcpOverrides(entry), env: {} }
  }

  // Project-json providers write only their native project config in the
  // conversation-isolated cwd.
  const file = adapter.projectMcpPath?.(opts.cwd) ?? path.join(opts.cwd, '.mcp.json')
  mergeServerIntoJsonFile(file, entry)

  if (adapter.id === 'gemini') {
    // gemini-cli has NEVER read .mcp.json (a Claude convention) — its only MCP
    // surface is `mcpServers` in settings.json (user or <cwd>/.gemini project
    // scope), and an UNTRUSTED cwd suppresses MCP entirely (headless run exits
    // 55 with FatalUntrustedWorkspaceError on 0.49). So: register in the
    // project-scope settings file AND trust the app-owned agent cwd per-spawn
    // via env — the same pattern every other gemini spawn path already uses
    // (chat-manager / queue-manager / cli-prompt). Verified empirically against
    // gemini-cli 0.49.0 (see docs/internals note on FQN tool prefixing).
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
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 })
  try { fs.chmodSync(file, 0o600) } catch { /* best-effort */ }
}
