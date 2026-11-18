import fs from 'fs'
import path from 'path'
import { resolveSpecrailsHome } from '../../../util/specrails-home'
import { parseContinuityState, type ContinuityState } from '../domain'
import type { ContinuityStore } from '../ports'

export function continuityFilePath(specrailsHome: string = resolveSpecrailsHome()): string {
  return path.join(specrailsHome, '.specrails', 'turn-continuity.json')
}

/** One 0600 JSON document, replaced atomically (temp + rename). */
export function createFileContinuityStore(file: string = continuityFilePath()): ContinuityStore {
  return {
    load(): ContinuityState {
      let raw: string | null = null
      try { raw = fs.readFileSync(file, 'utf8') } catch { /* absent */ }
      return parseContinuityState(raw)
    },
    save(state: ContinuityState): void {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      const tmp = `${file}.tmp-${process.pid}`
      fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 })
      fs.renameSync(tmp, file)
    },
  }
}
