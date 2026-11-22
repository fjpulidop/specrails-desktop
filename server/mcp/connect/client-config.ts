/**
 * Pure edits of the two client configurations `specrails mcp connect` writes:
 *
 *   Claude Code  JSON `mcpServers.specrails` in `~/.claude.json` (user scope) or
 *                `<project>/.mcp.json` (project scope)
 *   Codex        TOML `[mcp_servers.specrails]` in `$CODEX_HOME/config.toml`
 *                (user) or `<project>/.codex/config.toml` (project)
 *
 * Only the `specrails` entry is touched; every other key, server, comment and
 * table is kept byte for byte (TOML) or value for value (JSON). No token is
 * ever written: the bridge reads `~/.specrails/mcp.token` itself.
 */

export type ConnectClient = 'claude' | 'codex'
export type ConnectScope = 'user' | 'project'

/** The stdio entry both clients run: the bundled Node and the bridge script. */
export interface BridgeEntry {
  command: string
  args: string[]
  env: Record<string, string>
}

/** Codex's default per-call timeout is 60 s; `specrails_wait` blocks up to 45 s, plus transport time. */
export const CODEX_TOOL_TIMEOUT_SEC = 90
export const SERVER_NAME = 'specrails'

export type EditOutcome =
  /** Absent before, written now. */
  | 'create'
  /** A Specrails entry existed with other paths or settings. */
  | 'update'
  /** Already exactly this entry: nothing to write. */
  | 'unchanged'
  /** `--remove`: the entry is deleted. */
  | 'remove'
  /** `--remove` and there is no entry. */
  | 'absent'
  /** A `specrails` entry that is not the Specrails bridge, or a layout we cannot edit safely. */
  | 'conflict'

export interface EditResult {
  outcome: EditOutcome
  /** The file's next text; equals the input for unchanged, absent and conflict. */
  text: string
  /** Why a conflict was refused. */
  reason?: 'foreign_entry' | 'invalid_config' | 'unsupported_layout'
}

/** True when an entry runs the Specrails bridge (any install path) or the `specrails-mcp` command. */
export function looksLikeSpecrails(command: unknown, args: unknown): boolean {
  const parts = [command, ...(Array.isArray(args) ? args : [])].filter((part): part is string => typeof part === 'string')
  return parts.some((part) => /(^|[\\/])specrails-mcp(\.js)?$/i.test(part.trim()))
}

// ── Claude Code (JSON) ───────────────────────────────────────────────────────

export function claudeEntry(entry: BridgeEntry): Record<string, unknown> {
  return { type: 'stdio', command: entry.command, args: [...entry.args], env: { ...entry.env } }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Sets (or removes) `mcpServers.specrails` in a Claude JSON config. `text` is
 * the current file (null when missing). Invalid JSON is never reset: it is a
 * conflict the person resolves.
 */
export function editClaudeJson(text: string | null, entry: BridgeEntry | null, options: { force?: boolean } = {}): EditResult {
  let doc: Record<string, unknown> = {}
  if (text !== null && text.trim() !== '') {
    try {
      const parsed = JSON.parse(text) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { outcome: 'conflict', text, reason: 'invalid_config' }
      doc = parsed as Record<string, unknown>
    } catch {
      return { outcome: 'conflict', text, reason: 'invalid_config' }
    }
  }
  const original = text ?? ''
  const servers = doc.mcpServers
  if (servers !== undefined && (!servers || typeof servers !== 'object' || Array.isArray(servers))) {
    return { outcome: 'conflict', text: original, reason: 'unsupported_layout' }
  }
  const current = (servers as Record<string, unknown> | undefined)?.[SERVER_NAME] as Record<string, unknown> | undefined
  const ours = current !== undefined && current !== null && typeof current === 'object' && looksLikeSpecrails(current.command, current.args)
  if (entry === null) {
    if (current === undefined) return { outcome: 'absent', text: original }
    if (!ours && !options.force) return { outcome: 'conflict', text: original, reason: 'foreign_entry' }
    const rest = { ...(servers as Record<string, unknown>) }
    delete rest[SERVER_NAME]
    return { outcome: 'remove', text: `${JSON.stringify({ ...doc, mcpServers: rest }, null, 2)}\n` }
  }
  const wanted = claudeEntry(entry)
  if (current !== undefined) {
    if (sameJson(current, wanted)) return { outcome: 'unchanged', text: original }
    if (!ours && !options.force) return { outcome: 'conflict', text: original, reason: 'foreign_entry' }
  }
  const next = { ...doc, mcpServers: { ...((servers as Record<string, unknown> | undefined) ?? {}), [SERVER_NAME]: wanted } }
  return { outcome: current === undefined ? 'create' : 'update', text: `${JSON.stringify(next, null, 2)}\n` }
}

// ── Codex (TOML) ─────────────────────────────────────────────────────────────

/** A TOML basic string. JSON's escapes (\" \\ \n \t \uXXXX) are valid TOML. */
function tomlString(value: string): string {
  return JSON.stringify(value)
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key)
}

