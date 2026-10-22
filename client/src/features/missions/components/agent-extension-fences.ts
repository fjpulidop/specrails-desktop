// ─── Extension fence extraction ───────────────────────────────────────────────
// Strips fenced blocks whose tag is registered by a mission extension (see
// MissionExtensionsContext) and returns their parsed JSON bodies in order.
// Same tolerance as the sibling protocol extractors: a complete block is always
// stripped (an invalid body yields payload null); while streaming an unclosed
// block is cut so raw JSON never flashes in the bubble; a settled unclosed
// block whose tail is valid JSON is accepted.

export interface ExtensionFenceBlock {
  tag: string
  /** 0-based order among blocks with the same tag. */
  index: number
  payload: unknown
}

export interface ParsedExtensionFences {
  body: string
  blocks: ExtensionFenceBlock[]
  /** Tags whose block is still streaming in. */
  pending: string[]
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parse(raw: string): unknown {
  try { return JSON.parse(raw) } catch { return null }
}

export function extractExtensionFences(content: string, tags: readonly string[], streaming = false): ParsedExtensionFences {
  const wanted = tags.filter((tag) => /^[a-z][a-z0-9-]*$/.test(tag) && content.includes('```' + tag))
  if (wanted.length === 0) return { body: content, blocks: [], pending: [] }
  const alternation = wanted.map(escapeRe).join('|')
  const fence = new RegExp('```(' + alternation + ')[^\\S\\n]*\\n([\\s\\S]*?)\\n[^\\S\\n]*```', 'g')
  const blocks: ExtensionFenceBlock[] = []
  const counts = new Map<string, number>()
  const push = (tag: string, payload: unknown) => {
    const index = counts.get(tag) ?? 0
    counts.set(tag, index + 1)
    blocks.push({ tag, index, payload })
  }
  let body = content.replace(fence, (_whole, tag: string, raw: string) => {
    push(tag, parse(raw))
    return ''
  })
  const pending: string[] = []
  const open = new RegExp('```(' + alternation + ')(?![a-z0-9-])').exec(body)
  if (open) {
    const tag = open[1]
    const tail = body.slice(open.index + open[0].length).replace(/^[^\S\n]*\n?/, '').replace(/\s*(?:```)?\s*$/, '')
    const payload = parse(tail)
    if (payload !== null && !streaming) {
      push(tag, payload)
      body = body.slice(0, open.index)
    } else if (streaming) {
      body = body.slice(0, open.index)
      pending.push(tag)
    }
  }
  return { body: body.replace(/\n{3,}/g, '\n\n').trim(), blocks, pending }
}
