import { useEffect, useMemo, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useTranslation } from 'react-i18next'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { AlertCircle, Bot, CheckCircle2, ChevronRight, CircleSlash, Loader2, RotateCcw, Square, Terminal } from 'lucide-react'

import { cn } from '../../../lib/utils'
import { formatElapsed } from '../../../lib/format-duration'
import { getMissionSubagentEvents, type AgentSubagent, type AgentSubagentEvent } from '../lib/agent-api'
import { isInterruptedSubagent, isLiveSubagent } from '../lib/mission-sessions'
import { resultPreview } from '../lib/subagent-result'
import { providerLabel } from '../../providers/lib/provider-capabilities'

/** Live elapsed time while running; the final duration once it ended. */
export function useElapsed(node: AgentSubagent): string {
  const [now, setNow] = useState(() => Date.now())
  const live = isLiveSubagent(node)
  useEffect(() => {
    if (!live) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [live])
  const end = node.endedAt ? Date.parse(node.endedAt) : now
  return formatElapsed(Math.max(0, end - Date.parse(node.startedAt)))
}

export function PhaseGlyph({ node }: { node: AgentSubagent }) {
  if (isLiveSubagent(node)) {
    return (
      <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
        <span className="absolute inline-flex h-full w-full rounded-full bg-accent-primary opacity-60 motion-safe:animate-ping" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-accent-primary" />
      </span>
    )
  }
  if (node.phase === 'idle') return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-accent-success" aria-hidden />
  if (node.phase === 'failed') return <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden />
  return <CircleSlash className="h-3.5 w-3.5 shrink-0 text-foreground/45" aria-hidden />
}

function lastSeqOf(events: AgentSubagentEvent[] | null): number {
  return events && events.length > 0 ? events[events.length - 1].seq : 0
}

export function formatTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value)
}

export function SubagentActivity({ conversationId, node, liveEvents }: { conversationId: string; node: AgentSubagent; liveEvents: AgentSubagentEvent[] }) {
  const { t } = useTranslation('agent')
  const [history, setHistory] = useState<AgentSubagentEvent[] | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    getMissionSubagentEvents(conversationId, node.subagentId, 0, 500)
      .then((page) => { if (!cancelled) { setHistory(page.events); setHasMore(page.hasMore) } })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [conversationId, node.subagentId])

  const loadMore = () => {
    const after = lastSeqOf(history)
    void getMissionSubagentEvents(conversationId, node.subagentId, after, 500).then((page) => {
      setHistory((current) => [...(current ?? []), ...page.events])
      setHasMore(page.hasMore)
    })
  }

  // History first, then live events it does not include yet (dedupe by seq).
  const events = useMemo(() => {
    const seen = new Set((history ?? []).map((event) => event.seq))
    const lastSeq = lastSeqOf(history)
    return [...(history ?? []), ...liveEvents.filter((event) => !seen.has(event.seq) && (hasMore ? false : event.seq > lastSeq))]
  }, [history, liveEvents, hasMore])

  if (failed) return <p className="px-3 py-2 text-[11px] text-destructive">{t('subagents.activityFailed')}</p>
  if (!history) return <p className="flex items-center gap-1.5 px-3 py-2 text-[11px] text-foreground/50"><Loader2 className="h-3 w-3 animate-spin" aria-hidden />{t('subagents.loadingActivity')}</p>
  if (events.length === 0) return <p className="px-3 py-2 text-[11px] text-foreground/50">{t('subagents.noActivity')}</p>

  return (
    <div className="max-h-72 space-y-1 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed" data-testid="agent-subagent-activity">
      {events.map((event) => event.channel === 'tool' && event.tool ? (
        <div key={event.seq} className={cn('flex items-start gap-1.5 text-foreground/55', event.tool.isError && 'text-destructive')}>
          <Terminal className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">
            <span className="font-semibold">{event.tool.name}</span>
            {event.tool.phase === 'completed' && event.tool.output ? <span className="text-foreground/40"> → {event.tool.output.slice(0, 300)}</span> : null}
          </span>
        </div>
      ) : (
        <p key={event.seq} className="whitespace-pre-wrap break-words font-sans text-foreground/75">{event.delta}</p>
      ))}
      {hasMore && (
        <button type="button" onClick={loadMore} className="text-[11px] font-sans text-accent-primary hover:underline">{t('subagents.moreActivity')}</button>
      )}
    </div>
  )
}

