// Tiny, dependency-free HTML tokenizer for syntax-highlighting the captured DOM
// in CapturedDomPanel. The captured HTML is produced by the server serializer,
// which escapes <, > and & inside both text and attribute values — so raw '<'/'>'
// only ever delimit tags, making this tokenizer reliable without a full parser.

export type HlTokenType = 'tag' | 'attr' | 'value' | 'text' | 'punct'

export interface HlToken {
  type: HlTokenType
  text: string
}

function tokenizeTag(tag: string, out: HlToken[]): void {
  // `tag` includes the surrounding angle brackets, e.g. `<div class="a">` or `</div>`.
  out.push({ type: 'punct', text: '<' })
  let j = 1
  if (tag[j] === '/') { out.push({ type: 'punct', text: '/' }); j++ }
  const name = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(tag.slice(j))
  if (name) { out.push({ type: 'tag', text: name[0] }); j += name[0].length }
  const inner = tag.slice(j, tag.length - 1) // strip trailing '>'
  // whitespace | attr-name | '=' | "quoted" | 'quoted' | '/'
  const re = /(\s+)|([a-zA-Z_:][-a-zA-Z0-9_:.]*)|(=)|("[^"]*"|'[^']*')|(\/)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(inner)) !== null) {
    if (m[1]) out.push({ type: 'text', text: m[1] })
    else if (m[2]) out.push({ type: 'attr', text: m[2] })
    else if (m[3]) out.push({ type: 'punct', text: '=' })
    else if (m[4]) out.push({ type: 'value', text: m[4] })
    else if (m[5]) out.push({ type: 'punct', text: '/' })
  }
  out.push({ type: 'punct', text: '>' })
}

export function tokenizeHtml(src: string): HlToken[] {
  const out: HlToken[] = []
  let i = 0
  while (i < src.length) {
    const lt = src.indexOf('<', i)
    if (lt === -1) {
      if (i < src.length) out.push({ type: 'text', text: src.slice(i) })
      break
    }
    if (lt > i) out.push({ type: 'text', text: src.slice(i, lt) })
    const gt = src.indexOf('>', lt)
    if (gt === -1) {
      out.push({ type: 'text', text: src.slice(lt) })
      break
    }
    tokenizeTag(src.slice(lt, gt + 1), out)
    i = gt + 1
  }
  return out
}

/** Tailwind class for each token type (semantic theme tokens only). */
export const HL_CLASS: Record<HlTokenType, string> = {
  tag: 'text-accent-info',
  attr: 'text-accent-secondary',
  value: 'text-accent-success',
  punct: 'text-muted-foreground',
  text: 'text-foreground',
}
