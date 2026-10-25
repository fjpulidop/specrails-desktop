/**
 * Recoverable errors guard (reaudit-9 #7): every error a person can see goes through
 * `notifyError` (a localized headline, the raw text as secondary detail, a recovery action
 * when there is one). A direct `toast.error(` skips all of that, so none may exist outside
 * the helper itself. Tests may mock it freely.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(__dirname, '../..')
/** Files allowed to call `toast.error` directly. Only the helper. Do not grow this list. */
const ALLOWED = new Set(['lib/notify-error.ts'])

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sources(full, out)
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

describe('error toasts', () => {
  it('only lib/notify-error.ts calls toast.error', () => {
    const offenders = sources(SRC)
      .map((file) => path.relative(SRC, file))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => /\btoast\.error\b/.test(fs.readFileSync(path.join(SRC, rel), 'utf8')))
    expect(offenders).toEqual([])
  })

  it('the allowlist only names files that still need the exception', () => {
    for (const rel of ALLOWED) {
      expect(fs.readFileSync(path.join(SRC, rel), 'utf8')).toMatch(/\btoast\.error\b/)
    }
  })
})
