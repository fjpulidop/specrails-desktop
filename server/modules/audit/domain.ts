/**
 * Agent actions audit — pure domain.
 *
 * Classifies provider tool events into audit rows (what a run READ, WROTE,
 * EXECUTED, called over MCP or fetched from the NETWORK). Only targets are kept:
 * paths, redacted commands, MCP tool names and URLs without query strings. File
 * contents, tool outputs and environment values never become audit data.
 *
 * Completeness is bounded by each provider's stream: a provider that does not
 * report a read never produces a read row.
 */

export const AGENT_ACTION_KINDS = ['read', 'write', 'exec', 'mcp', 'network'] as const
export type AgentActionKind = typeof AGENT_ACTION_KINDS[number]

/** Where a row came from. Free text is accepted by storage; these are the producers. */
export const AGENT_ACTION_SOURCES = [
  'claude-stream',
  'codex-stream',
  'gemini-stream',
  'provider-stream',
  'core-agent-event',
  'core-session',
  'file-provenance',
  'mcp-wrapper',
] as const
export type AgentActionSource = typeof AGENT_ACTION_SOURCES[number]

export const MAX_TARGET_LENGTH = 512
const MAX_ROLE_LENGTH = 64
const MAX_ID_LENGTH = 256

/** One action before persistence. `hashSource` is transient: the application
 * hashes it (when present) and never stores it. */
export interface AgentActionDraft {
  kind: AgentActionKind
  target: string
  role?: string
  source: string
  hash?: string | null
  hashSource?: string
}

/** An action addressed to a run, as accepted by the recorder. */
export interface AgentActionInput extends AgentActionDraft {
  runId: string
  jobId?: string | null
  ts?: string
}

/** A normalised row ready for storage. */
export interface AgentActionRow {
  runId: string
  jobId: string | null
  role: string
  kind: AgentActionKind
  target: string
  hash: string | null
  ts: string
  source: string
}

export interface AgentActionRecord extends AgentActionRow {
  id: number
}

export type AgentActionCounts = Record<AgentActionKind, number>

export function emptyAgentActionCounts(): AgentActionCounts {
  return { read: 0, write: 0, exec: 0, mcp: 0, network: 0 }
}

export function isAgentActionKind(value: unknown): value is AgentActionKind {
  return typeof value === 'string' && (AGENT_ACTION_KINDS as readonly string[]).includes(value)
}

// ─── Target normalisation and redaction ──────────────────────────────────────

/** Single line, bounded, no control characters. */
export function normaliseTarget(value: string, max = MAX_TARGET_LENGTH): string {
  // eslint-disable-next-line no-control-regex
  const single = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return single.length > max ? `${single.slice(0, max - 1)}…` : single
}

const SECRET_FLAG = /(--?(?:[a-z0-9]+[-_])*(?:token|password|passwd|pass|secret|api[-_]?key|apikey|key|auth|authorization|credentials?|private[-_]?key|access[-_]?key|client[-_]?secret))(=|\s+)("[^"]*"|'[^']*'|[^\s"'-]\S*)/gi
const ENV_ASSIGNMENT = /(^|[\s;&|(])((?:export\s+)?[A-Z_][A-Z0-9_]*)=("[^"]*"|'[^']*'|\S*)/g
const BEARER = /(?<![-\w])(Bearer|Basic|Token)\s+(?!-)[A-Za-z0-9._~+/=-]{6,}/gi
const AUTH_HEADER = /(authorization|x-api-key|api-key|cookie|x-auth-token)(\s*:\s*)("[^"]*"|'[^']*'|[^"'\s]+(?:\s+[^"'\s-][^"'\s]*)?)/gi
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/gi
const TOKEN_SHAPES = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:ant-)?[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{30,})\b/g

/** Remove obvious secrets from a shell command. Environment-style assignments
 * keep their NAME and lose their value, so no environment value is stored. */
export function redactCommand(command: string): string {
  return command
    .replace(URL_CREDENTIALS, '$1***@')
    .replace(AUTH_HEADER, '$1$2***')
    .replace(BEARER, '$1 ***')
    .replace(SECRET_FLAG, (_match, flag: string, sep: string) => `${flag}${sep.includes('=') ? '=' : ' '}***`)
    .replace(ENV_ASSIGNMENT, (_match, lead: string, name: string) => `${lead}${name}=***`)
    .replace(TOKEN_SHAPES, '***')
}

