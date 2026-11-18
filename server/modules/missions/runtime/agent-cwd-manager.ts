import fs from 'fs'
import path from 'path'
import os from 'os'
import { OPERATOR_CWD_INSTRUCTIONS, buildOperatorSystemPrompt } from './agent-operator-prompt'

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

/**
 * The operator core reaches each provider ONCE per session, never repeated in
 * every turn (which would pile up in a resumed session's history):
 * - Claude gets it as the system prompt, so CLAUDE.md only holds a pointer;
 * - Codex (AGENTS.md), Gemini (GEMINI.md) and Kimi (.kimi-code/AGENTS.md) load
 *   their instructions file natively, so the core lives there.
 * See providerLoadsOperatorCore() (agent-operator-prompt.ts) for the turn side.
 */
const INSTRUCTION_FILES: ReadonlyArray<{ name: string; content: () => string }> = [
  { name: 'CLAUDE.md', content: () => OPERATOR_CWD_INSTRUCTIONS },
  { name: 'AGENTS.md', content: buildOperatorSystemPrompt },
  { name: 'GEMINI.md', content: buildOperatorSystemPrompt },
  { name: path.join('.kimi-code', 'AGENTS.md'), content: buildOperatorSystemPrompt },
]

const AGENT_CONVERSATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

function ensureCwd(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(dir, 0o700) } catch { /* best-effort on platforms without chmod */ }
  for (const file of INSTRUCTION_FILES) {
    // App-owned files (not user-edited) — always (re)write so updates take
    // effect and the full manual older builds wrote here is replaced.
    const target = path.join(dir, file.name)
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    fs.writeFileSync(target, file.content(), 'utf-8')
  }
  return dir
}

/**
 * Ensures the app-level agent cwd exists with its operator pointer files.
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
