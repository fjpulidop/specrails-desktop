/**
 * Contrast guard (reaudit-8 #2): every theme in globals.css must keep its text tokens readable on the
 * surfaces they sit on (WCAG AA, 4.5:1), and no component may fade text with an alpha on
 * `muted-foreground` (the alpha variants failed in most themes).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(__dirname, '../..')
const css = fs.readFileSync(path.join(SRC, 'globals.css'), 'utf8')

type Tokens = Record<string, string>

function parseBlock(body: string): Tokens {
  const out: Tokens = {}
  for (const m of body.matchAll(/--color-([a-z-]+):\s*(hsl\([^)]*\))/g)) out[m[1]] = m[2]
  return out
}

function blockAfter(selectorRe: RegExp): string {
  const m = selectorRe.exec(css)
  if (!m) throw new Error(`selector not found: ${selectorRe}`)
  let i = css.indexOf('{', m.index) + 1
  const start = i
  let depth = 1
  while (depth > 0 && i < css.length) { const c = css[i++]; if (c === '{') depth++; else if (c === '}') depth-- }
  return css.slice(start, i - 1)
}

const base = parseBlock(blockAfter(/^@theme \{/m))
const THEMES: Record<string, Tokens> = {
  dracula: base,
  'aurora-light': { ...base, ...parseBlock(blockAfter(/^\[data-theme="aurora-light"\] \{/m)) },
  'code-rain': { ...base, ...parseBlock(blockAfter(/^\[data-theme="code-rain"\] \{/m)) },
  'obsidian-dark': { ...base, ...parseBlock(blockAfter(/^\[data-theme="obsidian-dark"\] \{/m)) },
  specrails: { ...base, ...parseBlock(blockAfter(/^\[data-theme="specrails"\] \{/m)) },
  galaxy: { ...base, ...parseBlock(blockAfter(/^\[data-theme="galaxy"\] \{/m)) },
}

function hslToRgb(token: string): [number, number, number] {
  const m = /hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)/.exec(token)
  if (!m) throw new Error(`unparseable colour: ${token}`)
  const h = Number(m[1]); const s = Number(m[2]) / 100; const l = Number(m[3]) / 100
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [f(0), f(8), f(4)]
}

function luminance(token: string): number {
  const lin = hslToRgb(token).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const TEXT = ['foreground', 'muted-foreground', 'destructive', 'accent-primary', 'accent-info', 'accent-flow',
  'accent-success', 'accent-secondary', 'accent-warning', 'accent-review', 'accent-highlight']
const SURFACES = ['background', 'card', 'surface']

describe('theme contrast', () => {
  it('parses the six themes', () => {
    expect(Object.keys(THEMES)).toHaveLength(6)
    for (const t of Object.values(THEMES)) expect(t.background).toBeTruthy()
  })

  for (const [name, tokens] of Object.entries(THEMES)) {
    it(`${name}: text tokens reach 4.5:1 on background, card and surface`, () => {
      const failures: string[] = []
      for (const fg of TEXT) for (const bg of SURFACES) {
        if (!tokens[fg] || !tokens[bg]) continue
        const ratio = contrast(tokens[fg], tokens[bg])
        if (ratio < 4.5) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)}`)
      }
      expect(failures).toEqual([])
    })

    it(`${name}: primary-foreground is readable on primary and destructive-foreground on destructive`, () => {
      expect(contrast(tokens['primary-foreground'], tokens.primary)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(tokens['destructive-foreground'], tokens.destructive)).toBeGreaterThanOrEqual(4.5)
    })

    it(`${name}: foreground and muted-foreground are readable on the muted surface`, () => {
      expect(contrast(tokens.foreground, tokens.muted)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(tokens['muted-foreground'], tokens.muted)).toBeGreaterThanOrEqual(4.5)
    })
  }
})

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) tsxFiles(full, out)
    else if (entry.name.endsWith('.tsx')) out.push(full)
  }
  return out
}

describe('muted-foreground text never fades with an alpha', () => {
  it('has no text-/placeholder:text-muted-foreground/<alpha> in any component', () => {
    const offenders: string[] = []
    for (const file of tsxFiles(SRC)) {
      const src = fs.readFileSync(file, 'utf8')
      if (/text-muted-foreground\/\d/.test(src)) offenders.push(path.relative(SRC, file))
    }
    expect(offenders).toEqual([])
  })
})
