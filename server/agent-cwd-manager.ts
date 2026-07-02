import fs from 'fs'
import path from 'path'
import os from 'os'
import { OPERATOR_INSTRUCTIONS } from './agent-operator-prompt'

// ─── App-level agent working directory (design D1) ────────────────────────────
//
// The agent chat spawns the AI CLI from an app-owned cwd (NOT a project path), so
// no project's CLAUDE.md is auto-loaded and the agent starts with a focused
// "operator" stance. Mirrors explore-cwd-manager but is app-global (one dir, no
// project symlink). The operator instructions are written for every provider
// (CLAUDE.md / AGENTS.md / GEMINI.md) so the chosen CLI picks them up.

function homeDir(): string {
  return process.env.SPECRAILS_REGISTRY_HOME || os.homedir()
}

export function agentCwdPath(): string {
  return path.join(homeDir(), '.specrails', 'agent-cwd')
}

const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'] as const

/**
 * Ensures the app-level agent cwd exists with operator instruction files.
 * Idempotent; safe to call on every turn. Returns the cwd path.
 */
export function ensureAgentCwd(): string {
  const dir = agentCwdPath()
  fs.mkdirSync(dir, { recursive: true })
  for (const name of INSTRUCTION_FILES) {
    // App-owned files (not user-edited) — always (re)write so operator-prompt
    // updates take effect instead of being pinned to the first materialization.
    fs.writeFileSync(path.join(dir, name), OPERATOR_INSTRUCTIONS, 'utf-8')
  }
  return dir
}

/** Removes the agent cwd (used on full teardown / reset). Best-effort. */
export function removeAgentCwd(): void {
  try {
    fs.rmSync(agentCwdPath(), { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}
