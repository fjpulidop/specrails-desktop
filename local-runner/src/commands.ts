import fs from 'fs'
import path from 'path'

/**
 * Slash-command expansion (design D5).
 *
 * Claude expands `/name args` by reading `<cwd>/.claude/commands/<name>.md`
 * (a namespaced `/ns:name` maps to `<cwd>/.claude/commands/ns/name.md`) and
 * substituting `$ARGUMENTS` with the remainder of the line. The desktop
 * relies on that for every `/specrails:*` rail command, so the runner
 * mirrors it: the expanded command text becomes the TAIL of the system prompt
 * and the original prompt line stays the user turn (so the persisted history
 * reads naturally). A prompt whose command file does not exist is answered
 * with `Unknown command: /<name>` + a `result` error WITHOUT any network call —
 * the same failure semantics the desktop already handles for kimi.
 */
export interface SlashCommand {
  name: string
  args: string
  file: string
}

const COMMAND_RE = /^\/([A-Za-z0-9_:-]+)(?:\s+([\s\S]*))?$/

export function detectSlashCommand(prompt: string): { name: string; args: string } | null {
  const m = COMMAND_RE.exec(prompt.trim())
  if (!m) return null
  return { name: m[1], args: (m[2] ?? '').trim() }
}

export function commandFilePath(cwd: string, name: string): string {
  return path.join(cwd, '.claude', 'commands', ...name.split(':')) + '.md'
}

export type SlashResolution =
  | { kind: 'none' }
  | { kind: 'unknown'; name: string }
  | { kind: 'expanded'; name: string; systemTail: string }

export function resolveSlashCommand(cwd: string, prompt: string): SlashResolution {
  const cmd = detectSlashCommand(prompt)
  if (!cmd) return { kind: 'none' }
  const file = commandFilePath(cwd, cmd.name)
  let body: string
  try {
    body = fs.readFileSync(file, 'utf8')
  } catch {
    return { kind: 'unknown', name: cmd.name }
  }
  return { kind: 'expanded', name: cmd.name, systemTail: expandCommand(body, cmd.args) }
}

/** Strips YAML frontmatter and substitutes `$ARGUMENTS`. */
export function expandCommand(body: string, args: string): string {
  let text = body
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3)
    if (end !== -1) text = text.slice(end + 4).replace(/^\r?\n/, '')
  }
  return text.replace(/\$ARGUMENTS/g, args)
}