function SubagentRow({ conversationId, node, liveEvents, depth, onStop, onRelaunch }: {
  conversationId: string
  node: AgentSubagent
  liveEvents: AgentSubagentEvent[]
  depth: number
  onStop: (node: AgentSubagent) => void
  onRelaunch: (node: AgentSubagent) => void
}) {
  const { t } = useTranslation('agent')
  const reduced = useReducedMotion()
  const [open, setOpen] = useState(false)
  const elapsed = useElapsed(node)
  const live = isLiveSubagent(node)
  const shell = node.agentType === 'shell'
  const phaseLabel = t(`subagents.phase.${node.phase}`)
  const reason = node.reason ? t(`subagents.reason.${node.reason}`, { defaultValue: node.reason }) : null
  const tokens = node.usage?.totalTokens ?? ((node.usage?.inputTokens ?? 0) + (node.usage?.outputTokens ?? 0) || null)

  return (
    <li className={cn('border-t border-border/20 first:border-t-0', depth > 0 && 'bg-background/30')} data-testid="agent-subagent-row" data-phase={node.phase}>
      <div className="flex items-center gap-2 px-2.5 py-1.5" style={depth > 0 ? { paddingLeft: `${0.625 + depth * 1.1}rem` } : undefined}>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-label={open ? t('subagents.collapse') : t('subagents.expand', { name: node.description })}
          title={node.resultSummary && !open ? resultPreview(node.resultSummary).slice(0, 280) : undefined}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
        >
          <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-foreground/40 transition-transform', open && 'rotate-90')} aria-hidden />
          <PhaseGlyph node={node} />
          {shell ? <Terminal className="h-3.5 w-3.5 shrink-0 text-foreground/45" aria-hidden /> : <Bot className="h-3.5 w-3.5 shrink-0 text-foreground/45" aria-hidden />}
          <span className={cn('min-w-0 flex-1 truncate text-[12.5px]', live ? 'text-foreground' : 'text-foreground/75')}>{node.description}</span>
          <span className="sr-only">{phaseLabel}{reason ? ` — ${reason}` : ''}</span>
          {node.delegated ? (
            <span className="shrink-0 rounded-full border border-accent-primary/30 bg-accent-primary/[0.06] px-1.5 py-0.5 text-[10px] text-accent-primary/80"
              title={t('subagents.delegatedHint', { provider: providerLabel(node.delegated.driver), model: node.delegated.model })} data-testid="agent-subagent-delegated">
              {providerLabel(node.delegated.driver)} · {node.delegated.model}
            </span>
          ) : node.agentType && !shell && <span className="hidden shrink-0 rounded-full border border-border/50 px-1.5 py-0.5 text-[10px] text-foreground/50 sm:inline">{node.agentType}</span>}
          <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-foreground/45" aria-label={t('subagents.elapsedAria', { elapsed })}>{elapsed}</span>
        </button>
        {live && (
          <button type="button" onClick={() => onStop(node)} aria-label={t('subagents.stopOne', { name: node.description })} title={t('subagents.stop')}
            className="shrink-0 rounded p-1 text-foreground/40 transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive">
            <Square className="h-3 w-3" aria-hidden />
          </button>
        )}
        {isInterruptedSubagent(node) && !shell && (
          <button type="button" onClick={() => onRelaunch(node)} title={t('subagents.relaunchHint')}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border/50 px-1.5 py-0.5 text-[10.5px] text-foreground/60 transition-colors hover:border-accent-primary/50 hover:text-accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary">
            <RotateCcw className="h-3 w-3" aria-hidden />{t('subagents.relaunch')}
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={reduced ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="overflow-hidden border-t border-border/20 bg-background/40"
          >
            {(reason || tokens !== null) && (
              <p className="border-b border-border/20 px-3 py-1.5 font-mono text-[10.5px] text-foreground/45" data-testid="agent-subagent-meta">
                {[
                  reason && `${phaseLabel} · ${reason}`,
                  // Usage is revealed once the sub-agent finished (no approximate live numbers).
                  !live && tokens !== null && t('subagents.tokens', { tokens: formatTokens(tokens) }),
                  !live && node.toolUses ? t('subagents.toolUses', { count: node.toolUses }) : null,
                  !live && node.usage?.costUsd != null ? `${node.usage.costEstimated ? '≈ ' : ''}$${node.usage.costUsd.toFixed(2)}` : null,
                ].filter(Boolean).join(' · ')}
              </p>
            )}
            {node.resultSummary && (
              <section className="border-b border-border/20 px-3 py-2.5" aria-label={t('subagents.result')} data-testid="agent-subagent-result">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-foreground/40">{t('subagents.result')}</p>
                <SubagentResultMarkdown text={node.resultSummary} />
              </section>
            )}
            <SubagentActivity conversationId={conversationId} node={node} liveEvents={liveEvents} />
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  )
}

const RESULT_MARKDOWN_COMPONENTS = {
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-accent-primary underline decoration-accent-primary/40 underline-offset-2 hover:decoration-accent-primary">{children}</a>
  ),
  img: () => null,
  code: ({ className, children }: { className?: string; children?: ReactNode }) => className
    ? <code className={className}>{children}</code>
    : <code className="rounded border border-border/50 bg-background-deep/60 px-1 py-px font-mono text-[0.9em] text-accent-info">{children}</code>,
}

/** A sub-agent's final answer, rendered like the agent's own messages but quieter. */
function SubagentResultMarkdown({ text }: { text: string }) {
  return (
    <div className={cn(
      'prose prose-invert prose-sm max-w-none text-[12px] leading-relaxed text-foreground/80',
      'prose-p:my-1 prose-headings:mb-1 prose-headings:mt-2 prose-headings:text-[12.5px] prose-headings:font-semibold',
      'prose-strong:text-foreground prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-li:marker:text-accent-primary/70',
      'prose-pre:my-1.5 prose-pre:rounded-md prose-pre:border prose-pre:border-border/50 prose-pre:bg-background-deep/60 prose-pre:text-[11px]',
    )}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={RESULT_MARKDOWN_COMPONENTS}>{text}</ReactMarkdown>
    </div>
  )
}

/** Depth-first order so nested sub-agents render under their parent. */
function ordered(nodes: AgentSubagent[]): Array<{ node: AgentSubagent; depth: number }> {
  const byParent = new Map<string | null, AgentSubagent[]>()
  const ids = new Set(nodes.map((node) => node.subagentId))
  for (const node of nodes) {
    const parent = node.parentId && ids.has(node.parentId) ? node.parentId : null
    byParent.set(parent, [...(byParent.get(parent) ?? []), node])
  }
  const result: Array<{ node: AgentSubagent; depth: number }> = []
  const walk = (parent: string | null, depth: number) => {
    for (const node of byParent.get(parent) ?? []) {
      result.push({ node, depth })
      walk(node.subagentId, depth + 1)
    }
  }
  walk(null, 0)
  return result
}

/** Wall time from the first start to the last end (or now while any runs). */
function groupElapsed(nodes: AgentSubagent[], now: number): number {
  const start = Math.min(...nodes.map((node) => Date.parse(node.startedAt)))
  const live = nodes.some(isLiveSubagent)
  const end = live ? now : Math.max(...nodes.map((node) => (node.endedAt ? Date.parse(node.endedAt) : Date.parse(node.startedAt))))
  return Math.max(0, end - start)
}

function nodeTokens(node: AgentSubagent): number | null {
  return node.usage?.totalTokens ?? ((node.usage?.inputTokens ?? 0) + (node.usage?.outputTokens ?? 0) || null)
}

/**
 * The agents a turn launched, as one compact line under the reply: expanded
 * while they work, folded to a summary once they all finished (unless the
 * user chose otherwise). Each row expands to its result and activity. Status
 * comes from Core, never from the agent's prose.
 */
export function AgentSubagentsCard({ conversationId, subagents, liveEvents, onStop, onRelaunch }: {
  conversationId: string
  subagents: AgentSubagent[]
  liveEvents: Record<string, AgentSubagentEvent[]>
  onStop: (subagentIds?: string[]) => Promise<void> | void
  onRelaunch: (node: AgentSubagent) => void
}) {
  const { t } = useTranslation('agent')
  const reduced = useReducedMotion()
  const [stopError, setStopError] = useState(false)
  const [chosen, setChosen] = useState<boolean | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const working = subagents.filter(isLiveSubagent).length
  useEffect(() => {
    if (working === 0) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [working])
  if (subagents.length === 0) return null
  const done = subagents.filter((node) => node.phase === 'idle').length
  const ended = subagents.length - working - done
  const open = chosen ?? working > 0
  const elapsed = formatElapsed(groupElapsed(subagents, now))
  const tokens = working === 0 ? subagents.reduce((sum, node) => sum + (nodeTokens(node) ?? 0), 0) : 0
  const status = working > 0
    ? [t('subagents.working', { count: working }), done > 0 && t('subagents.done', { count: done }), ended > 0 && t('subagents.ended', { count: ended })].filter(Boolean).join(' · ')
    : [t('subagents.finishedIn', { elapsed }), ended > 0 && t('subagents.ended', { count: ended }), tokens > 0 && t('subagents.tokens', { tokens: formatTokens(tokens) })].filter(Boolean).join(' · ')
  const stop = async (ids?: string[]) => {
    setStopError(false)
    try { await onStop(ids) } catch { setStopError(true) }
  }

  return (
    <motion.section
      initial={reduced ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      data-testid="agent-subagents-card"
      data-open={open}
      aria-label={t('subagents.title')}
      className="my-0.5"
    >
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setChosen(!open)}
          aria-expanded={open}
          data-testid="agent-subagents-summary"
          className={cn(
            'inline-flex min-w-0 max-w-full items-center gap-2 rounded-full border px-3 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary',
            working > 0 ? 'border-accent-primary/40 bg-accent-primary/[0.07] text-foreground/85' : 'border-border/50 bg-surface/60 text-foreground/70 hover:border-border hover:text-foreground/85',
          )}
        >
          {working > 0 ? <Loader2 className="h-3 w-3 shrink-0 animate-spin text-accent-primary motion-reduce:animate-none" aria-hidden /> : <Bot className="h-3 w-3 shrink-0 text-foreground/50" aria-hidden />}
          <span className="shrink-0 font-medium">{t('subagents.count', { count: subagents.length })}</span>
          <span className="min-w-0 truncate text-foreground/55" aria-live="polite">{status}</span>
          {working > 0 && <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-foreground/45">{elapsed}</span>}
          <ChevronRight className={cn('h-3 w-3 shrink-0 text-foreground/40 transition-transform motion-reduce:transition-none', open && 'rotate-90')} aria-hidden />
        </button>
        {working > 1 && (
          <button type="button" onClick={() => void stop()} className="shrink-0 rounded-full px-2 py-1 text-[10.5px] text-foreground/45 transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive">
            {t('subagents.stopAll')}
          </button>
        )}
      </div>
      {stopError && <p role="alert" className="mt-1 px-1 text-[11px] text-destructive">{t('subagents.stopFailed')}</p>}
      <AnimatePresence initial={false}>
        {open && (
          <motion.ul
            initial={reduced ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="ml-3 mt-1 overflow-hidden rounded-lg border border-border/40 bg-card/50"
            data-testid="agent-subagents-list"
          >
            {ordered(subagents).map(({ node, depth }) => (
              <SubagentRow key={node.subagentId} conversationId={conversationId} node={node} liveEvents={liveEvents[node.subagentId] ?? []} depth={depth}
                onStop={(item) => void stop([item.subagentId])} onRelaunch={onRelaunch} />
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </motion.section>
  )
}
