/**
 * Connectors in missions, effectful side: reads each provider's user config
 * (async, read-only), asks Claude Code for its claude.ai account connectors
 * (`claude mcp list`, async with a timeout), caches the result, measures tool
 * definition sizes on request, stores the deny-list and writes the provider
 * native switch files the next mission turn reads. Rules live in
 * `mission-connectors.ts`.
 */
import fs, { promises as fsp } from 'fs'
import os from 'os'
import path from 'path'
import type { DbInstance } from '../../../db'
import { getDesktopSetting, setDesktopSetting } from '../../../desktop-db'
import { spawnCli, treeKillSafe } from '../../../util/win-spawn'
import { updateClaudeLocalSettings } from '../../agent-policy'
import {
  MISSION_CONNECTORS_SETTING_KEY,
  applyConnectorToggle,
  approximateToolTokens,
  claudeDenySettings,
  claudeRememberedConnectors,
  connectorRows,
  connectorTurnPlan,
  geminiExcluded,
  isSpecrailsDuplicate,
  parseClaudeMcpList,
  parseCodexMcpServers,
  parseConnectorSettings,
  parseJsonMcpServers,
  type ConnectorProvider,
  type ConnectorSize,
  type ConnectorTurnPlan,
  type DetectedConnector,
  type MissionConnectorSettings,
  type ProviderConnectors,
} from './mission-connectors'

export const MISSION_CONNECTOR_SIZES_SETTING_KEY = 'mission_connector_sizes'

/** How long a discovery stays fresh before the next read refreshes it in the background. */
const INVENTORY_TTL_MS = 10 * 60_000
const CLAUDE_LIST_TIMEOUT_MS = 30_000
const SIZE_PROBE_TIMEOUT_MS = 20_000

export interface ConnectorInventory {
  detectedAt: string
  byProvider: Record<ConnectorProvider, { detected: boolean; connectors: DetectedConnector[] }>
  /** The claude.ai list came from Claude Code's memory, not a live probe. */
  claudeAccountListStale: boolean
}

export interface MissionConnectorsOptions {
  db: DbInstance
  env?: NodeJS.ProcessEnv
  /** Home directory (tests). */
  home?: () => string
  /** `claude mcp list` stdout, or null when Claude Code did not answer. */
  listClaudeConnectors?: () => Promise<string | null>
  /** Tool definitions of a stdio server, or null when it did not answer. */
  probeTools?: (command: string, args: string[], env: Record<string, string>) => Promise<{ tools: number; chars: number } | null>
  /** Neutral cwd for the Claude probe (no project deny-lists apply). */
  probeCwd?: () => string
  now?: () => Date
}

function defaultHome(): string {
  return process.env.SPECRAILS_REGISTRY_HOME || os.homedir()
}

async function readText(file: string): Promise<string | null> {
  try { return await fsp.readFile(file, 'utf-8') } catch { return null }
}

async function readJson(file: string): Promise<unknown> {
  const text = await readText(file)
  if (text === null) return null
  try { return JSON.parse(text) as unknown } catch { return null }
}

/** `claude mcp list` in a neutral cwd, killed (with its children) after a timeout. */
export function runClaudeMcpList(options: { binary?: string; cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }): Promise<string | null> {
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    let child: ReturnType<typeof spawnCli>
    const finish = (value: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    try {
      child = spawnCli(options.binary ?? 'claude', ['mcp', 'list'], { cwd: options.cwd, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch {
      resolve(null)
      return
    }
    const timer = setTimeout(() => {
      if (child.pid) treeKillSafe(child.pid, 'SIGKILL')
      finish(null)
    }, options.timeoutMs ?? CLAUDE_LIST_TIMEOUT_MS)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { if (out.length < 256_000) out += chunk })
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code === 0 ? out : null))
  })
}

/**
 * List a stdio MCP server's tools (initialize + tools/list) and stop it.
 * The command is the user's own config entry, the same one the provider
 * starts at every mission turn; only run on an explicit "Measure".
 */