/** The exact `[mcp_servers.specrails]` table connect writes. */
export function codexTable(entry: BridgeEntry): string {
  const lines = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(', ')}]`,
  ]
  const env = Object.entries(entry.env)
  if (env.length) lines.push(`env = { ${env.map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`).join(', ')} }`)
  lines.push(`tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}`)
  return `${lines.join('\n')}\n`
}

const TABLE_HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/
const OUR_TABLE = /^mcp_servers\s*\.\s*(?:specrails|"specrails"|'specrails')(\s*\..*)?$/

interface Section { start: number; end: number }

/** Line range of `[mcp_servers.specrails]` plus its sub-tables; comments directly above the next table stay with it. */
function findCodexSection(lines: string[]): Section | null {
  const start = lines.findIndex((line) => {
    const header = TABLE_HEADER.exec(line)
    return header !== null && OUR_TABLE.test(header[1]!) && !OUR_TABLE.exec(header[1]!)![1]
  })
  if (start < 0) return null
  let end = start + 1
  for (; end < lines.length; end++) {
    const header = TABLE_HEADER.exec(lines[end]!)
    if (header && !OUR_TABLE.test(header[1]!)) break
  }
  // Leave a comment block that introduces the next table where it is.
  let cut = end
  while (cut > start + 1 && (/^\s*#/.test(lines[cut - 1]!) || lines[cut - 1]!.trim() === '')) cut--
  while (cut < end && lines[cut]!.trim() === '') cut++
  return { start, end: cut }
}

/** `mcp_servers.specrails = …` at the root or `specrails = …` inside `[mcp_servers]`: valid TOML we do not rewrite. */
function hasInlineDefinition(lines: string[]): boolean {
  let table: string | null = null
  for (const line of lines) {
    const header = TABLE_HEADER.exec(line)
    if (header) { table = header[1]!.replace(/\s+/g, ''); continue }
    if (table === null && /^\s*mcp_servers\s*\.\s*["']?specrails["']?\s*[.=]/.test(line)) return true
    if (table === 'mcp_servers' && /^\s*["']?specrails["']?\s*[.=]/.test(line)) return true
  }
  return false
}

/**
 * Sets (or removes) `[mcp_servers.specrails]` in a Codex `config.toml`,
 * touching no other line. A table written by connect earlier is replaced in
 * place; a new one is appended after one blank line.
 */
export function editCodexToml(text: string | null, entry: BridgeEntry | null, options: { force?: boolean } = {}): EditResult {
  const original = text ?? ''
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  const lines = original === '' ? [] : original.split(/\r?\n/)
  if (hasInlineDefinition(lines)) return { outcome: 'conflict', text: original, reason: 'unsupported_layout' }
  const section = findCodexSection(lines)
  const sectionText = section ? lines.slice(section.start, section.end).join('\n') : null
  const ours = sectionText !== null && looksLikeSpecrails(null, [...sectionText.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]))
  if (entry === null) {
    if (!section) return { outcome: 'absent', text: original }
    if (!ours && !options.force) return { outcome: 'conflict', text: original, reason: 'foreign_entry' }
    const kept = [...lines.slice(0, section.start), ...lines.slice(section.end)]
    while (section.start > 0 && kept[section.start - 1]?.trim() === '' && (kept[section.start] === undefined || kept[section.start]!.trim() === '')) kept.splice(section.start - 1, 1)
    return { outcome: 'remove', text: kept.join(eol).replace(/(\r?\n)*$/, kept.length ? eol : '') }
  }
  const table = codexTable(entry).trimEnd().split('\n')
  if (section) {
    if (sectionText!.trimEnd() === table.join('\n')) return { outcome: 'unchanged', text: original }
    if (!ours && !options.force) return { outcome: 'conflict', text: original, reason: 'foreign_entry' }
    const next = [...lines.slice(0, section.start), ...table, ...(section.end < lines.length && lines[section.end]!.trim() !== '' ? [''] : []), ...lines.slice(section.end)]
    const joined = next.join(eol)
    return { outcome: 'update', text: joined.endsWith(eol) ? joined : `${joined}${eol}` }
  }
  const body = original.replace(/(\r?\n)*$/, '')
  const prefix = body === '' ? '' : `${body}${eol}${eol}`
  return { outcome: 'create', text: `${prefix}${table.join(eol)}${eol}` }
}

// ── The command a person can run themselves ─────────────────────────────────

/** POSIX single quotes, or PowerShell single quotes on Windows. */
export function shellQuote(value: string, platform: NodeJS.Platform = process.platform): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value
  return platform === 'win32' ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * The client's own registration command for this entry (no secret in it: the
 * bridge reads the token file). For Codex it leaves the 60 s default timeout,
 * which still fits `specrails_wait`; connect also writes `tool_timeout_sec`.
 */
export function registrationCommand(client: ConnectClient, entry: BridgeEntry, scope: ConnectScope = 'user', platform: NodeJS.Platform = process.platform): string {
  const q = (value: string) => shellQuote(value, platform)
  if (client === 'claude') {
    const env = Object.entries(entry.env).map(([key, value]) => `-e ${q(`${key}=${value}`)}`)
    return ['claude mcp add --scope', scope, '--transport stdio', ...env, SERVER_NAME, '--', q(entry.command), ...entry.args.map(q)].join(' ')
  }
  const env = Object.entries(entry.env).map(([key, value]) => `--env ${q(`${key}=${value}`)}`)
  return ['codex mcp add', SERVER_NAME, ...env, '--', q(entry.command), ...entry.args.map(q)].join(' ')
}

// ── Reading a registered entry (mcp doctor) ─────────────────────────────────

export interface RegisteredEntry {
  command: string | null
  args: string[]
  env: Record<string, string>
  /** Runs the Specrails bridge (any install path). */
  ours: boolean
  /** Codex `tool_timeout_sec`, when set. */
  toolTimeoutSec?: number
}

export type ReadEntry = { state: 'missing' } | { state: 'invalid' } | { state: 'present'; entry: RegisteredEntry }

function entryFrom(raw: Record<string, unknown>): RegisteredEntry {
  const command = typeof raw.command === 'string' ? raw.command : null
  const args = Array.isArray(raw.args) ? raw.args.filter((arg): arg is string => typeof arg === 'string') : []
  const env: Record<string, string> = {}
  if (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)) {
    for (const [key, value] of Object.entries(raw.env as Record<string, unknown>)) if (typeof value === 'string') env[key] = value
  }
  return { command, args, env, ours: looksLikeSpecrails(command, args) }
}

/**
 * The `specrails` server in a Claude JSON config: `mcpServers.specrails`, or with
 * `projectDir` the local-scope `projects[<dir>].mcpServers.specrails` of `~/.claude.json`.
 */
export function readClaudeEntry(text: string | null, options: { projectDir?: string } = {}): ReadEntry {
  if (text === null || text.trim() === '') return { state: 'missing' }
  let doc: unknown
  try { doc = JSON.parse(text) } catch { return { state: 'invalid' } }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { state: 'invalid' }
  let holder = doc as Record<string, unknown>
  if (options.projectDir !== undefined) {
    const projects = holder.projects as Record<string, unknown> | undefined
    const project = projects && typeof projects === 'object' ? projects[options.projectDir] : undefined
    if (!project || typeof project !== 'object') return { state: 'missing' }
    holder = project as Record<string, unknown>
  }
  const servers = holder.mcpServers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return { state: 'missing' }
  const raw = (servers as Record<string, unknown>)[SERVER_NAME]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw === undefined ? { state: 'missing' } : { state: 'invalid' }
  return { state: 'present', entry: entryFrom(raw as Record<string, unknown>) }
}

/** TOML basic or literal strings in `value`, in order. */
function tomlStrings(value: string): string[] {
  return [...value.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => {
    if (m[2] !== undefined) return m[2]
    try { return JSON.parse(`"${m[1]}"`) as string } catch { return m[1]! }
  })
}

/** The `[mcp_servers.specrails]` table of a Codex config (the keys connect writes: command, args, env, tool_timeout_sec). */
export function readCodexEntry(text: string | null): ReadEntry {
  if (text === null || text.trim() === '') return { state: 'missing' }
  const lines = text.split(/\r?\n/)
  if (hasInlineDefinition(lines)) return { state: 'invalid' }
  const section = findCodexSection(lines)
  if (!section) return { state: 'missing' }
  const raw: Record<string, unknown> = {}
  let env: Record<string, string> | undefined
  let inEnvTable = false
  for (const line of lines.slice(section.start + 1, section.end)) {
    const header = TABLE_HEADER.exec(line)
    if (header) { inEnvTable = /\.\s*env$/.test(header[1]!.trim()); if (inEnvTable) env ??= {}; continue }
    const kv = /^\s*([A-Za-z0-9_"'-]+)\s*=\s*(.+?)\s*$/.exec(line)
    if (!kv) continue
    const key = kv[1]!.replace(/^["']|["']$/g, '')
    const value = kv[2]!
    if (inEnvTable) { env![key] = tomlStrings(value)[0] ?? value; continue }
    if (key === 'command') raw.command = tomlStrings(value)[0] ?? null
    else if (key === 'args') raw.args = tomlStrings(value)
    else if (key === 'tool_timeout_sec') raw.tool_timeout_sec = Number(value)
    else if (key === 'env') {
      env ??= {}
      for (const pair of value.replace(/^\{|\}$/g, '').matchAll(/([A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*")\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/g)) {
        env[pair[1]!.replace(/^"|"$/g, '')] = tomlStrings(pair[2]!)[0] ?? ''
      }
    }
  }
  if (env) raw.env = env
  const entry = entryFrom(raw)
  return { state: 'present', entry: Number.isFinite(raw.tool_timeout_sec) ? { ...entry, toolTimeoutSec: raw.tool_timeout_sec as number } : entry }
}
