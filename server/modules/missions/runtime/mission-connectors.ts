/**
 * Connectors in missions: the provider's OWN user-scope MCP servers and
 * account connectors, listed per provider, each on by default.
 *
 * Pure rules only (parsing, duplicate detection, the stored deny-list and the
 * translation into a turn's MCP plan). Reading configs and probing the CLIs
 * lives in `mission-connectors-discovery.ts`.
 *
 * How each provider is told which of its connectors to load:
 * - Codex (Core sessions): `policy.mcp.inheritUserScope: false` plus a
 *   name-only spec per enabled server. Core disables every declared server
 *   not listed (`-c mcp_servers.<name>.enabled=false`) and, for a spec with
 *   no transport, only emits `enabled=true`, so the user's own definition
 *   (command, env, timeouts, tool approvals) is kept. Legacy Codex turns get
 *   the same disables as `-c` overrides.
 * - Claude: mission sessions run with `--setting-sources project,local`, so
 *   the user-scope servers in `~/.claude.json` are not loaded at all; the
 *   claude.ai account connectors are. Turned-off connectors are written as
 *   `deniedMcpServers` into the app-owned agent cwd's
 *   `.claude/settings.local.json` (verified on Claude Code 2.1.322: the
 *   connector disappears from the session). Enabled user-scope servers are
 *   only injected when the Claude driver loads MCP tools on demand
 *   (`deferredMcpTools`), because without tool search their definitions are
 *   sent in full on every request (premiere-pro alone is ~200k tokens).
 * - Gemini: `mcp.excluded` in the conversation's `.gemini/settings.json`
 *   (verified on gemini-cli 0.49.0).
 * - Kimi: listed only; Specrails cannot switch its servers off one by one.
 */

export const MISSION_CONNECTORS_SETTING_KEY = 'mission_connectors'

export const CONNECTOR_PROVIDERS = ['claude', 'codex', 'gemini', 'kimi'] as const
export type ConnectorProvider = (typeof CONNECTOR_PROVIDERS)[number]

export type ConnectorKind = 'account-connector' | 'mcp-server'

/** Why a listed connector cannot be toggled. */
export type ConnectorLock =
  /** Same server as Specrails' own MCP: always excluded. */
  | 'specrails-duplicate'
  /** Turned off in the provider's own config; Specrails never turns it on. */
  | 'disabled-in-provider'
  /** Specrails already adds it through "External MCP servers" for this provider. */
  | 'external-mcp'
  /** The provider has no per-server switch Specrails can use. */
  | 'unsupported'

export interface ConnectorTransport {
  command?: string
  args?: string[]
  url?: string
  /** Raw transport type when the config states one (`stdio`, `http`, `sse`…). */
  type?: string
}

export interface DetectedConnector {
  provider: ConnectorProvider
  /** The name the provider knows it by (also the deny-list id). */
  name: string
  kind: ConnectorKind
  transport?: ConnectorTransport
  /** The full user config entry (Claude/Gemini/Kimi JSON maps), kept for injection. */
  config?: Record<string, unknown>
  /** `false` when the provider's own config switches it off. */
  enabledInProvider: boolean
  /** Account connector health as the provider reported it. */
  status?: 'connected' | 'needs-auth' | 'failed' | 'unknown'
}

export interface ConnectorSize {
  tools: number
  /** Approximate tokens of the tool definitions if sent in full. */
  tokens: number
  measuredAt: string
}

export interface MissionConnectorSettings {
  version: 1
  /** Deny-list per provider: anything not listed is enabled (new connectors default on). */
  disabled: Record<ConnectorProvider, string[]>
}

export function emptyConnectorSettings(): MissionConnectorSettings {
  return { version: 1, disabled: { claude: [], codex: [], gemini: [], kimi: [] } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isConnectorProvider(value: unknown): value is ConnectorProvider {
  return typeof value === 'string' && (CONNECTOR_PROVIDERS as readonly string[]).includes(value)
}

const CONNECTOR_NAME_MAX = 128

function cleanNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const names = value.filter((name): name is string => typeof name === 'string' && name.trim().length > 0 && name.length <= CONNECTOR_NAME_MAX)
  return [...new Set(names)].sort()
}

/** Stored settings, tolerant of junk (read path). */
export function parseConnectorSettings(raw: string | undefined | null): MissionConnectorSettings {
  const settings = emptyConnectorSettings()
  if (!raw) return settings
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return settings }
  if (!isRecord(parsed) || !isRecord(parsed.disabled)) return settings
  for (const provider of CONNECTOR_PROVIDERS) settings.disabled[provider] = cleanNames(parsed.disabled[provider])
  return settings
}

