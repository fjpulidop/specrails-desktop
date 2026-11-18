import { open, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// Effectful lookup of a Codex session rollout:
// `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<sessionId>.jsonl`
// (CODEX_HOME defaults to ~/.codex). Only the tail of the file is read: a long
// session's rollout can be large, and the context snapshot is its last
// `token_count` event (parsed by mission-context-usage.ts).

export const CODEX_ROLLOUT_TAIL_BYTES = 256 * 1024

export function codexSessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEX_HOME?.trim()
  return path.join(home ? home : path.join(os.homedir(), '.codex'), 'sessions')
}

async function entries(dir: string): Promise<Array<{ name: string; directory: boolean }>> {
  try {
    return (await readdir(dir, { withFileTypes: true })).map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
  } catch {
    return []
  }
}

/** Find the rollout of `sessionId`, newest date directories first. Null when absent. */
export async function findCodexRollout(sessionId: string, root: string = codexSessionsRoot()): Promise<string | null> {
  // A session id is a UUID; anything else must never become a path fragment.
  if (!/^[A-Za-z0-9-]{8,128}$/.test(sessionId)) return null
  const suffix = `-${sessionId}.jsonl`
  const search = async (dir: string, depth: number): Promise<string | null> => {
    const listed = await entries(dir)
    const file = listed.find((entry) => !entry.directory && entry.name.startsWith('rollout-') && entry.name.endsWith(suffix))
    if (file) return path.join(dir, file.name)
    if (depth >= 4) return null
    const dirs = listed.filter((entry) => entry.directory).map((entry) => entry.name).sort().reverse()
    for (const name of dirs) {
      const found = await search(path.join(dir, name), depth + 1)
      if (found) return found
    }
    return null
  }
  return search(root, 0)
}

/** The last `maxBytes` of a file as UTF-8, or null when it cannot be read. */
export async function readFileTail(file: string, maxBytes: number = CODEX_ROLLOUT_TAIL_BYTES): Promise<string | null> {
  let handle
  try {
    handle = await open(file, 'r')
    const { size } = await handle.stat()
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/** Tail of the rollout for `sessionId`, or null when there is none. */
export async function readCodexRolloutTail(sessionId: string, root?: string): Promise<string | null> {
  const file = await findCodexRollout(sessionId, root)
  return file ? readFileTail(file) : null
}
