/**
 * Source guard for keyboard and screen-reader reach (BB4 focus-visible audit).
 * The client has no lint step, so these checks run with the test suite:
 *  - an interactive element (button, link, select, summary, tabIndex={0}, role
 *    button/menuitem/tab/...) that removes the browser outline (`outline-none`) must
 *    bring its own focus style back (`focus-visible:*`, `focus:ring`, `group-focus-visible`,
 *    `focus-within` ...). The global base ring in globals.css covers every other one;
 *  - evidence that lives in a `title={t(...)}` on a non-focusable span/Badge must also be in
 *    the DOM as text a screen reader reaches (an `sr-only` child). A tooltip alone is
 *    invisible to keyboard, touch and screen-reader users (reaudit-4 R1).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(__dirname, '../..')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === 'demo-mode' || entry.name === 'locales') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) out.push(full)
  }
  return out
}

/** End index of the JSX opening tag starting at `start` (skips `{...}` expressions and `=>`). */
function tagEnd(src: string, start: number): number {
  let depth = 0
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '>' && depth === 0 && src[i - 1] !== '=') return i
  }
  return -1
}

interface Tag { file: string; line: number; text: string; start: number; end: number }

function openingTags(file: string, src: string, names: RegExp): Tag[] {
  const tags: Tag[] = []
  const re = new RegExp(`<(${names.source})\\b`, 'g')
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const end = tagEnd(src, m.index)
    if (end < 0) continue
    tags.push({ file: path.relative(SRC, file), line: src.slice(0, m.index).split('\n').length, text: src.slice(m.index, end + 1), start: m.index, end })
  }
  return tags
}

/** Source between an opening tag and its matching close, counting nested tags of the same name. */
function elementInner(src: string, tag: Tag, name: string): string {
  const re = new RegExp(`<(/?)${name}\\b`, 'g')
  re.lastIndex = tag.end + 1
  let depth = 1
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m[1] === '/') depth--
    else {
      const end = tagEnd(src, m.index)
      if (end >= 0 && src[end - 1] !== '/') depth++
    }
    if (depth === 0) return src.slice(tag.end + 1, m.index)
  }
  return ''
}

const files = walk(SRC)

describe('a11y source guard', () => {
  it('no interactive element removes its outline without a replacement focus style', () => {
    const offenders: string[] = []
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8')
      if (!/outline-none|outline-hidden/.test(src)) continue
      for (const tag of openingTags(f, src, /button|a|select|summary|div|span|li/)) {
        const t = tag.text
        if (!/outline-none|outline-hidden/.test(t)) continue
        const interactive = /^<(button|a|select|summary)\b/.test(t)
          || /tabIndex=\{0\}/.test(t)
          || /role="(button|link|menuitem|tab|switch|checkbox|radio|option|treeitem)"/.test(t)
        if (!interactive) continue
        // Separators with a hairline that lights up on focus carry their own indicator.
        if (/focus-visible:|focus:(ring|border|bg|shadow|outline)|group-focus-visible|focus-within|has-\[:focus|data-\[focus/.test(t)) continue
        offenders.push(`${tag.file}:${tag.line}`)
      }
    }
    // SidebarResizeGrip lights its hairline through `group-focus-visible` on a child.
    expect(offenders.filter((o) => !o.startsWith(`components${path.sep}SidebarResizeGrip.tsx`))).toEqual([])
  })

  it('a title-only hint on a non-focusable span also reaches screen readers', () => {
    const offenders: string[] = []
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8')
      if (!/title=\{/.test(src)) continue
      for (const tag of openingTags(f, src, /span|Badge/)) {
        const t = tag.text
        if (t.endsWith('/>') || !/\btitle=\{[^}]*\bt\(/.test(t)) continue
        if (/tabIndex|aria-label|role=|onClick|aria-describedby|aria-labelledby|aria-hidden/.test(t)) continue
        const name = /^<(\w+)/.exec(t)![1]
        const inner = elementInner(src, tag, name)
        // A visible label that is the hint itself (truncated text) needs nothing more.
        const title = /\btitle=\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/.exec(t)?.[1]?.trim()
        if (title && inner.includes(title)) continue
        if (!inner.includes('sr-only')) offenders.push(`${tag.file}:${tag.line}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
