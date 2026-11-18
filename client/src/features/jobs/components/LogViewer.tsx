import { useEffect, useRef, useState, useCallback, useMemo, memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { Search, ChevronDown, ChevronRight, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { Input } from '../../../components/ui/input'
import { Button } from '../../../components/ui/button'
import { cn } from '../../../lib/utils'
import type { EventRow } from '../../../types'
import type { ReactNode } from 'react'
import { parseAgentRefHref } from '../../missions/lib/agent-refs'
import { LogTicketRef, remarkLogTicketRefs, renderLogLineWithTicketRefs } from './log-ticket-refs'
import { useLogTicketActions } from '../hooks/useLogTicketActions'
import { notifyError } from '../../../lib/notify-error'

import { parseEvent, applyDiffDetection, mergeAssistantLines, type FormattedLine } from '../lib/log-lines'

export { parseEvent, applyDiffDetection, mergeAssistantLines }
export type { FormattedLine, FormattedLineType } from '../lib/log-lines'

interface PhaseGroup {
  key: string
  header: FormattedLine | null  // null = preamble before first phase
  lines: FormattedLine[]
}

// ─── Phase grouping ───────────────────────────────────────────────────────────

function groupByPhase(lines: FormattedLine[]): PhaseGroup[] {
  const groups: PhaseGroup[] = [{ key: '__preamble__', header: null, lines: [] }]
  for (const line of lines) {
    if (line.type === 'phase') {
      groups.push({ key: line.id, header: line, lines: [] })
    } else {
      groups[groups.length - 1].lines.push(line)
    }
  }
  // Drop empty preamble
  return groups.filter((g) => g.header !== null || g.lines.length > 0)
}

// ─── LogViewer ────────────────────────────────────────────────────────────────

interface LogViewerProps {
  events: EventRow[]
  isLoading?: boolean
  /** Project scope for `#N` ticket refs in log lines — defaults to the active
   *  project (board JobDetailPage); mission JobDetailModal passes its own. */
  projectId?: string
}

export function LogViewer({ events, isLoading, projectId }: LogViewerProps) {
  const { t, i18n: i18nInstance } = useTranslation('jobs')
  const [filter, setFilter] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [collapsedPhases, setCollapsedPhases] = useState<Set<string>>(new Set())
  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const onOpenTicket = useLogTicketActions(projectId)

  // Parse → merge markdown → detect diffs (memoized — only recomputes when events change)
  const { processedLines, groups, totalLines } = useMemo(() => {
    const rawLines = events
      .map((ev, idx) => parseEvent(ev, idx))
      .filter((l): l is FormattedLine => l !== null)

    const processed = applyDiffDetection(mergeAssistantLines(rawLines))
    return { processedLines: processed, groups: groupByPhase(processed), totalLines: processed.length }
    // i18nInstance.language: parseEvent localises the result summary line, so
    // recompute when the UI language changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, i18nInstance.language])

  // Filter count (memoized — only recomputes when filter or lines change)
  const filteredCount = useMemo(() => {
    if (!filter) return totalLines
    const lowerFilter = filter.toLowerCase()
    return processedLines.filter((l) => l.content.toLowerCase().includes(lowerFilter)).length
  }, [filter, processedLines, totalLines])

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  useEffect(() => {
    if (autoScroll) scrollToBottom()
  }, [events.length, autoScroll, scrollToBottom])

  function handleScroll() {
    const el = containerRef.current
    if (!el) return
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50
    setAutoScroll(isAtBottom)
  }

  function togglePhase(key: string) {
    setCollapsedPhases((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-xs text-muted-foreground">{t('logViewer.loading')}</p>
      </div>
    )
  }

  if (totalLines === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-xs text-muted-foreground">{t('logViewer.empty')}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full" data-testid="log-viewer">
      {/* Filter bar */}
      <div className="px-4 py-2 border-b border-border flex items-center gap-2">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
          <Input
            placeholder={t('logViewer.filterPlaceholder')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label={t('logViewer.filterPlaceholder')}
            className="pl-7 h-7"
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-muted-foreground hover:text-foreground"
          aria-label={t('logViewer.copyAll')}
          title={t('logViewer.copyAll')}
          onClick={() => {
            const text = processedLines.map((l) => l.content).join('\n')
            navigator.clipboard.writeText(text).then(() => {
              toast.success(t('logViewer.copySuccess'))
            }).catch(() => {
              notifyError(t('logViewer.copyFailed'))
            })
          }}
        >
          <Copy className="w-3.5 h-3.5" />
        </Button>
        <span className="text-caption text-muted-foreground">
          {t('logViewer.lineCount', { filtered: filteredCount, total: totalLines })}
        </span>
      </div>

      {/* Log content */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto p-2 text-xs relative"
        onScroll={handleScroll}
      >
        {groups.map((group) => (
          <PhaseGroupSection
            key={group.key}
            group={group}
            filter={filter}
            collapsed={collapsedPhases.has(group.key)}
            onToggle={() => togglePhase(group.key)}
            onOpenTicket={onOpenTicket}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Jump to bottom button */}
      {!autoScroll && (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => { setAutoScroll(true); scrollToBottom() }}
          className="absolute bottom-16 right-6 h-7 gap-1 shadow-lg"
        >
          <ChevronDown className="w-3 h-3" />
          {t('logViewer.jumpToBottom')}
        </Button>
      )}
    </div>
  )
}

// ─── PhaseGroupSection ────────────────────────────────────────────────────────

interface PhaseGroupSectionProps {
  group: PhaseGroup
  filter: string
  collapsed: boolean
  onToggle: () => void
  onOpenTicket?: (ticketId: number) => void
}

const PhaseGroupSection = memo(function PhaseGroupSection({
  group,
  filter,
  collapsed,
  onToggle,
  onOpenTicket,
}: PhaseGroupSectionProps) {
  const { t, i18n } = useTranslation('jobs')
  const visibleLines = filter
    ? group.lines.filter((l) => l.content.toLowerCase().includes(filter.toLowerCase()))
    : group.lines

  // Preamble: render lines without a phase header
  if (group.header === null) {
    if (visibleLines.length === 0) return null
    return (
      <div>
        {visibleLines.map((line, idx) => (
          <LogLine key={line.id} line={line} even={idx % 2 === 0} onOpenTicket={onOpenTicket} />
        ))}
      </div>
    )
  }

  const phaseContent = group.header.content

  return (
    <div className="mt-3 rounded-md overflow-hidden border border-border/20">
      {/* Phase header — clickable to collapse */}
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'flex items-center gap-2 w-full text-left px-3 py-2',
          'bg-primary/5 border-b border-primary/20',
          'hover:bg-primary/10 transition-colors duration-150 cursor-pointer',
        )}
      >
        <ChevronRight
          className={cn(
            'w-3 h-3 text-muted-foreground shrink-0 transition-transform duration-150',
            !collapsed && 'rotate-90',
          )}
        />
        <span className="flex-1 text-label font-semibold text-foreground leading-none">
          {phaseContent}
        </span>
        {group.header.timestamp && (
          <span className="text-caption text-muted-foreground font-mono num shrink-0">
            {new Date(group.header.timestamp).toLocaleTimeString(i18n.language, {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: false,
            })}
          </span>
        )}
        <span className="text-caption text-muted-foreground shrink-0">
          {t('logViewer.phaseLines', { count: group.lines.length })}
        </span>
      </button>

      {/* Phase content */}
      {!collapsed && (
        <div className="bg-muted/5">
          {visibleLines.length === 0 ? (
            <p className="px-4 py-2 text-caption text-muted-foreground italic">
              {filter ? t('logViewer.noMatchingLines') : t('logViewer.noOutput')}
            </p>
          ) : (
            visibleLines.map((line, idx) => (
              <LogLine key={line.id} line={line} even={idx % 2 === 0} onOpenTicket={onOpenTicket} />
            ))
          )}
        </div>
      )}
    </div>
  )
})

// ─── LogLine ──────────────────────────────────────────────────────────────────

const REHYPE_PLUGINS = [rehypeHighlight]
const REMARK_PLUGINS = [remarkGfm]
const REMARK_PLUGINS_WITH_TICKET_REFS = [remarkGfm, remarkLogTicketRefs]

export const LogLine = memo(function LogLine({
  line,
  even,
  onOpenTicket,
}: {
  line: FormattedLine
  even: boolean
  /** When set, `#N` ticket refs in prose lines linkify (log-ticket-refs). */
  onOpenTicket?: (ticketId: number) => void
}) {
  const { i18n } = useTranslation('jobs')
  const isMarkdown = line.type === 'assistant'
  const isDiffAdd = line.type === 'diff-add'
  const isDiffRemove = line.type === 'diff-remove'
  const isDiffMeta = line.type === 'diff-meta'
  const isDiffHunk = line.type === 'diff-hunk'
  const isDiff = isDiffAdd || isDiffRemove || isDiffMeta || isDiffHunk

  // Ticket-ref linkify — PROSE lines only. Diff-styled lines mirror agent-refs'
  // code exclusion; stderr is excluded too (stack frames read `#1 0x…`); the
  // 🧑 user-echo lines are prose (`plain`) and keep their refs.
  const canLinkifyPlain =
    onOpenTicket != null && (line.type === 'plain' || line.type === 'log')
  const plainContent = useMemo<ReactNode>(
    () =>
      canLinkifyPlain && onOpenTicket
        ? renderLogLineWithTicketRefs(line.content, onOpenTicket)
        // Diff add/remove render their +/− marker in a separate glyph span.
        : isDiffAdd || isDiffRemove
          ? line.content.slice(1)
          : line.content,
    [canLinkifyPlain, onOpenTicket, line.content, isDiffAdd, isDiffRemove],
  )

  // Markdown lines get the ticket-only remark plugin (code blocks / inline code
  // are excluded by the mdast walk) + an `a` mapping for the emitted
  // `#agentref:ticket:` fragments. Both memoized so react-markdown's memo holds.
  const remarkPlugins = isMarkdown && onOpenTicket ? REMARK_PLUGINS_WITH_TICKET_REFS : REMARK_PLUGINS
  const markdownComponents = useMemo(
    () =>
      onOpenTicket
        ? {
            a: ({ href, children }: { href?: string; children?: ReactNode }) => {
              const refTarget = parseAgentRefHref(href)
              if (refTarget?.kind === 'ticket') {
                return (
                  <LogTicketRef ticketId={refTarget.ticketId} onOpen={onOpenTicket}>
                    {children}
                  </LogTicketRef>
                )
              }
              return <a href={href}>{children}</a>
            },
          }
        : undefined,
    [onOpenTicket],
  )

  return (
    <div
      className={cn(
        'flex items-start gap-2 group px-2 py-0.5 rounded-sm',
        !isDiff && (even ? 'bg-muted/20' : 'bg-transparent'),
        line.type === 'result' && 'bg-accent-success/5 mt-2 py-2',
        isDiffAdd    && 'bg-accent-success/8',
        isDiffRemove && 'bg-destructive/8',
        isDiffMeta   && 'bg-accent-primary/5',
        isDiffHunk   && 'bg-accent-info/5',
      )}
    >
      {line.timestamp && (
        <span className="text-caption text-muted-foreground shrink-0 mt-0.5 w-[52px] font-mono num">
          {new Date(line.timestamp).toLocaleTimeString(i18n.language, {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
          })}
        </span>
      )}

      {isMarkdown ? (
        <div
          className="flex-1 min-w-0 prose prose-invert prose-xs max-w-none
            prose-p:my-1 prose-p:leading-relaxed
            prose-headings:mt-2 prose-headings:mb-1 prose-headings:text-sm prose-headings:font-semibold
            prose-ul:my-1 prose-ol:my-1 prose-li:my-0
            prose-code:text-accent-info prose-code:text-caption prose-code:bg-muted/40 prose-code:px-1 prose-code:py-0.5 prose-code:rounded
            prose-pre:my-1 prose-pre:bg-muted/30 prose-pre:rounded-md prose-pre:p-2 prose-pre:text-caption
            prose-strong:text-foreground prose-em:text-muted-foreground
            prose-a:text-accent-primary prose-a:no-underline hover:prose-a:underline
            prose-table:my-2 prose-table:text-caption
            prose-thead:border-border prose-thead:bg-muted/30
            prose-th:px-3 prose-th:py-1.5 prose-th:text-left prose-th:font-semibold prose-th:text-foreground
            prose-td:px-3 prose-td:py-1.5 prose-td:border-border
            prose-tr:border-border
            text-foreground"
        >
          <ReactMarkdown
            remarkPlugins={remarkPlugins}
            rehypePlugins={REHYPE_PLUGINS}
            components={markdownComponents}
          >
            {line.content}
          </ReactMarkdown>
        </div>
      ) : (
        <>
        {(isDiffAdd || isDiffRemove) && (
          <span
            aria-hidden
            className={cn(
              'w-3 shrink-0 font-mono leading-relaxed select-none',
              isDiffAdd ? 'text-accent-success' : 'text-destructive',
            )}
          >
            {isDiffAdd ? '+' : '\u2212'}
          </span>
        )}
        <span
          className={cn(
            'flex-1 break-all leading-relaxed whitespace-pre-wrap font-mono',
            line.type === 'tool-use'    && 'text-accent-info text-caption',
            line.type === 'stderr'      && 'text-accent-warning',
            line.type === 'result'      && 'text-accent-success font-medium',
            line.type === 'log'         && 'text-muted-foreground',
            line.type === 'plain'       && 'text-muted-foreground',
            line.type === 'tool-result' && 'text-muted-foreground',
            isDiffAdd    && 'text-accent-success',
            isDiffRemove && 'text-destructive',
            isDiffMeta   && 'text-accent-primary',
            isDiffHunk   && 'text-accent-info',
          )}
        >
          {plainContent}
        </span>
        </>
      )}
    </div>
  )
})
