import { readFileSync, existsSync } from 'fs'
import { join, resolve } from 'path'

/**
 * Locate the app repository root (the directory containing .claude/commands/).
 * Works in both dev mode (tsx: __dirname = <repo>/server/) and
 * compiled mode (tsc: __dirname = <repo>/server/dist/).
 */
function findDesktopRoot(): string | null {
  let dir = resolve(__dirname, '..')
  if (existsSync(join(dir, '.claude', 'commands'))) return dir
  dir = resolve(__dirname, '../..')
  if (existsSync(join(dir, '.claude', 'commands'))) return dir
  return null
}

const DESKTOP_ROOT = findDesktopRoot()

function builtInCommand(commandPath: string, commandArgs: string): string | null {
  if (commandPath !== 'specrails:explore-spec') return null

  return `You are a senior product engineer helping the user shape one backlog spec inside Specrails' Explore Spec experience.

Do not use any local skill, slash-command workflow, or repository-change workflow. Stay inside this chat and shape the draft ticket only. Do not inspect active change folders unless the user explicitly asks about them, and do not create or modify files. The app commits the final ticket only when the user clicks Create Spec.

Your job is to maintain a live draft. After every assistant turn that changes draft state, end your message with a fenced \`spec-draft\` JSON block. The visible prose should match the user's language. Draft fields must be written in English.

Use this draft schema. Omit fields you do not want to update:

\`\`\`spec-draft
{
  "title": "Concise, action-oriented title",
  "description": "## Problem Statement\\n2-3 sentences.\\n\\n## Proposed Solution\\n3-5 sentences.\\n\\n## Technical Considerations\\n- bullet\\n\\n## Estimated Complexity\\nMedium - one sentence justification.",
  "nonGoals": ["What this spec deliberately does NOT change or deliver"],
  "labels": ["short-label"],
  "priority": "low | medium | high | critical",
  "acceptanceCriteria": ["Short, testable criterion"],
  "chips": ["Up to 3 short replies"],
  "ready": false
}
\`\`\`

Rules:
- Ask only the clarifying questions genuinely needed to make the spec concrete.
- Keep visible replies brief.
- \`nonGoals\` lists 1-5 things the spec deliberately leaves out (shown as \"Out of scope\" under the description); keep them out of \`description\`.
- Set \`ready: true\` only when the draft has a title, description, acceptance criteria, at least one non-goal, and no outstanding clarifying question.
- Never call \`/specrails:propose-spec\`, \`/specrails:implement\`, or any slash command with side effects.

The user's idea follows below. Begin the Explore Spec conversation.

---

${commandArgs}`.trim()
}

/**
 * A `:`-separated command segment is safe iff it is a plain identifier: no path
 * separators, no `.`/`..`, no NUL. Anything else could escape the
 * commands/skills directory once joined into the lookup path.
 */
function isSafeSegment(seg: string): boolean {
  if (seg.length === 0 || seg === '.' || seg === '..') return false
  return !/[/\\\0]/.test(seg)
}

/**
 * Try to find a command/skill .md file for the given command path parts
 * within the given base directory. Returns the resolved path or null.
 */
function findCommandFile(baseDir: string, parts: string[]): string | null {
  const filePath = join(baseDir, '.claude', 'commands', ...parts) + '.md'
  if (existsSync(filePath)) return filePath
  const skillPath = join(baseDir, '.claude', 'skills', ...parts) + '.md'
  if (existsSync(skillPath)) return skillPath
  return null
}

/**
 * Resolves a slash command string to its full prompt content.
 * Reads the command file from .claude/commands/ or .claude/skills/,
 * strips YAML frontmatter, and substitutes $ARGUMENTS.
 *
 * Searches the project directory first, then falls back to the app's
 * own .claude/commands/ directory (for app-namespaced commands like
 * /specrails:implement that aren't installed in the target project).
 *
 * Falls back to returning the command string as-is if the file is not found.
 */
export function resolveCommand(command: string, cwd: string): string {
  const match = command.match(/^\/([^\s]+)\s*(.*)$/s)
  if (!match) return command

  const commandPath = match[1]
  const commandArgs = match[2].trim()
  const parts = commandPath.split(':')

  const builtIn = builtInCommand(commandPath, commandArgs)
  if (builtIn) return builtIn

  // Path-traversal guard: each segment is joined verbatim into
  // `<baseDir>/.claude/commands/<...parts>.md`, so a segment like `..`, one
  // containing a path separator, or an absolute fragment would escape the
  // commands/skills directory and read an arbitrary file. Reject and leave the
  // command unresolved (defense-in-depth even though the input is user-typed).
  if (!parts.every(isSafeSegment)) return command

  // 1. Check the project directory
  let resolvedPath = findCommandFile(cwd, parts)

  // 2. Fallback: check the app's own directory
  if (!resolvedPath && DESKTOP_ROOT && resolve(cwd) !== resolve(DESKTOP_ROOT)) {
    resolvedPath = findCommandFile(DESKTOP_ROOT, parts)
  }

  if (!resolvedPath) return command

  let content = readFileSync(resolvedPath, 'utf-8')
  content = content.replace(/^---[\s\S]*?---\s*/, '')
  content = content.replace(/\$ARGUMENTS/g, commandArgs)
  return content.trim()
}
