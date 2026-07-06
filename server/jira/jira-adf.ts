// Atlassian Document Format (ADF) helpers.
//
// Jira Cloud (REST v3) requires comment/description bodies in ADF JSON. Jira
// Server/Data Center (REST v2) expects a plain wiki-markup string. We keep a
// single internal "text" model and render it to either format at the client
// boundary (see jira-client.ts `bodyForDeployment`).

import type { JiraDeployment } from './types'

type AdfMark = { type: string; attrs?: Record<string, unknown> }

type AdfInline = {
  type: 'text'
  text: string
  marks?: AdfMark[]
} | { type: 'hardBreak' }

type AdfBlock = Record<string, unknown>

function textNode(text: string, marks?: AdfMark[]): AdfInline[] {
  if (!text) return []
  return marks && Array.isArray(marks) && marks.length > 0
    ? [{ type: 'text', text, marks }]
    : [{ type: 'text', text }]
}

function parseInline(input: string): AdfInline[] {
  const out: AdfInline[] = []
  let i = 0
  const pushPlainUntil = (next: number) => {
    if (next > i) out.push(...textNode(input.slice(i, next)))
    i = next
  }
  while (i < input.length) {
    const starts = [
      input.indexOf('`', i),
      input.indexOf('**', i),
      input.indexOf('*', i),
      input.indexOf('[', i),
    ].filter((n) => n >= 0)
    const next = starts.length > 0 ? Math.min(...starts) : -1
    if (next < 0) {
      out.push(...textNode(input.slice(i)))
      break
    }
    pushPlainUntil(next)
    if (input.startsWith('`', i)) {
      const end = input.indexOf('`', i + 1)
      if (end > i + 1) {
        out.push(...textNode(input.slice(i + 1, end), [{ type: 'code' }]))
        i = end + 1
        continue
      }
    }
    if (input.startsWith('**', i)) {
      const end = input.indexOf('**', i + 2)
      if (end > i + 2) {
        out.push(...textNode(input.slice(i + 2, end), [{ type: 'strong' }]))
        i = end + 2
        continue
      }
    }
    if (input.startsWith('[', i)) {
      const close = input.indexOf('](', i + 1)
      const end = close >= 0 ? input.indexOf(')', close + 2) : -1
      if (close > i + 1 && end > close + 2) {
        const label = input.slice(i + 1, close)
        const href = input.slice(close + 2, end)
        out.push(...textNode(label, [{ type: 'link', attrs: { href } }]))
        i = end + 1
        continue
      }
    }
    if (input.startsWith('*', i) && !input.startsWith('**', i)) {
      const end = input.indexOf('*', i + 1)
      if (end > i + 1) {
        out.push(...textNode(input.slice(i + 1, end), [{ type: 'em' }]))
        i = end + 1
        continue
      }
    }
    out.push(...textNode(input[i]))
    i += 1
  }
  return out
}

function paragraphFromLines(lines: string[]): AdfBlock {
  if (lines.length === 0 || lines.every((line) => line.length === 0)) return { type: 'paragraph' }
  const content: AdfInline[] = []
  lines.forEach((line, index) => {
    if (index > 0) content.push({ type: 'hardBreak' })
    content.push(...parseInline(line))
  })
  return content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' }
}

