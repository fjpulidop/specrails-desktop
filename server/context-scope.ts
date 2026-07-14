// Context Scope — per-spec configuration that controls what context is fed
// into the Add Spec flow (Quick `generate-spec` and Explore chat turns).
//
// Six orthogonal toggles:
//   - specrails: concat <project>/.specrails/local-tickets.json (all tickets)
//                into the system prompt
//   - openspec:  concat <project>/openspec/specs/**/spec.md into the system prompt
//   - full:      enable source inspection; with an MCP toggle the high tier
//                retains Bash/MCP tools while denying GUI file-writer tools
//   - mcp:       Explore-only — spawn from the relocation-aware artifact cwd so
//                .mcp.json is honored (workspace when relocated, repo when legacy)
//   - contractRefine: run the post-commit structural refinement turn
//   - userMcp:   Explore-only — inject the user's own already-approved MCP
//                servers (claude: ~/.claude.json user+local scope, fed via
//                `--mcp-config`; codex: ~/.codex is read natively). Independent
//                of `mcp` (project `.mcp.json`) and does NOT change the spawn cwd.
//
// Persistence: `queue_state.add_spec_context_scope_last` (per-project) holds
// the last-used scope. `chat_conversations.context_scope` (per-conversation,
// JSON) freezes the scope at the conversation's creation time.

import fs from 'node:fs'
import path from 'node:path'
import type { DbInstance } from './db'

export interface ContextScope {
  specrails: boolean
  openspec: boolean
  full: boolean
  mcp: boolean
  /** Whether the Contract Refine post-commit turn should fire for the spec
   *  committed from this conversation. See openspec/changes/add-spec-context-slider. */
  contractRefine: boolean
  /** Explore-only: inject the user's own already-approved MCP servers into the
   *  spawn. Optional for backward compatibility — legacy scopes (and every
   *  preset literal) omit it and are treated as `false`. See
   *  `server/user-mcp-config.ts`. */
  userMcp?: boolean
}

// Maximum tokens worth of concatenated spec content injected per section
// (specrails + openspec each get their own 30k budget).
export const SPEC_CONCAT_TOKEN_CAP = 30_000

// Rough heuristic: ASCII text averages ~4 bytes per token.
export const BYTES_PER_TOKEN = 4

export type SpecMode = 'quick' | 'explore'

export function defaultBootScope(mode: SpecMode): ContextScope {
  return {
    specrails: true,
    openspec: false,
    full: mode === 'explore',
    mcp: false,
    contractRefine: false,
    userMcp: false,
  }
}

// Shape-validate an unknown value into a ContextScope. Unknown keys are
// dropped; non-boolean values fall back to `fallback` per key.
export function normalizeContextScope(
  value: unknown,
  fallback: ContextScope,
): ContextScope {
  if (!value || typeof value !== 'object') return { ...fallback }
  const v = value as Record<string, unknown>
  return {
    specrails: typeof v.specrails === 'boolean' ? v.specrails : fallback.specrails,
    openspec: typeof v.openspec === 'boolean' ? v.openspec : fallback.openspec,
    full: typeof v.full === 'boolean' ? v.full : fallback.full,
    mcp: typeof v.mcp === 'boolean' ? v.mcp : fallback.mcp,
    contractRefine: typeof v.contractRefine === 'boolean' ? v.contractRefine : fallback.contractRefine,
    userMcp: typeof v.userMcp === 'boolean' ? v.userMcp : (fallback.userMcp ?? false),
  }
}

export function getLastContextScope(db: DbInstance, mode: SpecMode = 'explore'): ContextScope {
  const row = db.prepare(
    `SELECT value FROM queue_state WHERE key = 'add_spec_context_scope_last'`,
  ).get() as { value: string } | undefined
  const fallback = defaultBootScope(mode)
  if (!row?.value) return fallback
  try {
    return normalizeContextScope(JSON.parse(row.value), fallback)
  } catch {
    return fallback
  }
}

export function setLastContextScope(db: DbInstance, scope: ContextScope): void {
  const value = JSON.stringify({
    specrails: !!scope.specrails,
    openspec: !!scope.openspec,
    full: !!scope.full,
    mcp: !!scope.mcp,
    contractRefine: !!scope.contractRefine,
    userMcp: !!scope.userMcp,
  })
  db.prepare(
    `INSERT OR REPLACE INTO queue_state (key, value) VALUES ('add_spec_context_scope_last', ?)`,
  ).run(value)
}

