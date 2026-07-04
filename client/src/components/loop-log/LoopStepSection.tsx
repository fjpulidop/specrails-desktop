import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Copy, Check, X, Play, Info } from 'lucide-react'
import { cn } from '../../lib/utils'
import { LogLine, type FormattedLine } from '../LogViewer'
import {
  formatStepDuration,
  stepDisplayTitle,
  type LoopStepSegment,
  type SegmentStatus,
} from './loop-log-model'
import { loopNodeIcon, LOOP_NODE_TEXT_ACCENT } from './loop-node-visuals'

// ─── Shared bits ──────────────────────────────────────────────────────────────

function PulseDot({ className }: { className?: string }) {
  return (
    <span className={cn('relative flex h-2 w-2 shrink-0', className)}>
      <span className="motion-safe:animate-ping absolute inline-flex h-full w-full rounded-full bg-accent-primary opacity-60" />
      <span className="relative inline-flex rounded-full h-2 w-2 bg-accent-primary" />
    </span>
  )
}

function visibleLinesFor(lines: FormattedLine[], filter: string): FormattedLine[] {
  if (!filter) return lines
  const f = filter.toLowerCase()
  return lines.filter((l) => l.content.toLowerCase().includes(f))
}

function sectionBody(
  visible: FormattedLine[],
  filter: string,
  t: (k: string) => string,
  onOpenTicket?: (ticketId: number) => void,
) {
  if (visible.length === 0) {
    return (
      <p className="px-4 py-2 text-[10px] text-muted-foreground/40 italic">
        {filter ? t('logViewer.noMatchingLines') : t('logViewer.noOutput')}
      </p>
    )
  }
  return visible.map((line, idx) => (
    <LogLine key={line.id} line={line} even={idx % 2 === 0} onOpenTicket={onOpenTicket} />
  ))
}

/** One labeled monospace value inside the step-detail block, with its own
 *  small copy control (transient check feedback, no toast — subtle surface). */
function DetailField({ label, value, copyLabel }: { label: string; value: string; copyLabel: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard unavailable — silently ignore (subtle, non-critical control)
    }
  }
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/50">
          {label}
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={`${copyLabel} — ${label}`}
          title={copyLabel}
          className="p-0.5 text-muted-foreground/40 hover:text-foreground transition-colors cursor-pointer"
        >
          {copied ? (
            <Check className="w-2.5 h-2.5 text-accent-success" />
          ) : (
            <Copy className="w-2.5 h-2.5" />
          )}
        </button>
      </div>
      <pre className="mt-0.5 text-[10px] font-mono leading-relaxed text-foreground/75 whitespace-pre-wrap break-words">
        {value}
      </pre>
    </div>
  )
}

// ─── Step section ─────────────────────────────────────────────────────────────

export interface LoopStepSectionProps {
  segment: LoopStepSegment
  status: SegmentStatus
  collapsed: boolean
  filter: string
  onToggle: (key: string) => void
  onCopy: (key: string) => void
  setRef: (key: string, el: HTMLDivElement | null) => void
  /** Ticket-ref click handler threaded into `LogLine` (stable — like onToggle). */
  onOpenTicket?: (ticketId: number) => void
}

