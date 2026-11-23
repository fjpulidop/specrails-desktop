/**
 * Source guard for the status vocabulary (DESIGN.md › Status vocabulary).
 * Running work is the working look — the info LiveDot drawn by the run-state
 * primitives (components/ui/run-state) — so a new surface must not:
 *  - draw a LiveDot without an explicit tone (the default is primary) or with
 *    `tone="primary"`;
 *  - pulse a green (`success`) LiveDot — a pulsing green lamp reads as running;
 *  - pick a LiveDot tone at runtime (`tone={…}`) outside the reviewed health
 *    lamps below, which are connection / page health, not run states;
 *  - pulse a dot or a lamp colour with Tailwind `animate-pulse` (a second ping).
 * Skeleton shimmer (neutral fills) is not a state and is not matched.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(__dirname, '../..')

/** Files whose LiveDot picks its tone at runtime for a health signal (not a run state). */
const HEALTH_LAMPS = new Set([
  'components/StatusBar.tsx',
  'features/browser/components/browser-capture/BrowserCaptureModal.tsx',
  'features/browser/components/browser-capture/WebViewModal.tsx',
  'features/browser/components/browser-capture/NativeBrowserPane.tsx',
])

/** The primitives themselves (they own the tone decision). */
const PRIMITIVES = new Set([
  'components/ui/live-dot.tsx',
  'components/ui/badge.tsx',
  'components/ui/run-state/run-state-glyph.tsx',
  'components/ui/run-state/run-state-dot.tsx',
])

/** `animate-pulse` on a lamp colour that is not a state, with the reason. */
const PULSE_ALLOWED = new Map([
  ['App.tsx', 'project-switching progress bar (a loading bar, not a lamp)'],
  ['features/code/components/ai-edit/AiEditShell.tsx', 'the streaming text caret'],
  ['features/builder/components/project-builder/MilestoneGenerateShell.tsx', 'the streaming text caret'],
])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === 'locales') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) out.push(full)
  }
  return out
}

/** Every `<LiveDot …>` opening tag (skips `{…}` expressions and `=>`). */
function liveDotTags(src: string): Array<{ line: number; text: string }> {
  const tags: Array<{ line: number; text: string }> = []
  const re = /<LiveDot\b/g
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 0
    let end = -1
    for (let i = m.index; i < src.length; i++) {
      const c = src[i]
      if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth === 0 && src[i - 1] !== '=') { end = i; break }
    }
    if (end > 0) tags.push({ line: src.slice(0, m.index).split('\n').length, text: src.slice(m.index, end + 1) })
  }
  return tags
}

const files = walk(SRC).map((file) => ({ rel: path.relative(SRC, file).split(path.sep).join('/'), src: fs.readFileSync(file, 'utf8') }))

describe('status vocabulary guard', () => {
  it('draws running with the working look, never a primary, default-tone or pulsing green LiveDot', () => {
    const offenders: string[] = []
    for (const { rel, src } of files) {
      if (PRIMITIVES.has(rel)) continue
      for (const tag of liveDotTags(src)) {
        const where = `${rel}:${tag.line}`
        if (!/\btone=/.test(tag.text) && !/\bdotClassName=/.test(tag.text)) offenders.push(`${where} LiveDot without a tone (defaults to primary): use RunStateDot`)
        if (/\btone="primary"/.test(tag.text)) offenders.push(`${where} primary LiveDot: running is RunStateDot state="working"`)
        if (/\btone="success"/.test(tag.text) && !/pulsing=\{false\}/.test(tag.text)) offenders.push(`${where} pulsing green LiveDot reads as running`)
        if (/\btone=\{/.test(tag.text) && !HEALTH_LAMPS.has(rel)) offenders.push(`${where} runtime LiveDot tone: map the status to a RunState instead`)
        if (/dotClassName="[^"]*bg-accent-(primary|success)\b/.test(tag.text) && !/pulsing=\{false\}/.test(tag.text)) offenders.push(`${where} pulsing primary/success lamp`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('never pulses a dot or a lamp colour with animate-pulse', () => {
    const DOT = /\b(h-1 w-1|h-1\.5 w-1\.5|h-2 w-2|size-1|size-1\.5|size-2)\b/
    const LAMP = /\bbg-(accent-(info|primary|success|warning|review|intent)|destructive)\b/
    const offenders: string[] = []
    for (const { rel, src } of files) {
      if (PULSE_ALLOWED.has(rel)) continue
      const literals = src.match(/(['"`])(?:(?!\1)[^\\\n]|\\.)*animate-pulse(?:(?!\1)[^\\\n]|\\.)*\1/g) ?? []
      for (const literal of literals) {
        if ((/rounded-full/.test(literal) && DOT.test(literal)) || LAMP.test(literal)) offenders.push(`${rel}: ${literal}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('keeps its allowlists honest (every entry still exists)', () => {
    const present = new Set(files.map((f) => f.rel))
    for (const rel of [...HEALTH_LAMPS, ...PRIMITIVES, ...PULSE_ALLOWED.keys()]) expect(present.has(rel), rel).toBe(true)
  })
})
