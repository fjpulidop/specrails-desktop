import i18n from '../../../lib/i18n'
import type { EventRow } from '../../../types'
import { hasMarkdownSyntax } from '../../../lib/markdown-detect'
import { formatUsd } from '../../analytics/lib/format'
import { parsePolicyLogLine, type PolicyDenial } from '../../../components/agent-policy/policy-denial'

/**
 * The job log's line model: event rows parsed into display lines. Kept apart
 * from the LogViewer component so the loop-step explorer model can reuse it
 * without loading markdown rendering and syntax highlighting.
 */

// ─── Types ────────────────────────────────────────────────────────────────────
// The loop-step explorer (components/loop-log/) reuses this EXACT parse
// pipeline, and LogViewer's LogLine renderer.

export type FormattedLineType =
  | 'phase'
  | 'tool-use'
  | 'tool-result'
  | 'assistant'
  | 'stderr'
  | 'result'
  | 'log'
  | 'plain'
  | 'diff-add'
  | 'diff-remove'
  | 'diff-meta'
  | 'diff-hunk'
  | 'policy'

export interface FormattedLine {
  id: string
  content: string
  type: FormattedLineType
  timestamp?: string
  /** `policy` lines: the tool call the in-turn agent policy blocked. */
  denial?: PolicyDenial
}


// ─── Event parsing ────────────────────────────────────────────────────────────

export function parseEvent(event: EventRow, idx: number): FormattedLine | null {
  const id = `${event.id ?? idx}`
  const timestamp = event.timestamp

  if (event.event_type === 'log') {
    try {
      const payload = JSON.parse(event.payload) as { line?: string }
      const line = payload.line ?? ''
      if (!line.trim()) return null

      // A tool call the in-turn agent policy blocked (server stream-display).
      const denial = parsePolicyLogLine(line)
      if (denial) return { id, content: line, type: 'policy', denial, timestamp }

      // Phase header detection
      if (line.startsWith('▸') || line.match(/^(architect|developer|reviewer|ship|analyst)\s*:/i)) {
        return { id, content: line, type: 'phase', timestamp }
      }

      if (event.source === 'stderr') {
        return { id, content: line, type: 'stderr', timestamp }
      }

      // Detect markdown content — lines from Claude's assistant output
      if (hasMarkdownSyntax(line)) {
        return { id, content: line, type: 'assistant', timestamp }
      }

      return { id, content: line, type: 'plain', timestamp }
    } catch {
      return null
    }
  }

  // assistant, tool_use, tool_result, user, system — their display text is
  // already persisted as separate 'log' events by the server, so skip the
  // raw structured events to avoid duplicates.
  if (event.event_type !== 'log' && event.event_type !== 'result') {
    return null
  }

  if (event.event_type === 'result') {
    try {
      const result = JSON.parse(event.payload) as {
        total_cost_usd?: number
        num_turns?: number
        duration_ms?: number
      }
      const parts: string[] = []
      if (result.duration_ms) parts.push(`${(result.duration_ms / 1000).toFixed(1)}s`)
      if (result.total_cost_usd) parts.push(formatUsd(result.total_cost_usd))
      if (result.num_turns) parts.push(i18n.t('jobs:logViewer.turns', { count: result.num_turns }))
      return {
        id,
        content: `▸ ${i18n.t('jobs:logViewer.completed')}${parts.length ? ` — ${parts.join(' · ')}` : ''}`,
        type: 'result',
        timestamp,
      }
    } catch {
      return null
    }
  }

  return null
}

// ─── Diff detection ───────────────────────────────────────────────────────────
// Detects unified-diff lines (--- a/… +++ b/… @@ … +line -line)
// Only marks lines as diff types after seeing a proper diff header sequence.

export function applyDiffDetection(lines: FormattedLine[]): FormattedLine[] {
  type DiffState = 'none' | 'saw_minus' | 'active'
  let diffState: DiffState = 'none'
  const out: FormattedLine[] = []

  for (const line of lines) {
    const t = line.type
    // Only scan plain/log lines for diff markers; phase/result/stderr etc. reset state
    if (t !== 'plain' && t !== 'log') {
      diffState = 'none'
      out.push(line)
      continue
    }
    const c = line.content
    if (c.startsWith('--- ')) {
      diffState = 'saw_minus'
      out.push({ ...line, type: 'diff-meta' })
    } else if (diffState === 'saw_minus' && c.startsWith('+++ ')) {
      diffState = 'active'
      out.push({ ...line, type: 'diff-meta' })
    } else if (diffState === 'active' && c.startsWith('@@ ')) {
      out.push({ ...line, type: 'diff-hunk' })
    } else if (diffState === 'active' && c.startsWith('+') && !c.startsWith('+++')) {
      out.push({ ...line, type: 'diff-add' })
    } else if (diffState === 'active' && c.startsWith('-') && !c.startsWith('---')) {
      out.push({ ...line, type: 'diff-remove' })
    } else if (diffState === 'active' && (c.startsWith(' ') || c === '')) {
      // unchanged line — keep plain but stay in diff mode
      out.push(line)
    } else {
      diffState = 'none'
      out.push(line)
    }
  }
  return out
}

// ─── Assistant-line merge ─────────────────────────────────────────────────────
// Consecutive assistant (markdown) lines merge into one block so a streamed
// paragraph renders as a single markdown unit. Extracted (behavior-identical)
// so the loop-step explorer can run it per step segment.

export function mergeAssistantLines(rawLines: FormattedLine[]): FormattedLine[] {
  const merged: FormattedLine[] = []
  for (const line of rawLines) {
    const prev = merged.length > 0 ? merged[merged.length - 1] : null
    if (line.type === 'assistant' && prev?.type === 'assistant') {
      prev.content += '\n' + line.content
    } else {
      merged.push({ ...line })
    }
  }
  return merged
}
