import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  editClaudeJson, editCodexToml, registrationCommand,
  type BridgeEntry, type ConnectClient, type ConnectScope, type EditOutcome, type EditResult,
} from './client-config'

/**
 * `specrails mcp connect` (Settings ▸ MCP ▸ Connect, and the CLI through
 * `POST /api/mcp-admin/connect`): register the bundled stdio bridge with
 * Claude Code or Codex in one step.
 *
 * Effects are limited to the documented config files of the chosen client
 * and scope. A file is backed up next to itself before it changes, written
 * atomically (temp + rename, through a symlink to its target, with its mode
 * kept) and never reset when it does not parse. Nothing is written when the
 * entry is already current.
 */

export const CONNECT_CLIENTS: readonly ConnectClient[] = ['claude', 'codex']

export interface ConnectEnv {
  /** The OS home of the person (tests pass a temp dir). */
  home: string
  /** Environment for CODEX_HOME / CLAUDE_CONFIG_DIR / PATH lookups. */
  env: Readonly<Record<string, string | undefined>>
  platform: NodeJS.Platform
  now?: () => Date
}

export function defaultConnectEnv(): ConnectEnv {
  return { home: os.homedir(), env: process.env, platform: process.platform }
}

/** Where the client keeps the server entry for a scope. */
export function configPathFor(client: ConnectClient, scope: ConnectScope, cenv: ConnectEnv, projectDir?: string): string {
  if (scope === 'project') {
    if (!projectDir) throw new ConnectError('invalid_input', 'Project scope needs the project directory.')
    return client === 'claude' ? path.join(projectDir, '.mcp.json') : path.join(projectDir, '.codex', 'config.toml')
  }
  if (client === 'claude') {
    const dir = cenv.env.CLAUDE_CONFIG_DIR?.trim()
    return dir ? path.join(dir, '.claude.json') : path.join(cenv.home, '.claude.json')
  }
  const codexHome = cenv.env.CODEX_HOME?.trim()
  return path.join(codexHome || path.join(cenv.home, '.codex'), 'config.toml')
}

export class ConnectError extends Error {
  constructor(public readonly code: 'invalid_input' | 'not_installed' | 'conflict' | 'io' | 'no_bridge', message: string) {
    super(message)
  }
}

/** First executable named `bin` on PATH (PATHEXT on Windows), or null. */
export function findOnPath(bin: string, cenv: ConnectEnv): string | null {
  const dirs = (cenv.env.PATH ?? cenv.env.Path ?? '').split(cenv.platform === 'win32' ? ';' : ':').filter(Boolean)
  const exts = cenv.platform === 'win32' ? (cenv.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext.toLowerCase())
      const upper = path.join(dir, bin + ext)
      for (const file of new Set([candidate, upper])) {
        try {
          const stat = fs.statSync(file)
          if (stat.isFile() && (cenv.platform === 'win32' || (stat.mode & 0o111) !== 0)) return file
        } catch { /* next */ }
      }
    }
  }
  return null
}

export interface ClientDetection {
  client: ConnectClient
  /** The CLI on PATH, or a config home exists. */
  installed: boolean
  binary: string | null
  /** User-scope config file. */
  configPath: string
  /** What connect would do at user scope right now. */
  state: 'connected' | 'outdated' | 'not_connected' | 'conflict'
}

function readText(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8') } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new ConnectError('io', `Cannot read ${file}: ${(err as Error).message}`)
  }
}

function edit(client: ConnectClient, text: string | null, entry: BridgeEntry | null, force: boolean): EditResult {
  return client === 'claude' ? editClaudeJson(text, entry, { force }) : editCodexToml(text, entry, { force })
}

const STATE_OF: Record<EditOutcome, ClientDetection['state']> = {
  unchanged: 'connected', update: 'outdated', create: 'not_connected', conflict: 'conflict', remove: 'connected', absent: 'not_connected',
}

export function detectClients(entry: BridgeEntry | null, cenv: ConnectEnv = defaultConnectEnv()): ClientDetection[] {
  return CONNECT_CLIENTS.map((client) => {
    const binary = findOnPath(client, cenv)
    const configPath = configPathFor(client, 'user', cenv)
    const homeDir = client === 'claude' ? path.join(cenv.home, '.claude') : path.dirname(configPath)
    const installed = binary !== null || fs.existsSync(configPath) || fs.existsSync(homeDir)
    let state: ClientDetection['state'] = 'not_connected'
    try {
      const text = readText(configPath)
      state = entry ? STATE_OF[edit(client, text, entry, false).outcome] : (edit(client, text, null, false).outcome === 'remove' ? 'connected' : 'not_connected')
    } catch { state = 'conflict' }
    return { client, installed, binary, configPath, state }
  })
}