function LoopStepSectionInner({
  segment,
  status,
  collapsed,
  filter,
  onToggle,
  onCopy,
  setRef,
  onOpenTicket,
}: LoopStepSectionProps) {
  const { t } = useTranslation('jobs')
  const { meta, lines, end, lastActivity } = segment
  const Icon = loopNodeIcon(meta.kind)
  const accent = LOOP_NODE_TEXT_ACCENT[meta.kind] ?? 'text-foreground'
  const visible = visibleLinesFor(lines, filter)
  const isRunning = status === 'running'
  // Template/Command detail (payload-borne since the log-hygiene change; the
  // old flat-log lines are gone). Collapsed by default; local state — the memo
  // never blocks a state-driven re-render.
  const hasDetail = Boolean(meta.template || meta.command)
  const [detailOpen, setDetailOpen] = useState(false)

  return (
    <div
      ref={(el) => setRef(segment.key, el)}
      data-testid="loop-step-section"
      data-status={status}
      data-step-index={meta.index}
      className={cn(
        'mt-3 rounded-md overflow-hidden border animate-in fade-in duration-200',
        status === 'running' && 'border-accent-primary/40',
        status === 'failed' && 'border-destructive/30',
        status === 'interrupted' && 'border-dashed border-accent-warning/40',
        (status === 'ok' || status === 'unknown') && 'border-border/20',
      )}
    >
      {/* Header row: toggle button (flex-1) + copy button — the copy control
          lives OUTSIDE the toggle so the header stays a valid button. */}
      <div
        className={cn(
          'flex items-stretch bg-primary/5 border-b',
          status === 'failed' ? 'border-destructive/20' : 'border-primary/20',
        )}
      >
        <button
          type="button"
          onClick={() => onToggle(segment.key)}
          className="flex items-center gap-2 flex-1 min-w-0 text-left px-3 py-2 hover:bg-primary/10 transition-colors duration-150 cursor-pointer"
        >
          <ChevronRight
            className={cn(
              'w-3 h-3 text-primary/60 shrink-0 transition-transform duration-150',
              !collapsed && 'rotate-90',
            )}
          />
          <span className="text-[10px] font-mono tabular-nums text-muted-foreground/60 shrink-0 w-5 text-right">
            {meta.index}
          </span>
          <Icon className={cn('w-3.5 h-3.5 shrink-0', accent)} />
          <span className="text-[12px] font-semibold text-foreground leading-none truncate">
            {stepDisplayTitle(meta)}
          </span>
          {meta.iteration != null && meta.iteration >= 1 && (
            <span className="shrink-0 rounded-full bg-muted/60 px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground tabular-nums">
              {t('loopExplorer.iterationBadge', { count: meta.iteration })}
            </span>
          )}

          {/* Status zone */}
          {isRunning && (
            <span className="flex items-center gap-1.5 min-w-0 shrink-0 max-w-[40%]">
              <PulseDot />
              {lastActivity && (
                <span className="title-shimmer text-[10px] truncate">
                  {t(`statusPanel.activity.${lastActivity.actionKey}`, {
                    arg: lastActivity.actionArg ?? '',
                  })}
                </span>
              )}
            </span>
          )}
          {status === 'ok' && <Check className="w-3.5 h-3.5 text-accent-success shrink-0" />}
          {status === 'failed' && <X className="w-3.5 h-3.5 text-destructive shrink-0" />}
          {status === 'interrupted' && (
            <span className="shrink-0 rounded border border-dashed border-accent-warning/50 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-accent-warning">
              {t('loopExplorer.interrupted')}
            </span>
          )}

          <span className="flex-1" />

          {end?.durationMs != null && (
            <span className="text-[10px] text-muted-foreground/50 font-mono tabular-nums shrink-0">
              {formatStepDuration(end.durationMs)}
            </span>
          )}
          {status === 'failed' && end?.exitCode != null && end.exitCode !== 0 && (
            <span className="text-[10px] text-destructive/70 font-mono shrink-0">
              {t('activeJob.exitCode', { code: end.exitCode })}
            </span>
          )}
          <span className="text-[10px] text-muted-foreground/40 shrink-0">
            {t('logViewer.phaseLines', { count: lines.length })}
          </span>
        </button>

        {/* Subtle ⓘ disclosure — only when the step carries payload detail
            (template/command). Lives OUTSIDE the toggle (no nested buttons). */}
        {hasDetail && (
          <button
            type="button"
            onClick={() => setDetailOpen((v) => !v)}
            aria-label={t('loopExplorer.stepDetail')}
            aria-expanded={detailOpen}
            title={t('loopExplorer.stepDetail')}
            className={cn(
              'px-2 flex items-center transition-colors cursor-pointer',
              detailOpen
                ? 'text-foreground bg-primary/10'
                : 'text-muted-foreground/40 hover:text-foreground hover:bg-primary/10',
            )}
          >
            <Info className="w-3 h-3" />
          </button>
        )}

        <button
          type="button"
          onClick={() => onCopy(segment.key)}
          aria-label={t('loopExplorer.copyStep')}
          title={t('loopExplorer.copyStep')}
          className="px-2.5 flex items-center text-muted-foreground/40 hover:text-foreground hover:bg-primary/10 transition-colors cursor-pointer"
        >
          <Copy className="w-3 h-3" />
        </button>
      </div>

      {/* Expanded header detail — independent of the body collapse state */}
      {detailOpen && hasDetail && (
        <div
          data-testid="loop-step-detail"
          className={cn(
            'px-4 py-2.5 space-y-2.5 bg-muted/10 border-b animate-in fade-in duration-150',
            status === 'failed' ? 'border-destructive/20' : 'border-primary/10',
          )}
        >
          {meta.template && (
            <DetailField
              label={t('loopExplorer.stepDetailTemplate')}
              value={meta.template}
              copyLabel={t('loopExplorer.copyCommand')}
            />
          )}
          {meta.command && (
            <DetailField
              label={t('loopExplorer.stepDetailCommand')}
              value={meta.command}
              copyLabel={t('loopExplorer.copyCommand')}
            />
          )}
        </div>
      )}

      {/* Collapsed segments render NOTHING (perf) */}
      {!collapsed && (
        <div className="bg-muted/5">{sectionBody(visible, filter, t, onOpenTicket)}</div>
      )}
    </div>
  )
}

