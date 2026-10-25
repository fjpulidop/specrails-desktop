/**
 * Resolve a relative markdown link (as written inside an in-app guide page) to
 * the { category, slug } it targets, so a click can navigate WITHIN the docs
 * surface instead of letting the browser/router follow a bare relative href
 * (which resolves off-route — closing the docs modal / bouncing to the
 * dashboard). Guide links omit the `<order>-` prefix and the `.md` extension:
 *
 *   - `the-loop-builder`            → same category, that slug
 *   - `../integrations/using-codex` → category `integrations`, slug `using-codex`
 *
 * Returns null for external (`scheme:`) and pure-anchor (`#…`) hrefs.
 */
export function resolveDocHref(
  href: string,
  currentCategory: string
): { category: string; slug: string } | null {
  if (!href || href.startsWith('#')) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null // has a scheme → external
  const clean = href.split('#')[0].split('?')[0].replace(/\.md$/, '')
  if (!clean) return null
  const stack: string[] = []
  for (const part of clean.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') stack.pop()
    else stack.push(part)
  }
  if (stack.length === 0) return null
  if (stack.length === 1) return { category: currentCategory, slug: stack[0] }
  return { category: stack[stack.length - 2], slug: stack[stack.length - 1] }
}

const HEADING_ANCHOR = /\s*\{#([a-z0-9][a-z0-9-]*)\}\s*$/i

/** Prefix of every heading id the guide renders (keeps them clear of app ids). */
export const DOC_ANCHOR_PREFIX = 'doc-'

/**
 * Split an explicit heading anchor off a heading's text: `Daily budgets {#daily-budget}`
 * is the visible title "Daily budgets" and the anchor `daily-budget`. The same
 * syntax is what the server strips from page titles and reports in search.
 */
export function parseHeadingAnchor(text: string): { text: string; anchor: string | null } {
  const match = HEADING_ANCHOR.exec(text)
  if (!match) return { text, anchor: null }
  return { text: text.slice(0, match.index), anchor: match[1].toLowerCase() }
}

/** The element a docs target points at inside a rendered page, or null. */
export function findDocAnchor(
  container: ParentNode,
  target: { anchor?: string | null; heading?: string | null },
): HTMLElement | null {
  if (target.anchor) {
    const byAnchor = container.querySelector<HTMLElement>(`[id="${DOC_ANCHOR_PREFIX}${target.anchor.replace(/"/g, '')}"]`)
    if (byAnchor) return byAnchor
  }
  if (target.heading) {
    const wanted = target.heading.trim()
    for (const heading of Array.from(container.querySelectorAll<HTMLElement>('h1, h2, h3, h4'))) {
      if (heading.textContent?.trim() === wanted) return heading
    }
  }
  return null
}