/** URL without query string, fragment or credentials (queries can carry keys). */
export function redactUrl(raw: string): string {
  const trimmed = raw.trim()
  const match = /^([a-z][a-z0-9+.-]*:\/\/)(?:[^/\s@]*@)?([^/?#\s]*)([^?#\s]*)/i.exec(trimmed)
  if (!match) return redactCommand(trimmed.split(/[?#]/)[0] ?? '')
  return `${match[1]}${match[2]}${match[3]}`
}

/** Sub-agent / role labels: `sr-architect`, `specrails:developer` → `architect`, `developer`. */
export function normaliseRole(value: unknown, fallback = 'agent'): string {
  if (typeof value !== 'string') return fallback
  const role = value.trim().replace(/^(?:specrails:|sr:|sr-)/i, '').toLowerCase()
  if (!role) return fallback
  return role.length > MAX_ROLE_LENGTH ? role.slice(0, MAX_ROLE_LENGTH) : role
}

// ─── Tool classification ─────────────────────────────────────────────────────

const READ_TOOLS = new Set(['read', 'grep', 'glob', 'ls', 'notebookread', 'read_file', 'read_many_files', 'list_directory', 'search_file_content', 'glob_files', 'view', 'find_files', 'list_files', 'read_text_file', 'search'])
const WRITE_TOOLS = new Set(['edit', 'write', 'multiedit', 'notebookedit', 'apply_patch', 'write_file', 'replace', 'edit_file', 'create_file', 'str_replace_editor', 'str_replace_based_edit_tool', 'file_change', 'delete_file'])
const EXEC_TOOLS = new Set(['bash', 'shell', 'exec_command', 'local_shell', 'local_shell_call', 'run_shell_command', 'command_execution', 'container.exec', 'powershell', 'run_command', 'terminal'])
const NETWORK_TOOLS = new Set(['webfetch', 'websearch', 'web_fetch', 'web_search', 'google_web_search', 'fetch', 'http_request', 'browse'])
/** Bare commands Core reports as tool names for host-run environment checks. */
const HOST_COMMANDS = new Set(['npm', 'npx', 'pnpm', 'yarn', 'bun', 'node', 'pip', 'pip3', 'uv', 'poetry', 'python', 'python3', 'cargo', 'go', 'make', 'git', 'gradle', 'mvn', 'dotnet', 'bundle', 'composer', 'deno', 'playwright', 'pytest'])

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return {} }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/** Classify a provider tool name. `null` = not an audited action (todo lists,
 * sub-agent launches, plan updates, ...). */
export function classifyToolName(name: string): AgentActionKind | null {
  const lower = name.trim().toLowerCase()
  if (!lower) return null
  if (lower.startsWith('mcp__') || lower.startsWith('mcp:') || lower.startsWith('mcp.')) return 'mcp'
  if (READ_TOOLS.has(lower)) return 'read'
  if (WRITE_TOOLS.has(lower)) return 'write'
  if (EXEC_TOOLS.has(lower)) return 'exec'
  if (NETWORK_TOOLS.has(lower)) return 'network'
  return null
}

function commandOf(input: Record<string, unknown>, fallback?: string): string | undefined {
  const command = input.command ?? input.cmd ?? input.script
  if (Array.isArray(command)) {
    const parts = command.filter((part): part is string => typeof part === 'string')
    // Codex wraps commands as ["bash", "-lc", "<script>"]; keep the script.
    if (parts.length >= 3 && /^(?:ba|z|)sh$|\/(?:ba|z|)sh$/.test(parts[0]!) && /^-\w*c$/.test(parts[1]!)) return parts.slice(2).join(' ')
    return parts.join(' ')
  }
  return str(command) ?? fallback
}

/** Paths named by an apply_patch envelope (never its hunks). */
export function patchPaths(patch: string): string[] {
  const paths: string[] = []
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) paths.push(match[1]!.trim())
  for (const match of patch.matchAll(/^\*\*\* Move to: (.+)$/gm)) paths.push(match[1]!.trim())
  if (paths.length === 0) {
    for (const match of patch.matchAll(/^\+\+\+ (?:b\/)?(.+)$/gm)) if (match[1] !== '/dev/null') paths.push(match[1]!.trim())
  }
  return [...new Set(paths)]
}

function pathsOf(input: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const key of ['file_path', 'path', 'notebook_path', 'absolute_path', 'filePath', 'target_file', 'file']) {
    const value = str(input[key])
    if (value) { out.push(value); break }
  }
  if (Array.isArray(input.paths)) for (const value of input.paths) if (typeof value === 'string' && value.trim()) out.push(value)
  return out
}

/**
 * Classify one tool call. `input` may be an object, a JSON string or a
 * (possibly truncated) preview. Returns zero or more drafts (an apply_patch
 * touching three files yields three write rows).
 */
export function classifyToolCall(name: string, input: unknown, source: string, role?: string): AgentActionDraft[] {
  const kind = classifyToolName(name)
  if (!kind) return []
  const args = asRecord(input)
  const preview = typeof input === 'string' ? input : undefined
  const base = { source, ...(role ? { role } : {}) }
  switch (kind) {
    case 'mcp':
      return [{ ...base, kind, target: normaliseTarget(name) }]
    case 'exec': {
      const command = commandOf(args, preview && !preview.trimStart().startsWith('{') ? preview : undefined)
      return [{ ...base, kind, target: normaliseTarget(redactCommand(command ?? name)) }]
    }
    case 'network': {
      const url = str(args.url) ?? str(args.uri)
      if (url) return [{ ...base, kind, target: normaliseTarget(redactUrl(url)) }]
      const query = str(args.query) ?? str(args.q)
      return [{ ...base, kind, target: normaliseTarget(query ? `search: ${redactCommand(query)}` : name) }]
    }
    case 'read': {
      const paths = pathsOf(args)
      if (paths.length > 0) return paths.map(path => ({ ...base, kind, target: normaliseTarget(path) }))
      const pattern = str(args.pattern) ?? str(args.query) ?? str(args.glob)
      return [{ ...base, kind, target: normaliseTarget(pattern ? `${name}: ${pattern}` : name) }]
    }
    case 'write': {
      const patch = str(args.patch) ?? str(args.input) ?? (name.toLowerCase() === 'apply_patch' ? preview : undefined)
      const paths = pathsOf(args)
      if (paths.length === 0 && patch) paths.push(...patchPaths(patch))
      if (paths.length === 0 && preview) {
        const quoted = /"(?:file_path|path|notebook_path)"\s*:\s*"([^"]+)"/.exec(preview)
        if (quoted) paths.push(quoted[1]!)
      }
      // Content hash only when the call carries the whole new file content.
      const content = typeof args.content === 'string' ? args.content : undefined
      if (paths.length === 0) return [{ ...base, kind, target: normaliseTarget(name) }]
      return paths.map(path => ({ ...base, kind, target: normaliseTarget(path), ...(content !== undefined && paths.length === 1 ? { hashSource: content } : {}) }))
    }
  }
}

