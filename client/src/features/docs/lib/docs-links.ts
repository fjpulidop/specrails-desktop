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
