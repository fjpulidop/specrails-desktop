import { readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { readFileTail } from './codex-rollout-reader'

// Effectful lookup of a Claude Code session transcript:
// `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<sessionId>.jsonl` (the config
// dir defaults to ~/.claude). The encoded cwd replaces path separators, dots
// and other non-alphanumerics with '-'. When neither encoding matches (e.g. a
// symlinked tmp dir), a bounded scan of the project dirs finds the file. The
// caller owns the per-session path cache, so no global state is kept here.

export const CLAUDE_PROJECT_SCAN_LIMIT = 2000

export function claudeProjectsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim()
  return path.join(configDir ? configDir : path.join(os.homedir(), '.claude'), 'projects')
}

/** Candidate directory names Claude Code uses for a cwd (most specific first). */
export function encodeClaudeProjectDir(cwd: string): string[] {
  const separatorsAndDots = cwd.replace(/[\\/.:]/g, '-')
  const nonAlphanumeric = cwd.replace(/[^A-Za-z0-9]/g, '-')
  return [...new Set([separatorsAndDots, nonAlphanumeric])]
}

async function isFile(file: string): Promise<boolean> {
  try { return (await stat(file)).isFile() } catch { return false }
}

/** Find the transcript of `sessionId`; null when absent. Hits are cached in `cache`. */
export async function findClaudeTranscript(
  sessionId: string,
  cwd: string | null,
  options: { root?: string; cache?: Map<string, string> } = {},
): Promise<string | null> {
  if (!/^[A-Za-z0-9-]{8,128}$/.test(sessionId)) return null
  const root = options.root ?? claudeProjectsRoot()
  const cached = options.cache?.get(sessionId)
  if (cached && await isFile(cached)) return cached
  const name = `${sessionId}.jsonl`
  const remember = (file: string) => { options.cache?.set(sessionId, file); return file }
  for (const dir of cwd ? encodeClaudeProjectDir(cwd) : []) {
    const file = path.join(root, dir, name)
    if (await isFile(file)) return remember(file)
  }
  let dirs: string[]
  try {
    dirs = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return null
  }
  for (const dir of dirs.slice(0, CLAUDE_PROJECT_SCAN_LIMIT)) {
    const file = path.join(root, dir, name)
    if (await isFile(file)) return remember(file)
  }
  return null
}

/** Tail of the transcript for `sessionId`, or null when there is none. */
export async function readClaudeTranscriptTail(
  sessionId: string,
  cwd: string | null,
  options: { root?: string; cache?: Map<string, string> } = {},
): Promise<string | null> {
  const file = await findClaudeTranscript(sessionId, cwd, options)
  return file ? readFileTail(file) : null
}