// ─── Stream extraction ───────────────────────────────────────────────────────

/** Per-stream memory: Claude sub-agent ids → role, Codex item ids already seen. */
export interface StreamAuditState {
  subagentRoles: Map<string, string>
  seenItems: Set<string>
}

export function createStreamAuditState(): StreamAuditState {
  return { subagentRoles: new Map(), seenItems: new Set() }
}

const SUBAGENT_TOOLS = new Set(['task', 'agent'])

function claudeBlocks(event: Record<string, unknown>, state: StreamAuditState, role: string): AgentActionDraft[] {
  const message = asRecord(event.message)
  const content = Array.isArray(message.content) ? message.content : []
  const parent = str(event.parent_tool_use_id)
  const blockRole = parent ? state.subagentRoles.get(parent) ?? 'subagent' : role
  const out: AgentActionDraft[] = []
  for (const raw of content) {
    const block = asRecord(raw)
    if (block.type !== 'tool_use' || typeof block.name !== 'string') continue
    const input = asRecord(block.input)
    if (SUBAGENT_TOOLS.has(block.name.toLowerCase())) {
      if (typeof block.id === 'string') state.subagentRoles.set(block.id, normaliseRole(input.subagent_type ?? input.description, 'subagent'))
      continue
    }
    out.push(...classifyToolCall(block.name, input, 'claude-stream', blockRole))
  }
  return out
}

