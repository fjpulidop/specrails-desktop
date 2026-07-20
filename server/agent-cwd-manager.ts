import fs from 'fs'
import path from 'path'
import os from 'os'
import { OPERATOR_INSTRUCTIONS } from './agent-operator-prompt'

// ─── App-level agent working directory (design D1) ────────────────────────────
//
// The agent chat spawns the AI CLI from an app-owned cwd (NOT a project path), so
// no project's CLAUDE.md is auto-loaded and the agent starts with a focused
// "operator" stance. Claude/Codex retain the original app-global cwd. Providers
// whose MCP config is cwd-discovered under a nested project path (Gemini/Kimi)
// get a per-conversation child cwd so concurrent turns cannot overwrite each
// other's capability-file reference.

function homeDir(): string {
  return process.env.SPECRAILS_REGISTRY_HOME || os.homedir()
}

export function agentCwdPath(): string {
  return path.join(homeDir(), '.specrails', 'agent-cwd')
}

const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'] as const
const AGENT_CONVERSATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

function ensureCwd(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(dir, 0o700) } catch { /* best-effort on platforms without chmod */ }
  for (const name of INSTRUCTION_FILES) {
    // App-owned files (not user-edited) — always (re)write so operator-prompt
    // updates take effect instead of being pinned to the first materialization.
    fs.writeFileSync(path.join(dir, name), OPERATOR_INSTRUCTIONS, 'utf-8')
  }
  return dir
}

/**
 * Ensures the app-level agent cwd exists with operator instruction files.
 * Idempotent; safe to call on every turn. Returns the cwd path.
 */
export function ensureAgentCwd(): string {
  const dir = agentCwdPath()
  ensureCwd(dir)

  // Older builds wrote Gemini's per-turn MCP registration into this shared cwd.
  // Claude also discovers `.mcp.json` from cwd, so leaving that stale file in
  // place could make a later Claude turn load another conversation's still-live
  // capability. This directory is wholly app-owned; remove only those legacy
  // generated config files while preserving the operator instructions.
  try { fs.unlinkSync(path.join(dir, '.mcp.json')) } catch { /* absent */ }
  try { fs.unlinkSync(path.join(dir, '.gemini', 'settings.json')) } catch { /* absent */ }
  try { fs.rmdirSync(path.join(dir, '.gemini')) } catch { /* non-empty / absent */ }
  try { fs.unlinkSync(path.join(dir, '.kimi-code', 'mcp.json')) } catch { /* absent */ }
  try { fs.rmdirSync(path.join(dir, '.kimi-code')) } catch { /* non-empty / absent */ }
  return dir
}

/** Path for provider state that must not be shared across agent conversations. */
export function agentConversationCwdPath(conversationId: string): string {
  if (!AGENT_CONVERSATION_ID_RE.test(conversationId)) {
    throw new Error(`unsafe agent conversation id: ${conversationId}`)
  }
  return path.join(agentCwdPath(), 'conversations', conversationId)
}

/**
 * Materialise an isolated agent cwd for one conversation. Cwd-discovered
 * provider MCP files can never be overwritten by another conversation.
 */
export function ensureAgentConversationCwd(conversationId: string): string {
  return ensureCwd(agentConversationCwdPath(conversationId))
}

/** Removes the agent cwd (used on full teardown / reset). Best-effort. */
export function removeAgentCwd(): void {
  try {
    fs.rmSync(agentCwdPath(), { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}
