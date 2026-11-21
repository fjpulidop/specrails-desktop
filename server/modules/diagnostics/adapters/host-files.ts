/**
 * Files the desktop host keeps in its log folder (`SPECRAILS_HOST_LOG_DIR`):
 * `sidecar.log`, `desktop.log` and `crashes/crash-*.json`. The host writes the
 * logs and markers; this adapter only reads them and writes
 * `crashes/acknowledged.json`, so the two processes never write the same file.
 * Outside the desktop app (no folder) every read is empty.
 */
import fs from 'fs'
import path from 'path'
import { parseCrashMarker, type CrashMarker } from '../domain'
import type { CrashMarkerStore } from '../ports'

const MAX_MARKER_BYTES = 256 * 1024
const ACK_FILE = 'acknowledged.json'

export function hostLogDirFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = env.SPECRAILS_HOST_LOG_DIR?.trim()
  return dir && path.isAbsolute(dir) ? dir : null
}

/** The last `maxBytes` of a host log file (from a line boundary), or null when absent. */
export function readHostLogTail(dir: string | null, name: 'sidecar.log' | 'desktop.log', maxBytes = 512 * 1024): string | null {
  if (!dir) return null
  const file = path.join(dir, name)
  let fd: number | null = null
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)
    fs.readSync(fd, buffer, 0, length, size - length)
    let text = buffer.toString('utf8')
    if (length < size) {
      const newline = text.indexOf('\n')
      text = newline >= 0 ? text.slice(newline + 1) : text
    }
    return text
  } catch {
    return null
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

export function createHostCrashStore(dir: string | null): CrashMarkerStore {
  const crashes = dir ? path.join(dir, 'crashes') : null
  return {
    available: crashes !== null,
    list() {
      if (!crashes) return []
      let names: string[]
      try { names = fs.readdirSync(crashes) } catch { return [] }
      const markers: CrashMarker[] = []
      for (const name of names) {
        if (!/^crash-[0-9-]+\.json$/.test(name)) continue
        try {
          const file = path.join(crashes, name)
          if (fs.statSync(file).size > MAX_MARKER_BYTES) continue
          const marker = parseCrashMarker(JSON.parse(fs.readFileSync(file, 'utf8')))
          if (marker) markers.push(marker)
        } catch { /* a malformed marker is skipped, never fatal */ }
      }
      return markers
    },
    acknowledgedThrough() {
      if (!crashes) return 0
      try {
        const value = (JSON.parse(fs.readFileSync(path.join(crashes, ACK_FILE), 'utf8')) as { throughMs?: unknown }).throughMs
        return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
      } catch {
        return 0
      }
    },
    acknowledge(throughMs) {
      if (!crashes) return
      fs.mkdirSync(crashes, { recursive: true })
      const target = path.join(crashes, ACK_FILE)
      const partial = `${target}.${process.pid}.partial`
      fs.writeFileSync(partial, `${JSON.stringify({ throughMs })}\n`, { mode: 0o600 })
      fs.renameSync(partial, target)
    },
  }
}
