// Gemini headless subagent pre-acknowledgment.
//
// gemini 0.46+ DISCOVERS `<project>/.gemini/agents/*.md` but only ENABLES a
// project's custom subagents after an interactive "New Agents Discovered →
// Acknowledge and Enable" prompt. That prompt never fires in headless
// (`gemini -p`) spawns — which is how the desktop runs every rail — so
// `invoke_agent sr-architect` returns "Subagent not found" and the implement
// orchestrator silently falls back to a generic agent (the specialised
// architect/developer/reviewer personas never run in isolation).
//
// specrails-core writes the acknowledgment file at install time; this is the
// defence-in-depth copy the desktop runs right before a gemini rail spawn, so a
// project installed with an older core (or whose agents changed since install)
// is still trusted headless. The file gemini reads is
// `~/.gemini/acknowledgments/agents.json`, shaped
//   { [projectRoot]: { [agentName]: <sha256-hex of the agent .md file> } }
// where the hash is sha256 of the FULL agent markdown file (verified empirically
// against gemini 0.47). Entries are MERGED so other projects (and other agents)
// survive. Best-effort — callers swallow any error; a failure only means the
// agents need the one-time interactive acknowledge.

import { createHash } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

type AckStore = Record<string, Record<string, string>>

function ackFilePath(): string {
  return join(homedir(), '.gemini', 'acknowledgments', 'agents.json')
}

/**
 * Pre-acknowledge every `<projectPath>/.gemini/agents/*.md` so gemini loads them
 * in headless mode. No-op when the project has no `.gemini/agents` dir or no
 * agent files. The `projectPath` is the key gemini uses (the spawn cwd / repo
 * root), matching what `specrails-core` writes at install.
 */
export function acknowledgeGeminiProjectAgents(projectPath: string): void {
  const agentsDir = join(projectPath, '.gemini', 'agents')
  if (!existsSync(agentsDir)) return
  const agentFiles = readdirSync(agentsDir).filter(
    (f) => f.endsWith('.md') && !f.startsWith('_'),
  )
  if (agentFiles.length === 0) return

  const ackPath = ackFilePath()
  let store: AckStore = {}
  if (existsSync(ackPath)) {
    try {
      const parsed = JSON.parse(readFileSync(ackPath, 'utf8')) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        store = parsed as AckStore
      }
    } catch {
      // Corrupt/unreadable file — start fresh rather than crash the spawn.
    }
  }

  const projectEntry: Record<string, string> = { ...(store[projectPath] ?? {}) }
  for (const file of agentFiles) {
    const content = readFileSync(join(agentsDir, file), 'utf8')
    projectEntry[file.slice(0, -3)] = createHash('sha256').update(content).digest('hex')
  }
  store[projectPath] = projectEntry

  mkdirSync(join(homedir(), '.gemini', 'acknowledgments'), { recursive: true })
  writeFileSync(ackPath, `${JSON.stringify(store, null, 2)}\n`)
}