export interface ConnectRequest {
  client: ConnectClient
  scope?: ConnectScope
  projectDir?: string
  remove?: boolean
  dryRun?: boolean
  /** Replace a `specrails` entry that is not the Specrails bridge. */
  force?: boolean
}

export interface ConnectResult {
  client: ConnectClient
  scope: ConnectScope
  file: string
  outcome: EditOutcome
  /** False for dry runs, unchanged and absent. */
  written: boolean
  backup: string | null
  dryRun: boolean
  /** The client's own command for the same registration (no secret). */
  command: string
  /** The `specrails` entry as it will be (or was) written; null on remove. */
  entry: BridgeEntry | null
  reason?: EditResult['reason']
  warnings: string[]
}

function timestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
}

/** Atomic write that keeps a symlinked dotfile a symlink and the file's mode. */
function writeAtomic(file: string, text: string, defaultMode: number): void {
  let target = file
  try { target = fs.realpathSync(file) } catch { /* new file */ }
  let mode = defaultMode
  try { mode = fs.statSync(target).mode & 0o777 } catch { /* new file */ }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.specrails-${process.pid}-${Date.now()}.tmp`
  try {
    fs.writeFileSync(tmp, text, { mode, flag: 'wx' })
    fs.renameSync(tmp, target)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* not created */ }
    throw new ConnectError('io', `Cannot write ${target}: ${(err as Error).message}`)
  }
}

function backup(file: string, now: Date): string {
  let source = file
  try { source = fs.realpathSync(file) } catch { /* resolved below */ }
  const dest = `${source}.bak-specrails-${timestamp(now)}`
  try {
    fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL)
    try { fs.chmodSync(dest, fs.statSync(source).mode & 0o777) } catch { /* best effort */ }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return dest
    throw new ConnectError('io', `Cannot back up ${source}: ${(err as Error).message}`)
  }
  return dest
}

/** Warnings about paths an external client could lose (an AppImage mount, a dev checkout). */
export function entryWarnings(entry: BridgeEntry): string[] {
  const warnings: string[] = []
  const all = [entry.command, ...entry.args]
  if (all.some((part) => /[\\/]\.mount_[^\\/]+[\\/]/.test(part) || /^\/tmp\//.test(part))) {
    warnings.push('The bridge path is temporary (an AppImage mount); install Specrails to a fixed location and connect again.')
  }
  if (entry.command === 'node') warnings.push('The bridge runs with the `node` on the client\'s PATH.')
  return warnings
}

export function connect(request: ConnectRequest, entry: BridgeEntry | null, cenv: ConnectEnv = defaultConnectEnv()): ConnectResult {
  const { client } = request
  if (!CONNECT_CLIENTS.includes(client)) throw new ConnectError('invalid_input', `Unknown client "${String(client)}". Use claude or codex.`)
  const scope: ConnectScope = request.scope ?? 'user'
  if (scope !== 'user' && scope !== 'project') throw new ConnectError('invalid_input', 'scope is user or project.')
  if (scope === 'project') {
    if (!request.projectDir || !path.isAbsolute(request.projectDir)) throw new ConnectError('invalid_input', 'Project scope needs an absolute project directory.')
    if (!fs.existsSync(request.projectDir) || !fs.statSync(request.projectDir).isDirectory()) throw new ConnectError('invalid_input', `${request.projectDir} is not a directory.`)
  }
  if (!request.remove && !entry) throw new ConnectError('no_bridge', 'The Specrails MCP bridge is not available in this installation.')
  const file = configPathFor(client, scope, cenv, request.projectDir)
  const before = readText(file)
  const result = edit(client, before, request.remove ? null : entry, request.force === true)
  const base = {
    client, scope, file, outcome: result.outcome, dryRun: request.dryRun === true,
    command: entry ? registrationCommand(client, entry, scope, cenv.platform) : '',
    entry: request.remove ? null : entry, warnings: entry && !request.remove ? entryWarnings(entry) : [],
    ...(result.reason ? { reason: result.reason } : {}),
  }
  const changes = result.outcome === 'create' || result.outcome === 'update' || result.outcome === 'remove'
  if (!changes || request.dryRun) return { ...base, written: false, backup: null }
  const saved = before !== null ? backup(file, (cenv.now ?? (() => new Date()))()) : null
  writeAtomic(file, result.text, 0o600)
  return { ...base, written: true, backup: saved }
}
