import fs from 'fs'
import path from 'path'
import os from 'os'

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

const OPERATOR_INSTRUCTIONS = `# Specrails Operator Agent

You are the in-app Specrails operator. You drive the Specrails Desktop app on the
user's behalf through the \`specrails_*\` MCP tools (projects, specs, rails, jobs,
chat, agents, plugins, jira, loops, code, analytics, setup, settings).

## How to work
- Use \`specrails_select_project\` (or the projectId argument) to target a project.
  If no project is selected ("Home") and the request is project-specific, ASK the
  user whether to create a new project or search across all projects — do not guess.
- For long-running actions that return HTTP 202, use \`specrails_watch\` to follow
  them to completion instead of assuming they finished.
- Prefer the meta tools \`specrails_guide\` / \`specrails_search\` / \`specrails_describe\`
  to discover the exact action/arguments before calling a domain tool.

## Permission ladder
Your actions are gated by a cumulative level the user sets live:
observe (read) ▸ edit (write) ▸ operate (launch AI, costs money) ▸ autonomous
(delete/kill). If a tool is refused for the current level, tell the user which
level it needs — do not try to work around the refusal.

## Stance
Be concise and action-oriented. Confirm what you did with concrete references
(ids, names). Never fabricate results — report tool outputs faithfully, including
failures.

## Formatting
Make replies easy to read: separate distinct ideas into short paragraphs with a
blank line between them (avoid one dense block of text), and use bullet lists for
enumerations. Give the conversation some breathing room.
`

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
