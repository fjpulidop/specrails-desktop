/**
 * Recovery guard (reaudit-10 #7): a failure toast in settings and loops must offer a way forward.
 * Every `notifyError(` there carries `retry` (re-runs the operation) or `action` (another way out),
 * except input validation, where the person fixes the field and tries again.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(__dirname, '../..')
const ROOTS = ['features/settings', 'features/loops/pages']

/** Validation or copy-to-clipboard messages: nothing to retry. Match on the translation key. */
const NO_RETRY_KEY = /(invalid|required|selectEvent|copyFailed|unsupportedFile|unavailable|notAnswer)/i
/** Failures that cannot be retried from here, with the reason. */
const ALLOWLIST: Record<string, string> = {
  // The same message also covers a retried scan; this first call is a browser without camera support.
  'features/settings/components/PairWebCompanionModal.tsx:pairWeb.cameraFailed': 'no getUserMedia: nothing to retry',
}

function files(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files(full, out)
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

/** The text of each `notifyError(...)` call, found by balancing parentheses. */
function calls(source: string): string[] {
  const found: string[] = []
  let from = 0
  for (;;) {
    const start = source.indexOf('notifyError(', from)
    if (start < 0) return found
    let depth = 0
    let i = start + 'notifyError'.length
    for (; i < source.length; i++) {
      if (source[i] === '(') depth++
      else if (source[i] === ')' && --depth === 0) break
    }
    found.push(source.slice(start, i + 1))
    from = i
  }
}

describe('failure toasts in settings and loops offer recovery', () => {
  it('every notifyError carries retry or action unless it is input validation', () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      for (const file of files(path.join(SRC, root))) {
        const rel = path.relative(SRC, file)
        const source = fs.readFileSync(file, 'utf8')
        for (const call of calls(source)) {
          if (/\b(retry|action)\b/.test(call)) continue
          const key = /notifyError\(\s*(?:[a-zA-Z.]*\()?\s*['"`]([^'"`]+)['"`]/.exec(call)?.[1] ?? call
          if (NO_RETRY_KEY.test(key) || ALLOWLIST[`${rel}:${key}`]) continue
          offenders.push(`${rel}: ${call.replace(/\s+/g, ' ').slice(0, 110)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