export class ConnectorSettingsValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'ConnectorSettingsValidationError'
  }
}

/**
 * One toggle from the settings UI: `{ provider, name, enabled }`. Returns the
 * next settings; the deny-list only ever grows by an explicit "off".
 */
export function applyConnectorToggle(current: MissionConnectorSettings, body: unknown): MissionConnectorSettings {
  if (!isRecord(body)) throw new ConnectorSettingsValidationError('invalid_body', 'body must be { provider, name, enabled }')
  const { provider, name, enabled } = body
  if (!isConnectorProvider(provider)) throw new ConnectorSettingsValidationError('unknown_provider', `unknown provider ${JSON.stringify(provider)}`)
  if (typeof name !== 'string' || !name.trim() || name.length > CONNECTOR_NAME_MAX) throw new ConnectorSettingsValidationError('invalid_name', 'name must be a non-empty string')
  if (typeof enabled !== 'boolean') throw new ConnectorSettingsValidationError('invalid_enabled', 'enabled must be a boolean')
  const disabled = new Set(current.disabled[provider])
  if (enabled) disabled.delete(name)
  else disabled.add(name)
  return { version: 1, disabled: { ...current.disabled, [provider]: [...disabled].sort() } }
}

// ─── Parsing provider configs ─────────────────────────────────────────────────

/** Minimal TOML value reader for the keys Codex MCP tables use (strings, string arrays, booleans). */
function parseTomlValue(raw: string): unknown {
  const value = raw.trim()
  if (value === 'true') return true
  if (value === 'false') return false
  if (value.startsWith('"')) {
    const end = findStringEnd(value, 0)
    if (end < 0) return undefined
    try { return JSON.parse(value.slice(0, end + 1)) as string } catch { return undefined }
  }
  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1)
    return end < 0 ? undefined : value.slice(1, end)
  }
  if (value.startsWith('[')) {
    const items: string[] = []
    let i = 1
    while (i < value.length) {
      const ch = value[i]!
      if (ch === ']') return items
      if (ch === '"') {
        const end = findStringEnd(value, i)
        if (end < 0) return undefined
        try { items.push(JSON.parse(value.slice(i, end + 1)) as string) } catch { return undefined }
        i = end + 1
        continue
      }
      if (ch === "'") {
        const end = value.indexOf("'", i + 1)
        if (end < 0) return undefined
        items.push(value.slice(i + 1, end))
        i = end + 1
        continue
      }
      i += 1
    }
    return undefined
  }
  return undefined
}

function findStringEnd(value: string, start: number): number {
  for (let i = start + 1; i < value.length; i += 1) {
    if (value[i] === '\\') { i += 1; continue }
    if (value[i] === '"') return i
  }
  return -1
}