function isSpecialMarkdownLine(line: string): boolean {
  return /^```/.test(line) ||
    /^(#{1,6})\s+\S/.test(line) ||
    /^\s*[-*+]\s+\S/.test(line) ||
    /^\s*\d+[.)]\s+\S/.test(line) ||
    /^>\s?/.test(line) ||
    /^\s*---+\s*$/.test(line)
}

function listItem(text: string): AdfBlock {
  return { type: 'listItem', content: [paragraphFromLines([text])] }
}

/** Build an ADF document from Specrails Markdown. */
export function textToAdf(text: string): unknown {
  const lines = text.split('\n')
  const content: AdfBlock[] = []
  let i = 0
  const pushParagraph = (paragraphLines: string[]) => {
    content.push(paragraphFromLines(paragraphLines))
  }
  while (i < lines.length) {
    const line = lines[i]
    if (line.length === 0) {
      content.push({ type: 'paragraph' })
      i += 1
      continue
    }

    const fence = /^```([A-Za-z0-9_-]+)?\s*$/.exec(line)
    if (fence) {
      const codeLines: string[] = []
      i += 1
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i])
        i += 1
      }
      if (i < lines.length) i += 1
      content.push({
        type: 'codeBlock',
        ...(fence[1] ? { attrs: { language: fence[1] } } : {}),
        content: codeLines.length > 0 ? [{ type: 'text', text: codeLines.join('\n') }] : [],
      })
      continue
    }

    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (heading) {
      content.push({
        type: 'heading',
        attrs: { level: heading[1].length },
        content: parseInline(heading[2]),
      })
      i += 1
      continue
    }

    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line)
    if (bullet) {
      const items: AdfBlock[] = []
      while (i < lines.length) {
        const m = /^\s*[-*+]\s+(.+)$/.exec(lines[i])
        if (!m) break
        items.push(listItem(m[1]))
        i += 1
      }
      content.push({ type: 'bulletList', content: items })
      continue
    }

    const ordered = /^\s*(\d+)[.)]\s+(.+)$/.exec(line)
    if (ordered) {
      const items: AdfBlock[] = []
      const order = parseInt(ordered[1], 10)
      while (i < lines.length) {
        const m = /^\s*\d+[.)]\s+(.+)$/.exec(lines[i])
        if (!m) break
        items.push(listItem(m[1]))
        i += 1
      }
      content.push({ type: 'orderedList', attrs: { order }, content: items })
      continue
    }

    const quote = /^>\s?(.*)$/.exec(line)
    if (quote) {
      const quoteLines: string[] = []
      while (i < lines.length) {
        const m = /^>\s?(.*)$/.exec(lines[i])
        if (!m) break
        quoteLines.push(m[1])
        i += 1
      }
      content.push({ type: 'blockquote', content: [paragraphFromLines(quoteLines)] })
      continue
    }

    if (/^\s*---+\s*$/.test(line)) {
      content.push({ type: 'rule' })
      i += 1
      continue
    }

    const paragraphLines = [line]
    i += 1
    while (i < lines.length && lines[i].length > 0 && !isSpecialMarkdownLine(lines[i])) {
      paragraphLines.push(lines[i])
      i += 1
    }
    pushParagraph(paragraphLines)
  }
  return {
    type: 'doc',
    version: 1,
    content: content.length > 0 ? content : [{ type: 'paragraph' }],
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
  if (adfToText(body).includes(marker)) return true
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

export function adfToText(body: unknown): string {
  if (body == null) return ''
  if (typeof body === 'string') return body

  const inlineText = (nodes: unknown): string => {
    if (!Array.isArray(nodes)) return ''
    return nodes.map((node) => {
      if (!node || typeof node !== 'object') return ''
      const n = node as { type?: unknown; text?: unknown; marks?: unknown; attrs?: Record<string, unknown> }
      if (n.type === 'hardBreak') return '\n'
      if (n.type === 'mention' && typeof n.attrs?.text === 'string') return n.attrs.text
      if (n.type !== 'text' || typeof n.text !== 'string') return ''
      let text = n.text
      const marks = Array.isArray(n.marks) ? n.marks as Array<{ type?: unknown; attrs?: Record<string, unknown> }> : []
      for (const mark of marks) {
        if (mark.type === 'code') text = `\`${text}\``
        else if (mark.type === 'strong') text = `**${text}**`
        else if (mark.type === 'em') text = `*${text}*`
        else if (mark.type === 'strike') text = `~~${text}~~`
      }
      const link = marks.find((mark) => mark.type === 'link' && typeof mark.attrs?.href === 'string')
      if (link?.attrs?.href) text = `[${text}](${link.attrs.href})`
      return text
    }).join('')
  }

  const renderBlocks = (nodes: unknown): string[] => {
    if (!Array.isArray(nodes)) return []
    const blocks: string[] = []
    const renderListItem = (node: any, prefix: string): string => {
      const rendered = renderBlocks(node?.content)
      const body = rendered.length > 0 ? rendered.join('\n\n') : ''
      const lines = body.split('\n')
      return lines.map((line, index) => index === 0 ? `${prefix}${line}` : `  ${line}`).join('\n')
    }
    for (const raw of nodes) {
      if (!raw || typeof raw !== 'object') continue
      const node = raw as { type?: string; content?: unknown; attrs?: Record<string, unknown> }
      if (node.type === 'paragraph') {
        blocks.push(inlineText(node.content))
      } else if (node.type === 'heading') {
        const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 2))
        blocks.push(`${'#'.repeat(level)} ${inlineText(node.content)}`.trim())
      } else if (node.type === 'bulletList') {
        const items = Array.isArray(node.content) ? node.content.map((item) => renderListItem(item, '- ')) : []
        blocks.push(items.join('\n'))
      } else if (node.type === 'orderedList') {
        const start = Number(node.attrs?.order) || 1
        const items = Array.isArray(node.content)
          ? node.content.map((item, index) => renderListItem(item, `${start + index}. `))
          : []
        blocks.push(items.join('\n'))
      } else if (node.type === 'listItem') {
        blocks.push(...renderBlocks(node.content))
      } else if (node.type === 'codeBlock') {
        const lang = typeof node.attrs?.language === 'string' ? node.attrs.language : ''
        blocks.push(`\`\`\`${lang}\n${inlineText(node.content)}\n\`\`\``)
      } else if (node.type === 'blockquote') {
        const quote = renderBlocks(node.content).join('\n\n')
        blocks.push(quote.split('\n').map((line) => line ? `> ${line}` : '>').join('\n'))
      } else if (node.type === 'rule') {
        blocks.push('---')
      } else if (node.type === 'panel') {
        blocks.push(renderBlocks(node.content).join('\n\n'))
      } else if (node.type === 'table') {
        blocks.push(renderBlocks(node.content).join('\n\n'))
      } else if (node.type === 'tableRow') {
        blocks.push(renderBlocks(node.content).join('\n'))
      } else if (node.type === 'tableCell' || node.type === 'tableHeader') {
        blocks.push(renderBlocks(node.content).join(' '))
      } else {
        blocks.push(...renderBlocks(node.content))
      }
    }
    return blocks
  }

  const root = body as { content?: unknown }
  return renderBlocks(root.content).join('\n\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}
