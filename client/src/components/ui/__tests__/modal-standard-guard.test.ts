/**
 * Source guard for the modal standard (docs/internals/modal-standard.md).
 * The client has no lint step, so these checks run with the test suite:
 *  - no hand-rolled `aria-modal` dialogs outside components/ui (use Radix via
 *    DialogContent / ConfirmDialog / DialogPrimitive);
 *  - no sub-11px text classes in files that render a modal panel (12px floor;
 *    11px only on `data-chip` pills).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(__dirname, '../../..')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === 'demo-mode') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) out.push(full)
  }
  return out
}

const files = walk(SRC)
const rel = (f: string) => path.relative(SRC, f)

describe('modal standard guard', () => {
  it('has no hand-rolled aria-modal dialogs outside components/ui', () => {
    // `[aria-modal="true"]` inside a selector string is fine; a JSX attribute is not.
    const offenders = files
      .filter((f) => !rel(f).startsWith(`components${path.sep}ui${path.sep}`))
      .filter((f) => /(?<!\[)aria-modal=/.test(fs.readFileSync(f, 'utf8')))
      .map(rel)
    expect(offenders).toEqual([])
  })

  it('keeps text inside modal files at or above the 11px chip exception', () => {
    const modalFiles = files.filter((f) =>
      /<DialogContent\b|<DialogPrimitive\.Content\b|<ConfirmDialog\b/.test(fs.readFileSync(f, 'utf8')),
    )
    expect(modalFiles.length).toBeGreaterThan(30)
    const offenders: string[] = []
    for (const f of modalFiles) {
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/text-\[(?:[0-9]|10|10\.5)px\]/.test(line)) offenders.push(`${rel(f)}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
