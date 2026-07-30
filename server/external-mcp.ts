/**
 * External MCP servers registry — app-level (per-machine) configuration of the
 * user's OWN MCP servers for the MISSION agent (Desktop agent chat), with a
 * per-provider activation matrix.
 *
 * Storage is one JSON blob under `desktop_settings['external_mcp_servers']`
 * (no migration — plain k/v, precedent: `specrails_agent_defaults`).
 *
 * Two entry kinds:
 *   - `discovered` (`d:<sourceProvider>:<name>`): the app persists SELECTION
 *     ONLY — the transport is re-resolved LIVE from the source provider's
 *     native user config at spawn time, so user edits flow through and a
 *     removed server degrades to an orphan (skipped at spawn), never a broken
 *     mission turn.
 *   - `custom` (`c:<name>`): full stdio transport stored in the blob.
 *
 * Discovery reads provider native configs READ-ONLY and never writes them:
 *   claude → ~/.claude.json          (top-level mcpServers)
 *   gemini → ~/.gemini/settings.json (mcpServers)
 *   kimi   → ~/.kimi-code/mcp.json   (mcpServers)
 *   codex  → ~/.codex/config.toml    (names only — codex mission spawns keep
 *            the user's real CODEX_HOME and load these natively; display-only)
 *
 * Consent-first: discovery only lists; every entry starts fully unticked and
 * the per-provider tick in Settings is the consent act (mission spawns run
 * with --dangerously-skip-permissions and external tools live OUTSIDE the
 * Shift+Tab tier ladder).
 *
 * Kill switch: SPECRAILS_EXTERNAL_MCP=false|0|off (case-insensitive) bypasses
 * all resolution — mission wiring stays byte-identical to the pre-change app.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { DbInstance } from './db'
import { getDesktopSetting, setDesktopSetting } from './desktop-db'
import { listAdapters } from './providers'

export const EXTERNAL_MCP_SETTING_KEY = 'external_mcp_servers'

/** Server name the embedded Specrails bridge always owns — never injectable. */
export const RESERVED_SERVER_NAME = 'specrails'

/** Providers whose native config is parsed as a full JSON mcpServers map. */
export const DISCOVERY_SOURCE_PROVIDERS = ['claude', 'gemini', 'kimi'] as const
export type DiscoverySourceProvider = (typeof DISCOVERY_SOURCE_PROVIDERS)[number]

const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** TOML/`-c` override keys tolerate a narrower charset than JSON keys. */
const CODEX_SAFE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/

export interface ExternalMcpTransport {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface ExternalMcpServerEntry {
  source: 'discovered' | 'custom'
  /** Present iff source === 'discovered'. */
  sourceProvider?: DiscoverySourceProvider
  /** The injected MCP server name. */
  name: string
  /** Per-provider activation matrix (adapter id → enabled). */
  providers: Record<string, boolean>
  /** Present iff source === 'custom' (stdio only in v1). */
  transport?: ExternalMcpTransport
}

export interface ExternalMcpSettings {
  version: 1
  servers: Record<string, ExternalMcpServerEntry>
}

export interface DiscoveredServer {
  /** Stable registry id (`d:<provider>:<name>`). */
  id: string
  name: string
}

export interface ExternalMcpDiscovery {
  claude: DiscoveredServer[]
  gemini: DiscoveredServer[]
  kimi: DiscoveredServer[]
  /** Codex `[mcp_servers.*]` names — native, always on, display-only. */
  codexNative: string[]
  /** Stored discovered selections whose source config no longer defines them. */
  orphanIds: string[]
}

/** A server ready to inject into a mission spawn. `config` is relayed as-is
 *  for JSON-file registrations; codex `-c` overrides additionally require a
 *  string `command`. */
export interface ResolvedExternalServer {
  id: string
  name: string
  config: Record<string, unknown>
}

export class ExternalMcpValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'ExternalMcpValidationError'
  }
}

const EMPTY_SETTINGS: ExternalMcpSettings = { version: 1, servers: {} }

