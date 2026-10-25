/**
 * Type-floor guard (reaudit-8 #12): 11px (`text-caption`) is the smallest type role. The 10.5px
 * `text-micro` role is retired, and ad-hoc `text-[Npx]` sizes bypass the role scale entirely.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(__dirname, '../..')

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === 'locales') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sources(full, out)
    else if (/\.(tsx|ts|css)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full)
  }
  return out
}

describe('type scale floor', () => {
  const files = sources(SRC)

  it('has no text-micro utility or --text-micro token left', () => {
    const offenders = files.filter((f) => /text-micro|--text-micro/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(SRC, f))
    expect(offenders).toEqual([])
  })

  it('uses no arbitrary text-[Npx] size below the 11px caption role in components', () => {
    const offenders: string[] = []
    for (const f of files.filter((x) => x.endsWith('.tsx'))) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
        if (Number(m[1]) < 11) offenders.push(`${path.relative(SRC, f)}: ${m[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
