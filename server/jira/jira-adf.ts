// Atlassian Document Format (ADF) helpers.
//
// Jira Cloud (REST v3) requires comment/description bodies in ADF JSON. Jira
// Server/Data Center (REST v2) expects a plain wiki-markup string. We keep a
// single internal "text" model and render it to either format at the client
// boundary (see jira-client.ts `bodyForDeployment`).

import type { JiraDeployment } from './types'

/** Build a minimal ADF document from plain text (newlines → paragraphs). */
export function textToAdf(text: string): unknown {
  const paragraphs = text.split('\n')
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.map((line) =>
      line.length === 0
        ? { type: 'paragraph' }
        : { type: 'paragraph', content: [{ type: 'text', text: line }] }
    ),
  }
}

/** Render a body for the target deployment: ADF for Cloud v3, plain for DC v2. */
export function bodyForDeployment(text: string, deployment: JiraDeployment): unknown {
  return deployment === 'cloud' ? textToAdf(text) : text
}

/**
 * Jira comment-property key under which we store the idempotency marker. Comment
 * properties are metadata that NEVER render in the comment body, so the marker
 * stays invisible to users while still letting us dedup on retry. Supported on
 * both Cloud (v3) and Data Center (v2).
 */
export const SPECRAILS_COMMENT_PROP_KEY = 'sh.specrails.marker'

/**
 * Deterministic idempotency marker. Jira has no native comment idempotency, so
 * before re-posting on retry we GET the issue comments and skip if one already
 * carries this marker (now via an invisible comment property — see
 * SPECRAILS_COMMENT_PROP_KEY — with a legacy body-scan fallback).
 */
export function commentMarker(jobId: string, ticketId: number): string {
  return `[specrails:job=${jobId}:ticket=${ticketId}]`
}

/**
 * Idempotency marker for a user-initiated "discard / move-to" comment. The
 * `nonce` (captured at enqueue) makes each discard distinct so a later re-discard
 * of the same spec posts a fresh comment instead of being deduped away.
 */
export function discardCommentMarker(ticketId: number, nonce: string): string {
  return `[specrails:discard=${nonce}:ticket=${ticketId}]`
}

/**
 * Idempotency marker for the "PR merged" comment posted when a delivery PR is
 * observed merged. Deterministic per (delivery, ticket) so a retry/re-poll
 * never double-posts.
 */
export function prMergedCommentMarker(refId: string, ticketId: number): string {
  return `[specrails:pr-merged=${refId}:ticket=${ticketId}]`
}

/**
 * Idempotency marker for the "ready for review" comment posted when an isolated
 * rail parks a Jira-linked ticket on_review awaiting the PR decision.
 */
export function railReviewCommentMarker(refId: string, ticketId: number): string {
  return `[specrails:rail-review=${refId}:ticket=${ticketId}]`
}

/** True when an ADF doc or wiki string already contains the given marker. */
export function bodyContainsMarker(body: unknown, marker: string): boolean {
  if (typeof body === 'string') return body.includes(marker)
  try {
    return JSON.stringify(body).includes(marker)
  } catch {
    return false
  }
}

/**
 * True when a fetched comment already carries the marker — preferring the
 * invisible comment property, with a fallback to a legacy body-embedded marker
 * (comments posted before the property move). `comment.properties` comes from
 * `GET …/comment?expand=properties`.
 */
export function commentHasMarker(
  comment: { body?: unknown; properties?: Array<{ key: string; value?: unknown }> },
  marker: string
): boolean {
  const prop = comment.properties?.find((p) => p.key === SPECRAILS_COMMENT_PROP_KEY)
  if (prop) {
    try {
      if (JSON.stringify(prop.value ?? '').includes(marker)) return true
    } catch {
      /* fall through to body scan */
    }
  }
  return bodyContainsMarker(comment.body, marker)
}

/**
 * Flatten an ADF document (or plain string) back to text — used to read inbound
 * Jira descriptions/comments into the local cache.
 */
const BLOCK_SEPARATOR_TYPES = new Set<string>([
  'paragraph',
  'heading',
  'codeBlock',
  'blockquote',
  'panel',
  'tableRow',
])

export function adfToText(body: unknown): string {
  if (body == null) return ''
  if (typeof body === 'string') return body
  const out: string[] = []
  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'text' && typeof node.text === 'string') out.push(node.text)
    if (node.type === 'hardBreak') out.push('\n')
    if (Array.isArray(node.content)) {
      for (const child of node.content) walk(child)
      // Block separators. `paragraph`/`heading` carry inline children directly;
      // `codeBlock` holds direct text children (no inner paragraph), and
      // `blockquote`/`panel`/`tableRow` are containers whose trailing newline
      // would otherwise be dropped, running their text onto the next block.
      if (BLOCK_SEPARATOR_TYPES.has(node.type)) out.push('\n')
    }
  }
  walk(body)
  return out.join('').replace(/\n{3,}/g, '\n\n').trim()
}
