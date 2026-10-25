/**
 * Human model names for the UI. Providers report slugs (`sonnet`, `claude-opus-4-5-20251101`,
 * `gpt-6.1-sol`); people read "Claude Sonnet", "Claude Opus 4.5", "GPT-6.1 Sol".
 * Unknown slugs return `known: false` so the caller can show them verbatim in monospace.
 */
export interface ModelLabel {
  text: string
  /** True when `text` is a mapped, human name; false when it is the raw slug. */
  known: boolean
}

const FAMILY: Record<string, string> = { opus: 'Claude Opus', sonnet: 'Claude Sonnet', haiku: 'Claude Haiku' }

const titleCase = (word: string) => word.charAt(0).toUpperCase() + word.slice(1)

/** "4-5" / "4-5-20251101" → "4.5"; "4" → "4". Trailing 8-digit date stamps are dropped. */
function claudeVersion(rest: string): string {
  const parts = rest.split('-').filter((p) => p && !/^\d{8}$/.test(p))
  return parts.filter((p) => /^\d+$/.test(p)).join('.')
}

export function modelLabel(slug: string | null | undefined): ModelLabel {
  const raw = (slug ?? '').trim()
  if (!raw) return { text: '', known: false }
  const id = raw.toLowerCase().replace(/\[[^\]]*\]$/, '')

  // Bare family aliases: sonnet, opus, haiku.
  if (FAMILY[id]) return { text: FAMILY[id], known: true }

  // claude-sonnet-4-5-20250929 · claude-3-5-haiku-latest · claude-opus-4
  let m = /^claude-(opus|sonnet|haiku)(?:-(.+))?$/.exec(id)
  if (m) {
    const version = m[2] ? claudeVersion(m[2].replace(/-latest$/, '')) : ''
    return { text: `${FAMILY[m[1]]}${version ? ` ${version}` : ''}`, known: true }
  }
  m = /^claude-(\d+(?:-\d+)?)-(opus|sonnet|haiku)(?:-.+)?$/.exec(id)
  if (m) return { text: `${FAMILY[m[2]]} ${m[1].replace('-', '.')}`, known: true }

  // gpt-6.1-sol → GPT-6.1 Sol · gpt-5-codex → GPT-5 Codex · gpt-4o-mini → GPT-4o Mini
  m = /^gpt-?(\d[\w.]*)((?:-[a-z][\w.]*)*)$/.exec(id)
  if (m) {
    const tail = m[2].split('-').filter(Boolean).map(titleCase).join(' ')
    return { text: `GPT-${m[1]}${tail ? ` ${tail}` : ''}`, known: true }
  }

  // gemini-2.5-pro → Gemini 2.5 Pro
  m = /^gemini-(\d[\w.]*)((?:-[a-z][\w.]*)*)$/.exec(id)
  if (m) {
    const tail = m[2].split('-').filter(Boolean).map(titleCase).join(' ')
    return { text: `Gemini ${m[1]}${tail ? ` ${tail}` : ''}`, known: true }
  }

  return { text: raw, known: false }
}
