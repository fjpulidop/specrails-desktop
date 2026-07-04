/**
 * Log ticket-ref linkifier — `#N` refs inside job LOG lines become clickable,
 * opening the board's TicketDetailModal (mission JobDetailModal + board
 * JobDetailPage share the same `LogLine`, so both surfaces get it).
 *
 * Two deliberate differences from the agent-chat linkifier (`lib/agent-refs`):
 *  - TICKET-ONLY: `splitAgentRefs` is fed an EMPTY job-context uuid set, so
 *    job/loop-run uuids never linkify in logs — no modal-in-modal noise when
 *    the log is already shown inside the mission JobDetailModal.
 *  - QUIETER affordance: logs are dense monospace surfaces, so a ref renders
 *    as an underline-dotted `accent-primary` span that inherits the line's
 *    font — not the pill `AgentRefChip`.
 *
 * Exclusions mirror agent-refs' philosophy: markdown code (block + inline),
 * existing links/images/html via the remark walk; diff-styled and stderr lines
 * are excluded at the `LogLine` call site (stack frames read `#1 0x…`).
 */
import { Fragment, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { agentRefHref, splitAgentRefs, type AgentRefSegment } from '../lib/agent-refs'

/** Empty job-context set ⇒ `splitAgentRefs` can only ever yield ticket refs. */
export const NO_JOB_UUIDS: ReadonlySet<string> = new Set()

// ── Quiet inline affordance ───────────────────────────────────────────────────

interface LogTicketRefProps {
  ticketId: number
  /** Opens the ticket against the surface's project (caller binds the scope). */
  onOpen: (ticketId: number) => void
  /** Ref text (`#3` / `#3 — Add dark mode`). */
  children?: ReactNode
}

/**
 * The clickable ticket ref inside a log line. Reuses the shared `agent:refs.*`
 * keys (same cross-ns precedent as `ArcSidebar`) so the label/toast copy stays
 * identical to the agent-chat chips in all 8 locales.
 */
export function LogTicketRef({ ticketId, onOpen, children }: LogTicketRefProps) {
  const { t } = useTranslation('agent')
  const label = t('refs.openTicket', { id: ticketId })
  return (
    <button
      type="button"
      data-testid="log-ticket-ref"
      onClick={(e) => {
        e.stopPropagation()
        onOpen(ticketId)
      }}
      title={label}
      aria-label={label}
      className="inline cursor-pointer p-0 align-baseline text-accent-primary/90 underline decoration-accent-primary/50 decoration-dotted underline-offset-2 transition-colors hover:text-accent-primary hover:decoration-solid"
    >
      {children}
    </button>
  )
}

// ── Plain-line splitting ──────────────────────────────────────────────────────

/**
 * Ticket-only segmentation of one plain log line. Returns `null` when the line
 * carries no ref (fast `#` pre-check — the common case on 8k-line logs) so the
 * caller renders the raw string unchanged.
 */
export function splitLogTicketSegments(content: string): AgentRefSegment[] | null {
  if (!content.includes('#')) return null
  const segments = splitAgentRefs(content, NO_JOB_UUIDS)
  return segments.some((s) => s.kind === 'ticket') ? segments : null
}

/** Renders one plain log line with its ticket refs linkified (or as-is). */
export function renderLogLineWithTicketRefs(
  content: string,
  onOpen: (ticketId: number) => void,
): ReactNode {
  const segments = splitLogTicketSegments(content)
  if (!segments) return content
  return segments.map((segment, i) =>
    segment.kind === 'ticket' ? (
      <LogTicketRef key={i} ticketId={segment.ticketId} onOpen={onOpen}>
        {segment.label}
      </LogTicketRef>
    ) : (
      <Fragment key={i}>{segment.kind === 'text' ? segment.text : null}</Fragment>
    ),
  )
}

// ── remark plugin (assistant/markdown log lines) ──────────────────────────────

/** Minimal structural mdast node — avoids a hard dep on @types/mdast. */
interface MdNode {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
  [key: string]: unknown
}

/** Same skip set as `remarkAgentRefs`: code, existing links/images, raw html. */
const SKIP_SUBTREES = new Set([
  'code',
  'inlineCode',
  'link',
  'linkReference',
  'image',
  'imageReference',
  'definition',
  'html',
])

function ticketSegmentToNode(segment: AgentRefSegment): MdNode {
  if (segment.kind === 'ticket') {
    return {
      type: 'link',
      url: agentRefHref({ kind: 'ticket', ticketId: segment.ticketId }),
      children: [{ type: 'text', value: segment.label }],
    }
  }
  return { type: 'text', value: segment.kind === 'text' ? segment.text : '' }
}

function walkTicketRefs(node: MdNode): void {
  const children = node.children
  if (!children) return
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i]
    if (SKIP_SUBTREES.has(child.type)) continue
    if (child.type === 'text' && typeof child.value === 'string') {
      const segments = splitAgentRefs(child.value, NO_JOB_UUIDS)
      if (segments.some((s) => s.kind === 'ticket')) {
        children.splice(i, 1, ...segments.map(ticketSegmentToNode))
      }
    } else {
      walkTicketRefs(child)
    }
  }
}

/**
 * remark plugin: replaces `#N` refs in text nodes with `#agentref:ticket:` link
 * nodes (the fragment codec from `lib/agent-refs` — survives react-markdown's
 * URL sanitizer). Ticket-only counterpart of `remarkAgentRefs` for log lines.
 */
export function remarkLogTicketRefs() {
  return (tree: MdNode) => walkTicketRefs(tree)
}
