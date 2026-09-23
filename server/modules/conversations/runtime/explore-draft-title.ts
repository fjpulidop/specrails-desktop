/**
 * Auto-title generation for Explore drafts.
 *
 * Strategy: deterministic single-line summary derived from the first
 * user-submitted message in the conversation. Future enhancement: replace
 * `generateAutoTitle` with an LLM-backed implementation that calls Claude
 * with a short prompt and falls back to the deterministic path on failure.
 */

const MAX_TITLE_LEN = 80
const FALLBACK_TITLE = 'Untitled draft'

export interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Produce a non-empty, single-line, human-meaningful title from a
 * conversation transcript. Always returns a non-empty string.
 */
export function generateAutoTitle(messages: ConversationMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user' && m.content.trim().length > 0)
  if (!firstUser) return FALLBACK_TITLE
  return summarizeToSingleLine(firstUser.content)
}

function summarizeToSingleLine(text: string): string {
  // Strip code fences and inline backticks — drafts are about ideas, not code
  const stripped = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!stripped) return FALLBACK_TITLE

  // Prefer the first sentence if it's short enough
  const sentenceMatch = stripped.match(/^.{1,80}?[.!?](\s|$)/)
  if (sentenceMatch) {
    const sentence = sentenceMatch[0].trim().replace(/[.!?]+$/, '')
    if (sentence.length > 0) return sentence
  }

  if (stripped.length <= MAX_TITLE_LEN) return stripped
  // Word-aware truncation
  const head = stripped.slice(0, MAX_TITLE_LEN)
  const lastSpace = head.lastIndexOf(' ')
  const truncated = lastSpace > 20 ? head.slice(0, lastSpace) : head
  return truncated.trim() + '…'
}
