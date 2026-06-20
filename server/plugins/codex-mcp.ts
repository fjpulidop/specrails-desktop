// Codex MCP registration helpers. Plugins on codex projects don't write
// `<project>/.mcp.json`; instead, the app invokes `codex mcp add` against
// a per-project `CODEX_HOME` so the resulting MCP registration is scoped
// to that project alone, never leaking into the user's terminal codex
// state or another managed project.
//
// Spec: openspec/changes/add-multi-provider-support/specs/plugin-system/spec.md
//   - "Plugin install path is provider-aware" / "Per-provider home directory
//      isolates plugin state"

import { spawnSync } from 'child_process'
import crossSpawn from 'cross-spawn'
import fs from 'fs'
import path from 'path'
import os from 'os'

import { windowsSpawnEnv } from '../util/win-spawn'

/**
 * Spawn `codex` synchronously, Windows-safe. On Windows the codex CLI is a
 * `.cmd` shim; Node 20.12+ (CVE-2024-27980) refuses to spawn `.cmd` without a
 * shell, and the packaged sidecar may lack `SystemRoot`/`ComSpec` — so route
 * through cross-spawn (resolves the shim, runs cmd.exe with correct quoting)
 * under `windowsSpawnEnv()`. POSIX is a plain `spawnSync`.
 */
function codexSpawn(argv: string[], extraEnv: NodeJS.ProcessEnv) {
  const env = windowsSpawnEnv({ ...process.env, ...extraEnv })
  const opts = { env, encoding: 'utf-8' as const, timeout: 10_000 }
  return process.platform === 'win32'
    ? crossSpawn.sync('codex', argv, opts)
    : spawnSync('codex', argv, opts)
}

/** Per-project CODEX_HOME root, sibling of the existing
 *  `~/.specrails/projects/<slug>/{telemetry,jobs,explore-cwd,...}` tree. */
export function codexHomeFor(slug: string): string {
  return path.join(os.homedir(), '.specrails', 'projects', slug, 'codex-home')
}

/** Lazy-create the per-project codex home so `codex mcp add` writes its
 *  config there without touching the user's `~/.codex/`. */
export function ensureCodexHome(slug: string): string {
  const dir = codexHomeFor(slug)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export interface CodexMcpEntry {
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface CodexMcpResult {
  ok: boolean
  stdout: string
  stderr: string
}

/** Run `codex mcp add <name> -- <command> <args...>` with the project's
 *  CODEX_HOME exported. Idempotent at the caller level — invokers should
 *  probe `codexMcpList` first when re-registration matters. */
export function codexMcpAdd(slug: string, name: string, entry: CodexMcpEntry): CodexMcpResult {
  const home = ensureCodexHome(slug)
  const argv = ['mcp', 'add', name, '--', entry.command, ...entry.args]
  const result = codexSpawn(argv, { ...(entry.env ?? {}), CODEX_HOME: home })
  if (result.error) {
    return { ok: false, stdout: '', stderr: `${result.error.message}` }
  }
  return {
    ok: (result.status ?? 1) === 0,
    stdout: `${result.stdout ?? ''}`,
    stderr: `${result.stderr ?? ''}`,
  }
}

/** Run `codex mcp remove <name>` against the per-project CODEX_HOME. */
export function codexMcpRemove(slug: string, name: string): CodexMcpResult {
  const home = ensureCodexHome(slug)
  const result = codexSpawn(['mcp', 'remove', name], { CODEX_HOME: home })
  if (result.error) {
    return { ok: false, stdout: '', stderr: `${result.error.message}` }
  }
  return {
    ok: (result.status ?? 1) === 0,
    stdout: `${result.stdout ?? ''}`,
    stderr: `${result.stderr ?? ''}`,
  }
}

/** Run `codex mcp list` against the per-project CODEX_HOME and return the
 *  list of registered server names. Output format is `codex mcp list`'s
 *  plain text — best-effort line scan, since codex doesn't expose --json
 *  for this subcommand. */
export function codexMcpList(slug: string): { ok: boolean; servers: string[]; raw: string } {
  const home = ensureCodexHome(slug)
  const result = codexSpawn(['mcp', 'list'], { CODEX_HOME: home })
  if (result.error || (result.status ?? 1) !== 0) {
    return { ok: false, servers: [], raw: `${result.stderr ?? result.stdout ?? ''}` }
  }
  const raw = `${result.stdout ?? ''}`
  // Heuristic line scan: a server name appears at the start of a line, then
  // whitespace, then the command. Lines starting with `#` or empty are
  // ignored. Empty list also returns ok with []. We intentionally don't
  // hard-fail when the format drifts — manifest-level checks downstream
  // catch real misalignments.
  const servers: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const firstToken = trimmed.split(/\s+/)[0]
    if (firstToken && /^[A-Za-z][A-Za-z0-9_-]*$/.test(firstToken)) {
      servers.push(firstToken)
    }
  }
  return { ok: true, servers, raw }
}