export function isExternalMcpEnabled(): boolean {
  const raw = (process.env.SPECRAILS_EXTERNAL_MCP ?? '').trim().toLowerCase()
  return !(raw === 'false' || raw === '0' || raw === 'off')
}

function homeDir(): string {
  return process.env.SPECRAILS_REGISTRY_HOME || os.homedir()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ─── Native-config discovery (read-only, tolerant) ───────────────────────────

function readJsonFile(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** The `mcpServers` map from a native JSON config; `{}` on any failure. */
function readMcpServersMap(file: string, key = 'mcpServers'): Record<string, Record<string, unknown>> {
  const parsed = readJsonFile(file)
  const map = parsed?.[key]
  if (!isRecord(map)) return {}
  const out: Record<string, Record<string, unknown>> = {}
  for (const [name, entry] of Object.entries(map)) {
    if (isRecord(entry)) out[name] = entry
  }
  return out
}

function nativeConfigPath(provider: DiscoverySourceProvider): string {
  const home = homeDir()
  switch (provider) {
    case 'claude':
      return path.join(home, '.claude.json')
    case 'gemini':
      return path.join(home, '.gemini', 'settings.json')
    case 'kimi':
      return path.join(home, '.kimi-code', 'mcp.json')
  }
}

/** Read one source provider's native user-scope mcpServers map. Never throws. */
export function readNativeMcpServers(provider: DiscoverySourceProvider): Record<string, Record<string, unknown>> {
  return readMcpServersMap(nativeConfigPath(provider))
}

/** Codex `[mcp_servers.<name>]` table names from config.toml. Names only —
 *  codex loads these natively in missions; no transport parsing (no TOML dep). */
export function readCodexNativeServerNames(): string[] {
  const file = path.join(homeDir(), '.codex', 'config.toml')
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf-8')
  } catch {
    return []
  }
  const names = new Set<string>()
  for (const line of raw.split('\n')) {
    const m = /^\s*\[mcp_servers\.([^\][.]+)\]\s*(?:#.*)?$/.exec(line)
    if (m) {
      const name = m[1].trim().replace(/^["']|["']$/g, '')
      if (name) names.add(name)
    }
  }
  return [...names].sort()
}

export function discoveredId(provider: DiscoverySourceProvider, name: string): string {
  return `d:${provider}:${name}`
}

export function customId(name: string): string {
  return `c:${name}`
}

/** Discovery snapshot + orphan flags against the stored selections. */
export function discoverExternalMcp(settings: ExternalMcpSettings): ExternalMcpDiscovery {
  const byProvider = {} as Record<DiscoverySourceProvider, DiscoveredServer[]>
  const presentIds = new Set<string>()
  for (const provider of DISCOVERY_SOURCE_PROVIDERS) {
    const names = Object.keys(readNativeMcpServers(provider)).sort()
    byProvider[provider] = names.map((name) => {
      const id = discoveredId(provider, name)
      presentIds.add(id)
      return { id, name }
    })
  }
  const orphanIds = Object.entries(settings.servers)
    .filter(([id, entry]) => entry.source === 'discovered' && !presentIds.has(id))
    .map(([id]) => id)
    .sort()
  return {
    claude: byProvider.claude,
    gemini: byProvider.gemini,
    kimi: byProvider.kimi,
    codexNative: readCodexNativeServerNames(),
    orphanIds,
  }
}

// ─── Settings read / validate / patch ────────────────────────────────────────

function sanitizeProvidersMatrix(raw: unknown, adapterIds: Set<string>): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  if (!isRecord(raw)) return out
  for (const [id, value] of Object.entries(raw)) {
    if (adapterIds.has(id) && value === true) out[id] = true
  }
  return out
}

/** Structural sanitize for values read from disk — never throws, drops junk. */
function sanitizeStored(raw: unknown): ExternalMcpSettings {
  if (!isRecord(raw) || !isRecord(raw.servers)) return { version: 1, servers: {} }
  const adapterIds = new Set(listAdapters().map((a) => a.id))
  const servers: Record<string, ExternalMcpServerEntry> = {}
  for (const [id, value] of Object.entries(raw.servers)) {
    const entry = tryParseEntry(id, value, adapterIds)
    if (entry) servers[id] = entry
  }
  return { version: 1, servers }
}

/** Parse one stored entry; null on any structural problem (read path). */
function tryParseEntry(id: string, value: unknown, adapterIds: Set<string>): ExternalMcpServerEntry | null {
  if (!isRecord(value)) return null
  const discovered = /^d:([a-z0-9-]+):(.+)$/.exec(id)
  const custom = /^c:(.+)$/.exec(id)
  if (discovered) {
    const provider = discovered[1] as DiscoverySourceProvider
    const name = discovered[2]
    if (!(DISCOVERY_SOURCE_PROVIDERS as readonly string[]).includes(provider)) return null
    if (!SERVER_NAME_PATTERN.test(name) || name === RESERVED_SERVER_NAME) return null
    return {
      source: 'discovered',
      sourceProvider: provider,
      name,
      providers: sanitizeProvidersMatrix(value.providers, adapterIds),
    }
  }
  if (custom) {
    const name = custom[1]
    if (!SERVER_NAME_PATTERN.test(name) || name === RESERVED_SERVER_NAME) return null
    const transport = value.transport
    if (!isRecord(transport) || typeof transport.command !== 'string' || !transport.command.trim()) return null
    const args = Array.isArray(transport.args) ? transport.args.filter((a): a is string => typeof a === 'string') : []
    const env: Record<string, string> = {}
    if (isRecord(transport.env)) {
      for (const [k, v] of Object.entries(transport.env)) {
        if (typeof v === 'string') env[k] = v
      }
    }
    return {
      source: 'custom',
      name,
      providers: sanitizeProvidersMatrix(value.providers, adapterIds),
      transport: { command: transport.command, args, env },
    }
  }
  return null
}

/** Read + sanitize the stored settings. Never throws. */
export function readExternalMcpSettings(db: DbInstance): ExternalMcpSettings {
  try {
    const raw = getDesktopSetting(db, EXTERNAL_MCP_SETTING_KEY)
    if (!raw) return { ...EMPTY_SETTINGS, servers: {} }
    return sanitizeStored(JSON.parse(raw))
  } catch {
    return { ...EMPTY_SETTINGS, servers: {} }
  }
}

/**
 * Validate an untrusted PATCH body and persist it. The blob is replaced
 * wholesale (the client always PATCHes the full settings object). Throws
 * `ExternalMcpValidationError` with an API-stable `code`.
 */
export function applyExternalMcpPatch(db: DbInstance, body: unknown): ExternalMcpSettings {
  if (!isRecord(body) || !isRecord(body.servers)) {
    throw new ExternalMcpValidationError('invalid_body', 'body must be { servers: { … } }')
  }
  const adapterIds = new Set(listAdapters().map((a) => a.id))
  const servers: Record<string, ExternalMcpServerEntry> = {}

  for (const [id, value] of Object.entries(body.servers)) {
    if (!isRecord(value)) {
      throw new ExternalMcpValidationError('invalid_entry', `entry ${JSON.stringify(id)} must be an object`)
    }
    const discovered = /^d:([a-z0-9-]+):(.+)$/.exec(id)
    const custom = /^c:(.+)$/.exec(id)
    if (!discovered && !custom) {
      throw new ExternalMcpValidationError('invalid_entry', `entry id ${JSON.stringify(id)} must be d:<provider>:<name> or c:<name>`)
    }
    const name = discovered ? discovered[2] : custom![1]
    if (name === RESERVED_SERVER_NAME) {
      throw new ExternalMcpValidationError('reserved_name', `server name ${JSON.stringify(RESERVED_SERVER_NAME)} is reserved`)
    }
    if (!SERVER_NAME_PATTERN.test(name)) {
      throw new ExternalMcpValidationError('invalid_entry', `server name ${JSON.stringify(name)} is not a valid MCP server name`)
    }
    if (discovered && !(DISCOVERY_SOURCE_PROVIDERS as readonly string[]).includes(discovered[1])) {
      throw new ExternalMcpValidationError('unknown_provider', `unknown discovery source provider ${JSON.stringify(discovered[1])}`)
    }
    if (isRecord(value.providers)) {
      for (const key of Object.keys(value.providers)) {
        if (!adapterIds.has(key)) {
          throw new ExternalMcpValidationError('unknown_provider', `unknown provider ${JSON.stringify(key)} in activation matrix`)
        }
      }
    }
    if (custom) {
      const transport = value.transport
      if (!isRecord(transport) || typeof transport.command !== 'string' || !transport.command.trim()) {
        throw new ExternalMcpValidationError('invalid_transport', `custom entry ${JSON.stringify(name)} requires a non-empty command`)
      }
    }
    const entry = tryParseEntry(id, value, adapterIds)
    if (!entry) {
      throw new ExternalMcpValidationError('invalid_entry', `entry ${JSON.stringify(id)} is malformed`)
    }
    servers[id] = entry
  }

  // One injected name per provider: two enabled entries sharing a name would
  // collide in the target CLI's mcpServers map.
  for (const adapterId of adapterIds) {
    const seen = new Map<string, string>()
    for (const [id, entry] of Object.entries(servers)) {
      if (entry.providers[adapterId] !== true) continue
      const prior = seen.get(entry.name)
      if (prior) {
        throw new ExternalMcpValidationError(
          'duplicate_server_name',
          `entries ${JSON.stringify(prior)} and ${JSON.stringify(id)} both inject ${JSON.stringify(entry.name)} for provider ${JSON.stringify(adapterId)}`,
        )
      }
      seen.set(entry.name, id)
    }
  }

  const next: ExternalMcpSettings = { version: 1, servers }
  setDesktopSetting(db, EXTERNAL_MCP_SETTING_KEY, JSON.stringify(next))
  return next
}

// ─── Spawn-time resolution ────────────────────────────────────────────────────

/**
 * The external servers to inject into a mission spawn for `adapterId`.
 * Discovered entries re-read their source native config LIVE — an absent
 * server is skipped (logged) so a stale selection can never break the turn.
 * Kill switch off ⇒ `[]` (byte-identical legacy wiring). Never throws.
 */
export function resolveExternalEntries(adapterId: string, db: DbInstance): ResolvedExternalServer[] {
  if (!isExternalMcpEnabled()) return []
  let settings: ExternalMcpSettings
  try {
    settings = readExternalMcpSettings(db)
  } catch {
    return []
  }
  const out: ResolvedExternalServer[] = []
  const nativeCache = new Map<DiscoverySourceProvider, Record<string, Record<string, unknown>>>()
  for (const [id, entry] of Object.entries(settings.servers)) {
    if (entry.providers[adapterId] !== true) continue
    if (entry.name === RESERVED_SERVER_NAME) continue
    if (entry.source === 'custom') {
      const t = entry.transport
      if (!t) continue
      out.push({ id, name: entry.name, config: { command: t.command, args: t.args, env: t.env } })
      continue
    }
    const provider = entry.sourceProvider
    if (!provider) continue
    let map = nativeCache.get(provider)
    if (!map) {
      map = readNativeMcpServers(provider)
      nativeCache.set(provider, map)
    }
    const config = map[entry.name]
    if (!config) {
      console.warn(`[external-mcp] skipping orphaned entry ${id} (not found in ${provider} config)`)
      continue
    }
    out.push({ id, name: entry.name, config })
  }
  return out
}

/** Whether a resolved server can ride codex `-c mcp_servers.<name>.*` overrides
 *  (needs a TOML-safe name and a string command — http-shaped configs cannot). */
export function isCodexInjectable(server: ResolvedExternalServer): boolean {
  return CODEX_SAFE_NAME_PATTERN.test(server.name) && typeof server.config.command === 'string' && !!server.config.command
}