export function setConversationContextScope(
  db: DbInstance,
  conversationId: string,
  scope: ContextScope,
): void {
  db.prepare(
    `UPDATE chat_conversations SET context_scope = ? WHERE id = ?`,
  ).run(JSON.stringify(scope), conversationId)
}

export function getConversationContextScope(
  db: DbInstance,
  conversationId: string,
): ContextScope | null {
  const row = db.prepare(
    `SELECT context_scope FROM chat_conversations WHERE id = ?`,
  ).get(conversationId) as { context_scope: string | null } | undefined
  if (!row?.context_scope) return null
  try {
    const parsed = JSON.parse(row.context_scope)
    return normalizeContextScope(parsed, {
      specrails: false, openspec: false, full: true, mcp: false, contractRefine: false, userMcp: false,
    })
  } catch {
    return null
  }
}

// ─── Spec concatenation helpers ──────────────────────────────────────────────

interface ConcatResult {
  text: string
  truncated: boolean
  bytes: number
}

function walkMdFiles(root: string, predicate: (rel: string) => boolean): string[] {
  if (!fs.existsSync(root)) return []
  const out: string[] = []
  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name.startsWith('.') && e.name !== '.specrails') continue
        if (e.name === 'node_modules') continue
        stack.push(full)
      } else if (e.isFile() && e.name.endsWith('.md')) {
        const rel = path.relative(root, full)
        if (predicate(rel)) out.push(full)
      }
    }
  }
  out.sort()
  return out
}