function codexItem(event: Record<string, unknown>, state: StreamAuditState, role: string): AgentActionDraft[] {
  const item = asRecord(event.item)
  const type = str(item.type)
  if (!type) return []
  const id = str(item.id)
  // Started and completed frames describe the same call: record whichever arrives first,
  // except file changes, whose paths are only final on completion.
  if (type === 'file_change' && event.type !== 'item.completed') return []
  if (id) {
    const key = `${type}:${id}`
    if (state.seenItems.has(key)) return []
    state.seenItems.add(key)
  }
  const source = 'codex-stream'
  switch (type) {
    case 'command_execution':
      return classifyToolCall('command_execution', { command: item.command }, source, role)
    case 'local_shell_call':
    case 'function_call': {
      const action = asRecord(item.action)
      const name = str(item.name) ?? (type === 'local_shell_call' ? 'shell' : '')
      return classifyToolCall(name, Object.keys(action).length ? action : item.arguments ?? item.command, source, role)
    }
    case 'mcp_tool_call': {
      const server = str(item.server) ?? 'unknown'
      const tool = str(item.tool) ?? str(item.name) ?? 'unknown'
      return [{ kind: 'mcp', target: normaliseTarget(`mcp__${server}__${tool}`), source, role }]
    }
    case 'file_change': {
      const changes = Array.isArray(item.changes) ? item.changes : []
      return changes
        .map(change => str(asRecord(change).path))
        .filter((path): path is string => Boolean(path))
        .map(path => ({ kind: 'write' as const, target: normaliseTarget(path), source, role }))
    }
    case 'web_search': {
      const query = str(item.query)
      return [{ kind: 'network', target: normaliseTarget(query ? `search: ${redactCommand(query)}` : 'web_search'), source, role }]
    }
    default:
      return []
  }
}

