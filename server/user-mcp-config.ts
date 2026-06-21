// User-approved MCP injection for Explore Spec turns.
//
// When a conversation's ContextScope has `userMcp: true`, the app makes the
// user's OWN already-approved MCP servers available to the spawned CLI — the
// ones they registered locally with `claude mcp add` / `codex mcp add`, NOT the
// project-committed `.mcp.json` (that is the separate `mcp` toggle).
//
// Provider behaviour:
//   - claude: read `~/.claude.json` and collect the user-scope (top-level
//     `mcpServers`) and project-local-scope (`projects[<projectPath>].mcpServers`)
//     server definitions, merge them (local wins on key conflict, mirroring
//     claude's own scope precedence), write a `{ "mcpServers": {…} }` file and
//     return `['--mcp-config', <file>]`. The CLI loads `--mcp-config` ADDITIVELY
//     on top of whatever else it discovers (no `--strict-mcp-config`), and the
//     existing `--dangerously-skip-permissions` flag means the tools are
//     callable without an approval prompt. Verified e2e against claude 2.1.169.
//   - codex: returns `[]`. codex chat turns spawn with `env: process.env` and no
//     `CODEX_HOME` override, so codex already reads the user's global
//     `~/.codex/config.toml` MCP servers natively — no injection needed.
//
// The spawn cwd is intentionally left unchanged (the Explore latency win of the
// app-managed `explore-cwd/` is preserved); `--mcp-config` carries an absolute
// path so cwd is irrelevant.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** A raw MCP server definition as stored in `~/.claude.json`. Shape is opaque
 *  to the app — it is passed straight through to the CLI via `--mcp-config`. */
export type McpServerEntry = Record<string, unknown>

interface ClaudeConfigShape {
  mcpServers?: Record<string, McpServerEntry>
  projects?: Record<string, { mcpServers?: Record<string, McpServerEntry> }>
}

/**
 * Read the user's approved claude MCP servers from `~/.claude.json`:
 * user-scope (top-level `mcpServers`) merged with the project's local-scope
 * (`projects[projectPath].mcpServers`). Local scope overrides user scope on a
 * key conflict, matching claude's documented precedence (local > user).
 *
 * Returns `{}` when the file is missing, unparseable, or has no servers. Never
 * throws — a malformed user config must not break the chat turn.
 *
 * @param projectPath absolute path of the project (the local-scope key)
 * @param homeDir     override the home directory (tests)
 */
export function readUserClaudeMcpServers(
  projectPath: string,
  homeDir?: string,
): Record<string, McpServerEntry> {
  const home = homeDir ?? os.homedir()
  const configPath = path.join(home, '.claude.json')
  let raw: string
  try {
    raw = fs.readFileSync(configPath, 'utf-8')
  } catch {
    return {}
  }
  let parsed: ClaudeConfigShape
  try {
    parsed = JSON.parse(raw) as ClaudeConfigShape
  } catch {
    return {}
  }
  const userScope =
    parsed && typeof parsed.mcpServers === 'object' && parsed.mcpServers
      ? parsed.mcpServers
      : {}
  const projectEntry =
    parsed && typeof parsed.projects === 'object' && parsed.projects
      ? parsed.projects[projectPath]
      : undefined
  const localScope =
    projectEntry && typeof projectEntry.mcpServers === 'object' && projectEntry.mcpServers
      ? projectEntry.mcpServers
      : {}
  return { ...userScope, ...localScope }
}

/**
 * Write the merged server map to a `{ "mcpServers": {…} }` file under the
 * project's data directory and return its absolute path. chmod 600 because
 * server `env` blocks can carry secrets (same trust domain as `~/.claude.json`).
 *
 * @param baseDir override `~/.specrails/projects` (tests)
 */
export function writeUserMcpConfig(
  servers: Record<string, McpServerEntry>,
  slug: string,
  baseDir?: string,
): string {
  // Defence-in-depth: slug is always DB-sourced and slugified upstream
  // (`/^[a-z0-9-]+/`), but guard the filesystem write directly so a future
  // caller passing untrusted input cannot escape the projects directory.
  // buildUserMcpArgs() swallows the throw and falls back to no injection.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`unsafe project slug for user-mcp config: ${JSON.stringify(slug)}`)
  }
  const base = baseDir ?? path.join(os.homedir(), '.specrails', 'projects')
  const dir = path.join(base, slug)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'user-mcp.json')
  fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }, null, 2), { mode: 0o600 })
  // `writeFileSync`'s `mode` is honoured only when the file is CREATED; if the
  // file pre-exists its permissions are left untouched. Force 0o600
  // unconditionally so a pre-existing loose-perm file is tightened (the contents
  // can carry secrets from server `env` blocks).
  fs.chmodSync(file, 0o600)
  return file
}

export interface UserMcpArgsInput {
  /** Resolved adapter id for this turn (`'claude' | 'codex' | …`). */
  adapterId: string
  /** Absolute project path (local-scope key in `~/.claude.json`). */
  projectPath: string
  /** Project slug — names the dir the temp config is written under. */
  slug: string
  /** Override the home directory (tests). */
  homeDir?: string
  /** Override `~/.specrails/projects` (tests). */
  baseDir?: string
}

/**
 * Build the extra CLI args that load the user's approved MCP servers, or `[]`
 * when there is nothing to inject (non-claude provider, or no user/local
 * servers configured). Never throws.
 */
export function buildUserMcpArgs(input: UserMcpArgsInput): string[] {
  // codex reads ~/.codex natively; only claude needs explicit injection.
  if (input.adapterId !== 'claude') return []
  try {
    const servers = readUserClaudeMcpServers(input.projectPath, input.homeDir)
    if (Object.keys(servers).length === 0) return []
    const file = writeUserMcpConfig(servers, input.slug, input.baseDir)
    return ['--mcp-config', file]
  } catch (err) {
    console.error('[user-mcp-config] failed to build --mcp-config args:', err)
    return []
  }
}