function concatFilesWithCap(files: string[], byteCap: number): ConcatResult {
  let total = 0
  const parts: string[] = []
  let truncated = false
  for (const file of files) {
    let content: string
    try {
      content = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const header = `### ${path.basename(file)}\n\n`
    const piece = `${header}${content}\n\n`
    const pieceBytes = Buffer.byteLength(piece)
    if (total + pieceBytes > byteCap) {
      const remaining = Math.max(0, byteCap - total)
      if (remaining > 0) {
        parts.push(piece.slice(0, remaining))
        total = byteCap
      }
      truncated = true
      break
    }
    parts.push(piece)
    total += pieceBytes
  }
  return { text: parts.join(''), truncated, bytes: total }
}

// Format the project's local-tickets.json store as a markdown section. ALL
// tickets are included (no status filter). Capped at 30k tokens worth of
// bytes; overflow ends with a `(truncated)` marker.
export function buildSpecrailsTicketsSection(projectPath: string): string | null {
  const file = path.join(projectPath, '.specrails', 'local-tickets.json')
  if (!fs.existsSync(file)) return null
  let raw: string
  try { raw = fs.readFileSync(file, 'utf8') } catch { return null }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  // Ticket store schemas seen in the wild:
  //   1.0: { tickets: [<ticket>, ...] }            — array form
  //   1.1: { tickets: { "1": <ticket>, ... } }     — object keyed by id
  //   bare array: [<ticket>, ...]                  — legacy/test form
  let tickets: unknown[] = []
  if (parsed && typeof parsed === 'object') {
    const t = (parsed as { tickets?: unknown }).tickets
    if (Array.isArray(t)) tickets = t
    else if (t && typeof t === 'object') tickets = Object.values(t)
    else if (Array.isArray(parsed)) tickets = parsed
  }
  if (tickets.length === 0) return null
  const cap = SPEC_CONCAT_TOKEN_CAP * BYTES_PER_TOKEN
  const parts: string[] = []
  let total = 0
  let truncated = false
  for (const t of tickets) {
    if (!t || typeof t !== 'object') continue
    const x = t as Record<string, unknown>
    const id = typeof x.id === 'number' ? x.id : (typeof x.id === 'string' ? x.id : '?')
    const title = typeof x.title === 'string' ? x.title : '(untitled)'
    const status = typeof x.status === 'string' ? x.status : '?'
    const priority = typeof x.priority === 'string' ? x.priority : '—'
    const labels = Array.isArray(x.labels) ? (x.labels as unknown[]).filter((l): l is string => typeof l === 'string') : []
    const description = typeof x.description === 'string' ? x.description : ''
    const labelLine = labels.length > 0 ? ` · labels: ${labels.join(', ')}` : ''
    const block = `### #${id} · ${title}\nstatus: ${status} · priority: ${priority}${labelLine}\n\n${description}\n\n`
    const blockBytes = Buffer.byteLength(block)
    if (total + blockBytes > cap) {
      const remaining = Math.max(0, cap - total)
      if (remaining > 0) {
        parts.push(block.slice(0, remaining))
        total = cap
      }
      truncated = true
      break
    }
    parts.push(block)
    total += blockBytes
  }
  if (parts.length === 0) return null
  return `## Specrails Tickets\n\n${parts.join('')}${truncated ? '\n(truncated)\n' : ''}`
}

export function buildOpenSpecSpecsSection(projectPath: string): string | null {
  const root = path.join(projectPath, 'openspec', 'specs')
  // Only include `spec.md` files under each capability directory.
  const files = walkMdFiles(root, (rel) => rel.endsWith('spec.md'))
  if (files.length === 0) return null
  const cap = SPEC_CONCAT_TOKEN_CAP * BYTES_PER_TOKEN
  const { text, truncated } = concatFilesWithCap(files, cap)
  if (!text) return null
  return `## OpenSpec Specs\n\n${text}${truncated ? '\n(truncated)\n' : ''}`
}

export function buildScopedSystemPromptPrefix(
  scope: ContextScope,
  projectPath: string,
  /** Relocate-artifacts: where `.specrails/local-tickets.json` lives — the
   *  workspace dir when relocated, else === projectPath. OpenSpec specs always
   *  read from the repo (`projectPath`). Defaults to `projectPath` (legacy). */
  specrailsRoot?: string,
): string {
  const sections: string[] = []
  if (scope.specrails) {
    const s = buildSpecrailsTicketsSection(specrailsRoot ?? projectPath)
    if (s) sections.push(s)
  }
  if (scope.openspec) {
    const s = buildOpenSpecSpecsSection(projectPath)
    if (s) sections.push(s)
  }
  return sections.join('\n\n')
}

// ─── Spawn argv helpers ──────────────────────────────────────────────────────

export interface ScopedToolFlags {
  args: string[]
}

// Compute the claude CLI tool flags for the given scope.
//
// The base read-only Explore tiers use `--tools Read,Grep,Glob` (a built-in
// toolkit RESTRICTION — NOT a permission allow-list). This is the most reliable
// read-only lockdown because `--dangerously-skip-permissions` (in COMMON_FLAGS)
// can bypass `--disallowedTools` filters. Verified against claude 2.1.177:
//   - `--tools Read,Grep,Glob` removes Bash AND MCP tools from the toolkit, so
//     `gh` and any `mcp__*` tools are uncallable (the "only local read access"
//     symptom users hit when they enable approved MCPs at this tier).
//
// HIGH TIER (full AND an MCP toggle on — the Max/Desktop presets, i.e. the user
// explicitly opted into MCP/connectors): we cannot enumerate Claude.ai connector
// servers to put them in an allow-list, so we keep the full `--tools default`
// toolkit + skip-permissions (which makes ALL MCP servers — file, plugin, and
// connector — callable) and merely DISALLOW the GUI file-writers. This is a
// deliberate capability bump: it also exposes Bash (so the agent can run `gh`
// with the user's local auth, and inspect the repo via shell). Bash can write
// to disk, so this tier is NOT a hard read-only sandbox — the Explore system
// prompt carries the non-destructive stance, and the tier is opt-in.
//
// - full && (mcp || userMcp) → --disallowedTools Write,Edit,NotebookEdit
//                              (default toolkit: Read/Grep/Glob/Bash/WebFetch +
//                               all loaded MCP tools; file-writer tools removed)
// - full (no MCP toggle)     → --tools Read,Grep,Glob (read-only, no Bash/MCP)
// - !full                    → --tools __none__ (a non-existent tool name; the
//                              empty string `""` is silently dropped by some CLI
//                              versions and falls back to the default set, so we
//                              use a sentinel to disable all tools).
export function toolFlagsForScope(scope: ContextScope): ScopedToolFlags {
  if (scope.full && (scope.mcp || scope.userMcp)) {
    return { args: ['--disallowedTools', 'Write,Edit,NotebookEdit'] }
  }
  if (scope.full) {
    return { args: ['--tools', 'Read,Grep,Glob'] }
  }
  return { args: ['--tools', '__none__'] }
}
