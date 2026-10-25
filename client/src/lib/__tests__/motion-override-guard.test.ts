/**
 * Source guard: the in-app Motion setting (<html data-motion="reduce|full">) must win over the
 * OS `prefers-reduced-motion` in EVERY stylesheet and Tailwind variant, not only in JS motion
 * (reaudit-7 #5). "Full motion" used to animate `motion/react` while hand-written media blocks
 * and `motion-safe:` utilities still obeyed the OS.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(__dirname, '../..')

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'locales') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) cssFiles(full, out)
    else if (entry.name.endsWith('.css')) out.push(full)
  }
  return out
}

interface MediaBlock { file: string; kind: 'reduce' | 'no-preference'; body: string; after: string }

function mediaBlocks(): MediaBlock[] {
  const blocks: MediaBlock[] = []
  for (const file of cssFiles(SRC)) {
    const src = fs.readFileSync(file, 'utf8')
    const re = /@media \(prefers-reduced-motion: (reduce|no-preference)\) \{/g
    for (let m = re.exec(src); m; m = re.exec(src)) {
      let depth = 1
      let i = re.lastIndex
      while (depth > 0 && i < src.length) { const c = src[i++]; if (c === '{') depth++; else if (c === '}') depth-- }
      blocks.push({ file: path.relative(SRC, file), kind: m[1] as MediaBlock['kind'], body: src.slice(re.lastIndex, i - 1), after: src.slice(i) })
    }
  }
  return blocks
}

describe('Motion setting overrides the OS preference everywhere', () => {
  const blocks = mediaBlocks()

  it('finds the stylesheet motion blocks', () => {
    expect(blocks.length).toBeGreaterThan(10)
  })

  it('scopes every prefers-reduced-motion block to the data-motion override', () => {
    const offenders = blocks
      .filter((b) => {
        const guard = b.kind === 'reduce' ? ':root:not([data-motion="full"])' : ':root:not([data-motion="reduce"])'
        return !b.body.trimStart().startsWith(guard)
      })
      .map((b) => `${b.file}: ${b.kind}`)
    expect(offenders).toEqual([])
  })

  it('gives each block its explicit counterpart for the opposite setting', () => {
    // Blocks whose reduce counterpart is the pre-existing global `:root[data-motion="reduce"]` rules.
    const covered = (b: MediaBlock) => b.kind === 'reduce' && /animate-rail-travel|\.title-shimmer|^\s*:root:not\(\[data-motion="full"\]\) \{\s*\*,/.test(b.body)
    const missing = blocks
      .filter((b) => !covered(b))
      .filter((b) => !b.after.includes(b.kind === 'reduce' ? ':root[data-motion="reduce"] {' : ':root[data-motion="full"] {'))
      .map((b) => `${b.file}: ${b.kind}`)
    expect(missing).toEqual([])
  })

  it('redefines the Tailwind motion-safe / motion-reduce variants on the same setting', () => {
    const globals = fs.readFileSync(path.join(SRC, 'globals.css'), 'utf8')
    const safe = globals.match(/@custom-variant motion-safe \{[\s\S]*?\n\}/)?.[0] ?? ''
    const reduce = globals.match(/@custom-variant motion-reduce \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(safe).toContain('prefers-reduced-motion: no-preference')
    expect(safe).toContain(':root:not([data-motion="reduce"]) &')
    expect(safe).toContain(':root[data-motion="full"] &')
    expect(reduce).toContain('prefers-reduced-motion: reduce')
    expect(reduce).toContain(':root:not([data-motion="full"]) &')
    expect(reduce).toContain(':root[data-motion="reduce"] &')
  })

  it('keeps the rail travel animation under "full" even when the OS asks to reduce', () => {
    const globals = fs.readFileSync(path.join(SRC, 'globals.css'), 'utf8')
    // The OS-reduce rule that stops the pill only applies when the setting is not "full".
    const block = blocks.find((b) => b.file === 'globals.css' && b.body.includes('.animate-rail-travel'))!
    expect(block.body.trimStart().startsWith(':root:not([data-motion="full"])')).toBe(true)
    // …and the authored animation itself is unconditional.
    expect(globals).toMatch(/@utility animate-rail-travel \{\s*animation: rail-travel/)
  })
})