function coreAgentEvent(event: Record<string, unknown>, role: string): AgentActionDraft[] {
  const payload = asRecord(event.event)
  if (payload.kind !== 'tool-start') return []
  const tool = str(payload.tool)
  if (!tool) return []
  const eventRole = normaliseRole(event.role, role)
  const detail = str(payload.detail)
  const source = 'core-agent-event'
  const targetPaths = Array.isArray(payload.targetPaths) ? payload.targetPaths.filter((path): path is string => typeof path === 'string' && path.length > 0) : []
  const kind = classifyToolName(tool)
  if (!kind) {
    // Host-run environment checks arrive as the bare command name + its arguments.
    if (!HOST_COMMANDS.has(tool.toLowerCase())) return []
    return [{ kind: 'exec', target: normaliseTarget(redactCommand(`${tool}${detail ? ` ${detail}` : ''}`)), source, role: eventRole }]
  }
  if ((kind === 'read' || kind === 'write') && targetPaths.length > 0) {
    return [...new Set(targetPaths)].map(path => ({ kind, target: normaliseTarget(path), source, role: eventRole }))
  }
  if (kind === 'exec') return [{ kind, target: normaliseTarget(redactCommand(detail ?? tool)), source, role: eventRole }]
  if (kind === 'network') return [{ kind, target: normaliseTarget(detail ? (/^[a-z][a-z0-9+.-]*:\/\//i.test(detail) ? redactUrl(detail) : `search: ${redactCommand(detail)}`) : tool), source, role: eventRole }]
  if (kind === 'mcp') return [{ kind, target: normaliseTarget(tool), source, role: eventRole }]
  return [{ kind, target: normaliseTarget(detail ?? tool), source, role: eventRole }]
}

/**
 * Extract audit drafts from ONE parsed stream event of any supported shape:
 * Claude stream-json (`assistant` frames with tool_use blocks; Task sub-agent
 * roles followed through `parent_tool_use_id`), Codex `item.*` frames, Gemini
 * `tool_use` frames and Core `agent-event` tool-start lines. Unknown shapes
 * yield nothing. Never throws.
 */
export function extractStreamActions(event: unknown, state: StreamAuditState, defaultRole = 'agent'): AgentActionDraft[] {
  try {
    const record = asRecord(event)
    const type = str(record.type)
    if (!type) return []
    if (type === 'assistant') return claudeBlocks(record, state, defaultRole)
    if (type === 'item.started' || type === 'item.completed') return codexItem(record, state, defaultRole)
    if (type === 'agent-event') return coreAgentEvent(record, defaultRole)
    if (type === 'tool_use') {
      if (typeof record.tool_name === 'string') return classifyToolCall(record.tool_name, record.parameters, 'gemini-stream', defaultRole)
      if (typeof record.name === 'string') return classifyToolCall(record.name, record.input, 'claude-stream', defaultRole)
    }
    return []
  } catch {
    return []
  }
}

// ─── Validation for storage ──────────────────────────────────────────────────

/** Normalise an input into a storable row, or null when it is not one. */
export function toAgentActionRow(input: AgentActionInput, hash: string | null, nowIso: string): AgentActionRow | null {
  if (!input || typeof input.runId !== 'string' || !input.runId.trim()) return null
  if (!isAgentActionKind(input.kind)) return null
  const target = typeof input.target === 'string' ? normaliseTarget(input.target) : ''
  if (!target) return null
  const jobId = typeof input.jobId === 'string' && input.jobId.trim() ? input.jobId.slice(0, MAX_ID_LENGTH) : null
  const ts = typeof input.ts === 'string' && !Number.isNaN(Date.parse(input.ts)) ? new Date(input.ts).toISOString() : nowIso
  return {
    runId: input.runId.slice(0, MAX_ID_LENGTH),
    jobId,
    role: normaliseRole(input.role),
    kind: input.kind,
    target,
    hash: hash ? hash.slice(0, 128) : null,
    ts,
    source: normaliseTarget(typeof input.source === 'string' && input.source ? input.source : 'unknown', MAX_ROLE_LENGTH),
  }
}

// ─── Export formats ──────────────────────────────────────────────────────────

export type AgentAuditFormat = 'jsonl' | 'csv'

export function parseAgentAuditFormat(value: unknown): AgentAuditFormat | null {
  if (value === undefined || value === null || value === '') return 'jsonl'
  return value === 'jsonl' || value === 'csv' ? value : null
}

const CSV_COLUMNS = ['id', 'ts', 'run_id', 'job_id', 'role', 'kind', 'target', 'hash', 'source'] as const

function exportShape(record: AgentActionRecord): Record<typeof CSV_COLUMNS[number], string | number | null> {
  return { id: record.id, ts: record.ts, run_id: record.runId, job_id: record.jobId, role: record.role, kind: record.kind, target: record.target, hash: record.hash, source: record.source }
}

export function toJsonl(records: readonly AgentActionRecord[]): string {
  return records.map(record => JSON.stringify(exportShape(record))).join('\n') + (records.length ? '\n' : '')
}

function csvCell(value: string | number | null): string {
  if (value === null) return ''
  let text = String(value)
  // Spreadsheet formula injection: a target such as `=cmd|...` must stay text.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function toCsv(records: readonly AgentActionRecord[]): string {
  const lines = [CSV_COLUMNS.join(',')]
  for (const record of records) {
    const row = exportShape(record)
    lines.push(CSV_COLUMNS.map(column => csvCell(row[column])).join(','))
  }
  return lines.join('\n') + '\n'
}

// ─── Retention ───────────────────────────────────────────────────────────────

export const DEFAULT_AGENT_AUDIT_RETENTION_DAYS = 30
export const MIN_AGENT_AUDIT_RETENTION_DAYS = 1
export const MAX_AGENT_AUDIT_RETENTION_DAYS = 3650

/** ISO instant before which rows expire. */
export function retentionCutoff(nowMs: number, days: number): string {
  const bounded = Math.min(MAX_AGENT_AUDIT_RETENTION_DAYS, Math.max(MIN_AGENT_AUDIT_RETENTION_DAYS, Math.floor(days)))
  return new Date(nowMs - bounded * 24 * 60 * 60 * 1000).toISOString()
}