/** Memoized per (key, lineCount, streaming tail, end, status, collapse, filter):
 *  a WS flush that only grows the running step never re-renders settled boxes. */
export const LoopStepSection = memo(
  LoopStepSectionInner,
  (prev, next) =>
    prev.segment.key === next.segment.key &&
    prev.segment.lines.length === next.segment.lines.length &&
    // A streamed assistant continuation merges INTO the last line (no length
    // change) — compare the tail content so live markdown still updates.
    prev.segment.lines[prev.segment.lines.length - 1]?.content ===
      next.segment.lines[next.segment.lines.length - 1]?.content &&
    prev.segment.meta.template === next.segment.meta.template &&
    prev.segment.meta.command === next.segment.meta.command &&
    prev.segment.end?.status === next.segment.end?.status &&
    prev.segment.end?.durationMs === next.segment.end?.durationMs &&
    prev.segment.end?.decision === next.segment.end?.decision &&
    prev.segment.end?.exitCode === next.segment.end?.exitCode &&
    prev.segment.lastActivity?.actionKey === next.segment.lastActivity?.actionKey &&
    prev.segment.lastActivity?.actionArg === next.segment.lastActivity?.actionArg &&
    prev.status === next.status &&
    prev.collapsed === next.collapsed &&
    prev.filter === next.filter &&
    prev.onOpenTicket === next.onOpenTicket,
)

// ─── Setup section ────────────────────────────────────────────────────────────

export interface LoopSetupSectionProps {
  lines: FormattedLine[]
  collapsed: boolean
  filter: string
  onToggle: (key: string) => void
  setRef: (key: string, el: HTMLDivElement | null) => void
  /** Ticket-ref click handler threaded into `LogLine` (stable — like onToggle). */
  onOpenTicket?: (ticketId: number) => void
}

export const SETUP_KEY = '__setup__'

function LoopSetupSectionInner({ lines, collapsed, filter, onToggle, setRef, onOpenTicket }: LoopSetupSectionProps) {
  const { t } = useTranslation('jobs')
  const visible = visibleLinesFor(lines, filter)

  return (
    <div
      ref={(el) => setRef(SETUP_KEY, el)}
      data-testid="loop-setup-section"
      className="rounded-md overflow-hidden border border-border/20"
    >
      <button
        type="button"
        onClick={() => onToggle(SETUP_KEY)}
        className="flex items-center gap-2 w-full text-left px-3 py-2 bg-muted/10 border-b border-border/20 hover:bg-muted/20 transition-colors duration-150 cursor-pointer"
      >
        <ChevronRight
          className={cn(
            'w-3 h-3 text-muted-foreground/60 shrink-0 transition-transform duration-150',
            !collapsed && 'rotate-90',
          )}
        />
        <Play className="w-3.5 h-3.5 text-accent-success/70 shrink-0" />
        <span className="text-[11px] font-semibold text-muted-foreground leading-none uppercase tracking-wide">
          {t('loopExplorer.setup')}
        </span>
        <span className="flex-1" />
        <span className="text-[10px] text-muted-foreground/40 shrink-0">
          {t('logViewer.phaseLines', { count: lines.length })}
        </span>
      </button>
      {!collapsed && (
        <div className="bg-muted/5">{sectionBody(visible, filter, t, onOpenTicket)}</div>
      )}
    </div>
  )
}

export const LoopSetupSection = memo(
  LoopSetupSectionInner,
  (prev, next) =>
    prev.lines.length === next.lines.length &&
    prev.lines[prev.lines.length - 1]?.content === next.lines[next.lines.length - 1]?.content &&
    prev.collapsed === next.collapsed &&
    prev.filter === next.filter &&
    prev.onOpenTicket === next.onOpenTicket,
)