/** Header of a TOML table: `[mcp_servers.<name>]` (bare or quoted name), nested tables ignored. */
const CODEX_SERVER_TABLE = /^\s*\[\s*mcp_servers\.(?:"((?:[^"\\]|\\.)+)"|([A-Za-z0-9_-]+))\s*\]\s*(?:#.*)?$/
const ANY_TABLE = /^\s*\[/

/**
 * `[mcp_servers.*]` tables of a Codex `config.toml`: name, transport and the
 * `enabled` switch. Same table rule Core uses to find declared servers.
 * Multi-line arrays are not needed by Codex MCP tables and are skipped.
 */
export function parseCodexMcpServers(toml: string): DetectedConnector[] {
  const servers = new Map<string, DetectedConnector>()
  let current: DetectedConnector | null = null
  for (const line of toml.split(/\r?\n/)) {
    const table = CODEX_SERVER_TABLE.exec(line)
    if (table) {
      let name: string
      try { name = table[1] ? JSON.parse(`"${table[1]}"`) as string : table[2]! } catch { current = null; continue }
      current = servers.get(name) ?? { provider: 'codex', name, kind: 'mcp-server', transport: {}, enabledInProvider: true }
      servers.set(name, current)
      continue
    }
    if (ANY_TABLE.test(line)) { current = null; continue }
    if (!current) continue
    const assignment = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line)
    if (!assignment) continue
    const [, key, raw] = assignment
    const value = parseTomlValue(raw!)
    if (key === 'command' && typeof value === 'string') current.transport = { ...current.transport, command: value }
    else if (key === 'args' && Array.isArray(value)) current.transport = { ...current.transport, args: value as string[] }
    else if (key === 'url' && typeof value === 'string') current.transport = { ...current.transport, url: value }
    else if (key === 'enabled' && typeof value === 'boolean') current.enabledInProvider = value
  }
  return [...servers.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Servers of a native JSON `mcpServers` map (Claude `~/.claude.json`, Gemini, Kimi). */
export function parseJsonMcpServers(provider: ConnectorProvider, json: unknown, options: { excluded?: readonly string[] } = {}): DetectedConnector[] {
  if (!isRecord(json) || !isRecord(json.mcpServers)) return []
  const excluded = new Set(options.excluded ?? [])
  return Object.entries(json.mcpServers)
    .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
    .map(([name, config]) => ({
      provider,
      name,
      kind: 'mcp-server' as const,
      transport: {
        ...(typeof config.command === 'string' ? { command: config.command } : {}),
        ...(Array.isArray(config.args) ? { args: config.args.filter((arg): arg is string => typeof arg === 'string') } : {}),
        ...(typeof config.url === 'string' ? { url: config.url } : typeof config.httpUrl === 'string' ? { url: config.httpUrl } : {}),
        ...(typeof config.type === 'string' ? { type: config.type } : {}),
      },
      config,
      enabledInProvider: !excluded.has(name) && config.disabled !== true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Gemini's own `mcp.excluded` list in `~/.gemini/settings.json`. */
export function geminiExcluded(json: unknown): string[] {
  if (!isRecord(json) || !isRecord(json.mcp)) return []
  return cleanNames(json.mcp.excluded)
}

/** Prefix Claude Code gives account connectors (`claude.ai Google Drive`). */
export const CLAUDE_ACCOUNT_CONNECTOR_PREFIX = 'claude.ai '

/**
 * Account connectors from `claude mcp list` output, e.g.
 * `claude.ai Google Drive: https://… - ✔ Connected`. Other servers are read
 * from the config files instead (plugins are not loaded in missions).
 */
export function parseClaudeMcpList(stdout: string): DetectedConnector[] {
  const out = new Map<string, DetectedConnector>()
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith(CLAUDE_ACCOUNT_CONNECTOR_PREFIX)) continue
    const colon = line.indexOf(': ')
    if (colon < 0) continue
    const name = line.slice(0, colon).trim()
    const rest = line.slice(colon + 2)
    const dash = rest.lastIndexOf(' - ')
    const url = (dash >= 0 ? rest.slice(0, dash) : rest).trim()
    const health = dash >= 0 ? rest.slice(dash + 3).toLowerCase() : ''
    const status: DetectedConnector['status'] = health.includes('connected')
      ? 'connected'
      : health.includes('auth') ? 'needs-auth' : health.includes('fail') ? 'failed' : 'unknown'
    out.set(name, { provider: 'claude', name, kind: 'account-connector', transport: url ? { url } : {}, enabledInProvider: true, status })
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Account connector names Claude Code remembers (`claudeAiMcpEverConnected`): the fallback when the probe fails. */
export function claudeRememberedConnectors(json: unknown): DetectedConnector[] {
  if (!isRecord(json)) return []
  return cleanNames(json.claudeAiMcpEverConnected)
    .filter((name) => name.startsWith(CLAUDE_ACCOUNT_CONNECTOR_PREFIX))
    .map((name) => ({ provider: 'claude' as const, name, kind: 'account-connector' as const, enabledInProvider: true, status: 'unknown' as const }))
}

// ─── Specrails' own MCP ───────────────────────────────────────────────────────

const SPECRAILS_NAME = 'specrails'

/**
 * True when a user-config server is Specrails' own MCP: the reserved name, the
 * bundled bridge script (`specrails-mcp.js`) or the Desktop HTTP endpoint.
 * Such a server is always excluded from missions: the mission already has its
 * own capability-bound Specrails server.
 */
export function isSpecrailsDuplicate(connector: Pick<DetectedConnector, 'name' | 'transport'>): boolean {
  if (connector.name.trim().toLowerCase() === SPECRAILS_NAME) return true
  const transport = connector.transport ?? {}
  const parts = [transport.command ?? '', ...(transport.args ?? [])]
  if (parts.some((part) => /(?:^|[\\/])specrails-mcp(?:\.js|\.cjs|\.mjs|\.exe)?$/i.test(part.trim()))) return true
  if (transport.url) {
    try {
      const url = new URL(transport.url)
      if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && /^\/api\/mcp\/?$/.test(url.pathname)) return true
    } catch { /* not a URL */ }
  }
  return false
}

// ─── Inventory shown in Settings ──────────────────────────────────────────────

export interface ConnectorRow {
  name: string
  kind: ConnectorKind
  enabled: boolean
  /** Present when the toggle has no effect / is not offered. */
  lock?: ConnectorLock
  status?: DetectedConnector['status']
  transport?: ConnectorTransport
  size?: ConnectorSize
}

export interface ProviderConnectors {
  provider: ConnectorProvider
  /** The provider's user config was found (or the CLI answered). */
  detected: boolean
  connectors: ConnectorRow[]
  /** Claude: its user-scope servers are only loaded once the driver loads MCP tools on demand (tool search). */
  userServersNeedToolSearch?: boolean
}

/**
 * Settings rows for one provider. `injected` are the names Specrails adds
 * itself for this provider (External MCP servers): those are its own choice,
 * not the provider's, so the deny-list never applies to them.
 */
export function connectorRows(
  provider: ConnectorProvider,
  detected: readonly DetectedConnector[],
  settings: MissionConnectorSettings,
  options: { injected?: readonly string[]; sizes?: Readonly<Record<string, ConnectorSize>> } = {},
): ConnectorRow[] {
  const disabled = new Set(settings.disabled[provider])
  const injected = new Set(options.injected ?? [])
  return detected.map((connector) => {
    const lock: ConnectorLock | undefined = isSpecrailsDuplicate(connector)
      ? 'specrails-duplicate'
      : !connector.enabledInProvider
        ? 'disabled-in-provider'
        : injected.has(connector.name)
          ? 'external-mcp'
          : provider === 'kimi' ? 'unsupported' : undefined
    const enabled = lock === 'specrails-duplicate' || lock === 'disabled-in-provider' ? false : lock ? true : !disabled.has(connector.name)
    const size = options.sizes?.[`${provider}:${connector.name}`]
    return {
      name: connector.name,
      kind: connector.kind,
      enabled,
      ...(lock ? { lock } : {}),
      ...(connector.status ? { status: connector.status } : {}),
      ...(connector.transport && Object.keys(connector.transport).length ? { transport: connector.transport } : {}),
      ...(size ? { size } : {}),
    }
  })
}

// ─── Translation into a mission turn ─────────────────────────────────────────

/** MCP spec as Core's session protocol takes it (name-only = "keep the user's definition"). */
export interface ConnectorServerSpec {
  name: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

export interface ConnectorTurnPlan {
  /** Core `policy.mcp.inheritUserScope`. */
  inheritUserScope: boolean
  /** Extra specs to add to the turn's MCP servers. */
  servers: ConnectorServerSpec[]
  /** Provider-native names to switch off (Claude deny file, Gemini `mcp.excluded`, legacy Codex `-c`). */
  denied: string[]
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  return entries.length ? Object.fromEntries(entries) : undefined
}

/** A Claude user-scope config entry as a structured spec; null when Core cannot express it (e.g. `sse`). */
export function claudeUserServerSpec(connector: DetectedConnector): ConnectorServerSpec | null {
  const config = connector.config ?? {}
  const type = typeof config.type === 'string' ? config.type : undefined
  if (typeof config.url === 'string' && (type === undefined || type === 'http' || type === 'streamable-http')) {
    const headers = stringRecord(config.headers)
    return { name: connector.name, url: config.url, ...(headers ? { headers } : {}) }
  }
  if (typeof config.command === 'string' && (type === undefined || type === 'stdio')) {
    const env = stringRecord(config.env)
    return { name: connector.name, command: config.command, args: Array.isArray(config.args) ? config.args.filter((arg): arg is string => typeof arg === 'string') : [], ...(env ? { env } : {}) }
  }
  return null
}

/**
 * The connector plan of one mission turn.
 * `reserved` are the names the turn already carries (Specrails, External MCP
 * servers, plugins): never denied and never added twice.
 * `deferredMcpTools` says whether the session's driver loads MCP tool
 * definitions on demand (Claude tool search).
 */
export function connectorTurnPlan(
  provider: string,
  detected: readonly DetectedConnector[],
  settings: MissionConnectorSettings,
  options: { reserved: readonly string[]; deferredMcpTools?: boolean },
): ConnectorTurnPlan {
  if (!isConnectorProvider(provider)) return { inheritUserScope: true, servers: [], denied: [] }
  const reserved = new Set(options.reserved)
  const disabled = new Set(settings.disabled[provider])
  const off = (connector: DetectedConnector) => isSpecrailsDuplicate(connector) || !connector.enabledInProvider || disabled.has(connector.name)
  const candidates = detected.filter((connector) => !reserved.has(connector.name))
  if (provider === 'codex') {
    return {
      inheritUserScope: false,
      servers: candidates.filter((connector) => !off(connector)).map((connector) => ({ name: connector.name })),
      denied: candidates.filter(off).map((connector) => connector.name),
    }
  }
  if (provider === 'claude') {
    const servers = options.deferredMcpTools
      ? candidates.filter((connector) => connector.kind === 'mcp-server' && !off(connector)).map(claudeUserServerSpec).filter((spec): spec is ConnectorServerSpec => spec !== null)
      : []
    // The deny file matches by name, so a stored "off" applies even before the connector is detected again.
    return { inheritUserScope: true, servers, denied: [...disabled].filter((name) => !reserved.has(name)).sort() }
  }
  if (provider === 'gemini') {
    // Project settings may replace the user's own `mcp.excluded`: keep those excluded too.
    return { inheritUserScope: true, servers: [], denied: candidates.filter(off).map((connector) => connector.name) }
  }
  return { inheritUserScope: true, servers: [], denied: [] }
}

/**
 * A short, stable tag of the turned-off connectors (null when none). Added to
 * the Specrails spec's env, it changes the session policy when the set
 * changes, so Core restarts an idle resident process before the next turn and
 * the provider reads its switch file again.
 */
export function connectorsMarker(denied: readonly string[]): string | null {
  if (denied.length === 0) return null
  let hash = 0x811c9dc5
  for (const char of [...new Set(denied)].sort().join('\n')) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** `-c` overrides that switch Codex servers off on a legacy (non-Core) turn. Names Codex cannot address bare are skipped. */
export function codexDisableOverrides(denied: readonly string[]): string[] {
  return denied.filter((name) => /^[A-Za-z0-9_-]+$/.test(name)).flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`])
}

/** Body of the agent cwd's `.claude/settings.local.json` for a deny-list. */
export function claudeDenySettings(denied: readonly string[]): { deniedMcpServers: Array<{ serverName: string }> } {
  return { deniedMcpServers: [...new Set(denied)].sort().map((serverName) => ({ serverName })) }
}

/**
 * Approximate tokens of tool definitions sent in full. Calibrated on Claude:
 * Specrails' 33 tool definitions (88.0k JSON characters) measured ~32.3k input
 * tokens on haiku, i.e. ~2.7 characters per token.
 */
export function approximateToolTokens(definitionChars: number): number {
  return Math.round(definitionChars / 2.7)
}
