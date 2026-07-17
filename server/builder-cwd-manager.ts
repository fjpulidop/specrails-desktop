import fs from 'fs'
import path from 'path'
import os from 'os'
import { BUILDER_INSTRUCTIONS } from './blueprint-operator-prompt'

// ─── Project Builder working directory (add-project-builder D1) ──────────────
//
// Day-0 Builder turns spawn the AI CLI from an app-owned cwd so no project
// CLAUDE.md is auto-loaded (there IS no project yet). Unlike agent-cwd there is
// never a `./project` symlink and never any MCP configuration — the Builder
// only converses and emits fenced blueprint-draft JSON.

function homeDir(): string {
  return process.env.SPECRAILS_REGISTRY_HOME || os.homedir()
}

export function builderCwdPath(): string {
  return path.join(homeDir(), '.specrails', 'builder-cwd')
}

const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'] as const

/**
 * Ensures the Builder cwd exists with instruction files. App-owned files are
 * always (re)written so prompt updates take effect immediately. Idempotent;
 * safe to call on every turn.
 */
export function ensureBuilderCwd(): string {
  const dir = builderCwdPath()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(dir, 0o700) } catch { /* best-effort on platforms without chmod */ }
  for (const name of INSTRUCTION_FILES) {
    fs.writeFileSync(path.join(dir, name), BUILDER_INSTRUCTIONS, 'utf-8')
  }
  // Defence-in-depth: the Builder must never inherit MCP config from a stale
  // file someone dropped here — this dir is wholly app-owned.
  try { fs.unlinkSync(path.join(dir, '.mcp.json')) } catch { /* absent */ }
  return dir
}

/** Removes the Builder cwd (full teardown / reset). Best-effort. */
export function removeBuilderCwd(): void {
  try {
    fs.rmSync(builderCwdPath(), { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}