export function probeStdioTools(command: string, args: string[], env: Record<string, string>, timeoutMs = SIZE_PROBE_TIMEOUT_MS): Promise<{ tools: number; chars: number } | null> {
  return new Promise((resolve) => {
    let settled = false
    let buffer = ''
    let child: ReturnType<typeof spawnCli>
    const finish = (value: { tools: number; chars: number } | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (child?.pid) treeKillSafe(child.pid, 'SIGKILL')
      resolve(value)
    }
    try {
      child = spawnCli(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    } catch {
      resolve(null)
      return
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    const send = (message: Record<string, unknown>) => {
      try { child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`) } catch { finish(null) }
    }
    child.on('error', () => finish(null))
    child.on('close', () => finish(null))
    child.stdin?.on('error', () => finish(null))
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        let message: { id?: unknown; result?: { tools?: unknown } }
        try { message = JSON.parse(line) as typeof message } catch { continue }
        if (message.id === 1) {
          send({ method: 'notifications/initialized' })
          send({ id: 2, method: 'tools/list', params: {} })
        } else if (message.id === 2) {
          const tools = Array.isArray(message.result?.tools) ? message.result.tools : []
          finish({ tools: tools.length, chars: JSON.stringify(tools).length })
        }
      }
    })
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'specrails-connector-size', version: '1' } } })
  })
}

/**
 * App-wide service (one per Desktop): the inventory is per machine, the
 * deny-list is an app setting, so nothing here is project state.
 */
export class MissionConnectors {
  private inventoryCache: ConnectorInventory | null = null
  private inflight: Promise<ConnectorInventory> | null = null
  private measuring: Promise<void> | null = null
  /** Whether the last Claude Core turn's driver loaded MCP tools on demand (null: no Claude Core turn yet). */
  private claudeDeferredTools: boolean | null = null

  constructor(private readonly options: MissionConnectorsOptions) {}

  private get env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env
  }

  private home(): string {
    return (this.options.home ?? defaultHome)()
  }

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  settings(): MissionConnectorSettings {
    return parseConnectorSettings(getDesktopSetting(this.options.db, MISSION_CONNECTORS_SETTING_KEY))
  }

  /** Apply one toggle and persist it. Throws `ConnectorSettingsValidationError`. */
  toggle(body: unknown): MissionConnectorSettings {
    const next = applyConnectorToggle(this.settings(), body)
    setDesktopSetting(this.options.db, MISSION_CONNECTORS_SETTING_KEY, JSON.stringify(next))
    return next
  }

  sizes(): Record<string, ConnectorSize> {
    const raw = getDesktopSetting(this.options.db, MISSION_CONNECTOR_SIZES_SETTING_KEY)
    if (!raw) return {}
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      const out: Record<string, ConnectorSize> = {}
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const size = value as Partial<ConnectorSize>
        if (typeof size?.tools === 'number' && typeof size.tokens === 'number' && typeof size.measuredAt === 'string') out[key] = { tools: size.tools, tokens: size.tokens, measuredAt: size.measuredAt }
      }
      return out
    } catch {
      return {}
    }
  }

  private codexConfigFile(): string {
    const home = this.env.CODEX_HOME?.trim() || path.join(this.home(), '.codex')
    return path.join(home, 'config.toml')
  }

  private claudeConfigFile(): string {
    const dir = this.env.CLAUDE_CONFIG_DIR?.trim()
    return dir ? path.join(dir, '.claude.json') : path.join(this.home(), '.claude.json')
  }

  private probeCwd(): string {
    return this.options.probeCwd?.() ?? path.join(this.home(), '.specrails', 'connectors-probe-cwd')
  }

  private async detect(options: { probeClaude?: boolean } = {}): Promise<ConnectorInventory> {
    const [codexToml, claudeJson, geminiJson, kimiJson, claudeList] = await Promise.all([
      readText(this.codexConfigFile()),
      readJson(this.claudeConfigFile()),
      readJson(this.geminiSettingsFile()),
      readJson(this.kimiMcpFile()),
      options.probeClaude === false ? Promise.resolve(null) : this.listClaude(),
    ])
    return this.buildInventory(codexToml, claudeJson, geminiJson, kimiJson, claudeList)
  }

  /** The provider configs only, read synchronously: a few small files, for a turn with no cached inventory. */
  private detectConfigsSync(): ConnectorInventory {
    const text = (file: string): string | null => { try { return fs.readFileSync(file, 'utf-8') } catch { return null } }
    const json = (file: string): unknown => { const raw = text(file); if (raw === null) return null; try { return JSON.parse(raw) } catch { return null } }
    return this.buildInventory(text(this.codexConfigFile()), json(this.claudeConfigFile()), json(this.geminiSettingsFile()), json(this.kimiMcpFile()), null)
  }

  private geminiSettingsFile(): string {
    return path.join(this.home(), '.gemini', 'settings.json')
  }

  private kimiMcpFile(): string {
    return path.join(this.home(), '.kimi-code', 'mcp.json')
  }

  private buildInventory(codexToml: string | null, claudeJson: unknown, geminiJson: unknown, kimiJson: unknown, claudeList: string | null): ConnectorInventory {
    const claudeUser = parseJsonMcpServers('claude', claudeJson)
    const live = claudeList === null ? null : parseClaudeMcpList(claudeList)
    const accounts = live ?? claudeRememberedConnectors(claudeJson)
    return {
      detectedAt: this.now().toISOString(),
      byProvider: {
        claude: { detected: claudeJson !== null || live !== null, connectors: [...accounts, ...claudeUser] },
        codex: { detected: codexToml !== null, connectors: codexToml ? parseCodexMcpServers(codexToml) : [] },
        gemini: { detected: geminiJson !== null, connectors: parseJsonMcpServers('gemini', geminiJson, { excluded: geminiExcluded(geminiJson) }) },
        kimi: { detected: kimiJson !== null, connectors: parseJsonMcpServers('kimi', kimiJson) },
      },
      claudeAccountListStale: live === null,
    }
  }

  private async listClaude(): Promise<string | null> {
    if (this.options.listClaudeConnectors) return this.options.listClaudeConnectors()
    const cwd = this.probeCwd()
    try { await fsp.mkdir(cwd, { recursive: true, mode: 0o700 }) } catch { /* the probe reports null */ }
    return runClaudeMcpList({ cwd, env: this.env })
  }

  /**
   * The cached inventory. A missing or `refresh` inventory is detected now;
   * a stale one is returned at once and refreshed in the background.
   */
  async inventory(options: { refresh?: boolean } = {}): Promise<ConnectorInventory> {
    const cached = this.inventoryCache
    const fresh = cached && this.now().getTime() - Date.parse(cached.detectedAt) < INVENTORY_TTL_MS
    if (cached && !options.refresh) {
      if (!fresh) void this.detectOnce().catch(() => {})
      return cached
    }
    return this.detectOnce()
  }

  private detectOnce(): Promise<ConnectorInventory> {
    if (!this.inflight) {
      this.inflight = this.detect()
        .then((inventory) => { this.inventoryCache = inventory; return inventory })
        .finally(() => { this.inflight = null })
    }
    return this.inflight
  }

  /**
   * The inventory a mission turn uses: the cached one, else the provider
   * configs only. A turn never runs or waits for `claude mcp list` (it starts
   * every configured server); the Claude deny-list is by name, so the
   * connectors Claude Code remembers are enough.
   */
  private async turnInventory(): Promise<ConnectorInventory> {
    return this.inventoryCache ?? this.detect({ probeClaude: false })
  }

  /** Settings payload: rows per provider. `injected` maps provider → names Specrails adds itself. */
  async view(options: { refresh?: boolean; injected?: (provider: ConnectorProvider) => string[] } = {}): Promise<{ detectedAt: string; claudeAccountListStale: boolean; measuring: boolean; providers: ProviderConnectors[] }> {
    const inventory = await this.inventory({ refresh: options.refresh })
    const settings = this.settings()
    const sizes = this.sizes()
    const providers = (Object.keys(inventory.byProvider) as ConnectorProvider[]).map((provider) => ({
      provider,
      detected: inventory.byProvider[provider].detected,
      connectors: connectorRows(provider, inventory.byProvider[provider].connectors, settings, { injected: options.injected?.(provider) ?? [], sizes }),
      ...(provider === 'claude' ? { userServersNeedToolSearch: this.claudeDeferredTools !== true } : {}),
    }))
    return { detectedAt: inventory.detectedAt, claudeAccountListStale: inventory.claudeAccountListStale, measuring: this.measuring !== null, providers }
  }

  /** Measure the tool definitions of every stdio user server (explicit request; bounded concurrency). */
  measure(): Promise<void> {
    if (this.measuring) return this.measuring
    const probe = this.options.probeTools ?? ((command, args, env) => probeStdioTools(command, args, env))
    this.measuring = (async () => {
      const inventory = await this.inventory()
      const targets: Array<{ key: string; command: string; args: string[]; env: Record<string, string> }> = []
      for (const [provider, entry] of Object.entries(inventory.byProvider) as Array<[ConnectorProvider, ConnectorInventory['byProvider'][ConnectorProvider]]>) {
        for (const connector of entry.connectors) {
          const command = connector.transport?.command
          if (!command || connector.transport?.url || isSpecrailsDuplicate(connector)) continue
          const rawEnv = (connector.config?.env ?? {}) as Record<string, unknown>
          const env = Object.fromEntries(Object.entries(rawEnv).filter((pair): pair is [string, string] => typeof pair[1] === 'string'))
          targets.push({ key: `${provider}:${connector.name}`, command, args: connector.transport?.args ?? [], env })
        }
      }
      const sizes = this.sizes()
      const queue = [...targets]
      const worker = async () => {
        for (let target = queue.shift(); target; target = queue.shift()) {
          const result = await probe(target.command, target.args, target.env).catch(() => null)
          if (result) sizes[target.key] = { tools: result.tools, tokens: approximateToolTokens(result.chars), measuredAt: this.now().toISOString() }
        }
      }
      await Promise.all([worker(), worker()])
      setDesktopSetting(this.options.db, MISSION_CONNECTOR_SIZES_SETTING_KEY, JSON.stringify(sizes))
    })().finally(() => { this.measuring = null })
    return this.measuring
  }

  /**
   * The same plan as `planFor`, computed synchronously: legacy mission turns
   * call this so nothing asynchronous sits between a turn's start and its
   * spawn (a Stop in that gap must not let the turn continue). It uses the
   * cached inventory, else reads the provider configs synchronously; like
   * `planFor` it never runs `claude mcp list`. Never throws.
   */
  planForCached(provider: string, options: { reserved: readonly string[]; deferredMcpTools?: boolean }): ConnectorTurnPlan {
    if (provider === 'claude' && options.deferredMcpTools !== undefined) this.claudeDeferredTools = options.deferredMcpTools
    try {
      const inventory = this.inventoryCache ?? this.detectConfigsSync()
      const detected = (inventory.byProvider as Record<string, { connectors: DetectedConnector[] } | undefined>)[provider]?.connectors ?? []
      return connectorTurnPlan(provider, detected, this.settings(), options)
    } catch (error) {
      console.warn(`[mission-connectors] using the provider defaults: ${(error as Error).message}`)
      return { inheritUserScope: true, servers: [], denied: [] }
    }
  }

  /**
   * The connector plan of a mission turn on `provider`. `reserved` are names
   * the turn already carries. Never throws: a failed read keeps the provider's
   * defaults (inherit everything) rather than blocking the turn.
   */
  async planFor(provider: string, options: { reserved: readonly string[]; deferredMcpTools?: boolean }): Promise<ConnectorTurnPlan> {
    if (provider === 'claude' && options.deferredMcpTools !== undefined) this.claudeDeferredTools = options.deferredMcpTools
    try {
      const inventory = await this.turnInventory()
      const detected = (inventory.byProvider as Record<string, { connectors: DetectedConnector[] } | undefined>)[provider]?.connectors ?? []
      return connectorTurnPlan(provider, detected, this.settings(), options)
    } catch (error) {
      console.warn(`[mission-connectors] using the provider defaults: ${(error as Error).message}`)
      return { inheritUserScope: true, servers: [], denied: [] }
    }
  }
}

/**
 * Write the Claude connector deny-list into an app-owned mission cwd's
 * `.claude/settings.local.json` (read through `--setting-sources project,local`).
 * Owns only the `deniedMcpServers` key: every other key (the agent policy
 * hook, see server/modules/agent-policy) is kept. An empty list removes the
 * key, and the file only when nothing else is left. Atomic; never touches a
 * project directory.
 */
export function writeClaudeConnectorDenyFile(cwd: string, denied: readonly string[]): void {
  // Synchronous on purpose: it runs on a mission turn's start, where no async
  // gap may precede the spawn. It is one tiny file, written only on change.
  updateClaudeLocalSettings(cwd, (settings) => {
    const next = { ...settings }
    if (denied.length === 0) delete next.deniedMcpServers
    else next.deniedMcpServers = claudeDenySettings(denied).deniedMcpServers
    return next
  })
}

/**
 * Merge Gemini's `mcp.excluded` into a mission's project settings file
 * (`<conversation cwd>/.gemini/settings.json`), keeping every other key.
 */
export function writeGeminiExcluded(settingsFile: string, denied: readonly string[]): void {
  // Synchronous for the same reason as the Claude deny file.
  let current: Record<string, unknown> = {}
  let parsed: unknown = null
  try { parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) } catch { /* absent or unreadable */ }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed as Record<string, unknown>
  const mcp = current.mcp && typeof current.mcp === 'object' && !Array.isArray(current.mcp) ? { ...(current.mcp as Record<string, unknown>) } : {}
  if (denied.length) mcp.excluded = [...new Set(denied)].sort()
  else delete mcp.excluded
  const next = { ...current, ...(Object.keys(mcp).length ? { mcp } : {}) }
  if (!Object.keys(mcp).length) delete next.mcp
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true, mode: 0o700 })
  fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2), { mode: 0o600 })
}
