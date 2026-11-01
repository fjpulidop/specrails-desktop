// ─── In-conversation intent card (intent-mode) ─────────────────────────────────
// Renders the operator's fenced ```intent-draft snapshot (agent-intent-draft.ts)
// BEFORE any spec exists: the problem, the outcome sought (and its hypothesis),
// how we will know, who and what it affects, the constraints, the open
// questions — never a solution — plus two readings of the request and the
// question that separates them.
//
// The two readings keep IDENTICAL visual weight and are one-click answers to
// the discriminating question (the same send() the composer uses), exactly as
// the legacy problem-frame card did. Once the agent marks the intent settled
// (`ready`), the newest card offers the two paths with equal weight: Explore
// (an Intent session, provided by the extension seam when Intent is mounted)
// and Delegate (the agent writes the spec from the intent). Nothing here
// ranks or recommends either path.

import { Compass, CircleHelp, CornerDownLeft, FileText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../../lib/utils'
import type { IntentDraft } from '../../specs/lib/spec-intent'
import { useMissionExtensions } from '../context/MissionExtensionsContext'

const READING_SHELL =
  'flex min-w-0 flex-col gap-1.5 rounded-lg border border-border/50 bg-surface/50 p-2.5 text-left'

function Reading({ label, text, testId, onSelect, disabled }: { label: string; text: string; testId: string; onSelect?: (text: string) => void; disabled?: boolean }) {
  const { t } = useTranslation('agent')
  const body = (
    <>
      <div className="text-label text-muted-foreground">{label}</div>
      <div className="text-xs leading-5 text-foreground">{text}</div>
    </>
  )
  if (!onSelect) return <div data-testid={testId} className={READING_SHELL}>{body}</div>
  return (
    <button
      type="button"
      data-testid={testId}
      data-agent-interactive
      disabled={disabled}
      title={t('intentDraft.pick')}
      onClick={() => onSelect(text)}
      className={cn(
        READING_SHELL,
        'group/reading transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50',
        disabled ? 'cursor-default' : 'cursor-pointer hover:border-accent-primary/45 hover:bg-accent-primary/[0.09]',
      )}
    >
      {body}
      <span
        aria-hidden
        className={cn(
          'mt-0.5 inline-flex items-center gap-1 text-label text-accent-primary transition-opacity',
          disabled ? 'opacity-0' : 'opacity-0 group-hover/reading:opacity-100 group-focus-visible/reading:opacity-100',
        )}
      >
        <CornerDownLeft className="h-2.5 w-2.5" />
        {t('intentDraft.pick')}
      </span>
    </button>
  )
}

function Section({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-testid={testId}>
      <div className="text-label text-muted-foreground">{label}</div>
      {children}
    </div>
  )
}

function Bullets({ items }: { items: readonly string[] }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((item, i) => (
        <li key={`${i}-${item}`} className="flex items-start gap-1.5 text-xs leading-5 text-foreground">
          <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-foreground/30" />
          <span className="min-w-0 break-words">{item}</span>
        </li>
      ))}
    </ul>
  )
}

export interface AgentIntentDraftCardProps {
  draft: IntentDraft
  /** This card belongs to the NEWEST message in the thread. */
  isLatest?: boolean
  /** A turn is streaming: readings and paths render disabled. */
  isStreaming?: boolean
  conversationId?: string | null
  projectId?: string | null
  /** Sends a reply as the user's next turn (the composer's send()). */
  onSelect?: (text: string) => void
}

export function AgentIntentDraftCard({ draft, isLatest, isStreaming, conversationId, projectId, onSelect }: AgentIntentDraftCardProps) {
  const { t } = useTranslation('agent')
  const { IntentExplore } = useMissionExtensions()
  const { intent, readings } = draft
  const pick = onSelect && isLatest ? onSelect : undefined
  const showPaths = draft.ready && !!isLatest
  const lists: Array<[string, readonly string[], string]> = [
    [t('intentDraft.successSignals'), intent.successSignals, 'agent-intent-draft-signals'],
    [t('intentDraft.affects'), intent.affects, 'agent-intent-draft-affects'],
    [t('intentDraft.constraints'), intent.constraints, 'agent-intent-draft-constraints'],
  ]

  return (
    <div data-testid="agent-intent-draft-card" className="my-1 overflow-hidden rounded-xl border border-accent-info/25 bg-card/80 shadow-lg">
      <div className="flex items-center gap-1.5 border-b border-border/40 bg-accent-info/[0.06] px-3.5 py-2 text-xs font-semibold text-accent-info">
        <Compass className="h-3 w-3" aria-hidden="true" />
        <span>{t('intentDraft.heading')}</span>
        {draft.title && <span className="min-w-0 truncate font-normal text-muted-foreground">· {draft.title}</span>}
        {draft.ready && <span className="ml-auto rounded-full bg-accent-success/15 px-1.5 text-caption font-medium text-accent-success">{t('intentDraft.settled')}</span>}
      </div>

      <div className="flex flex-col gap-2.5 px-3.5 py-3">
        <div className="grid gap-2.5 sm:grid-cols-2">
          <Section label={t('intentDraft.problem')}>
            <p className="whitespace-pre-wrap break-words text-xs leading-5 text-foreground">{intent.problem}</p>
          </Section>
          <Section label={t('intentDraft.outcome')}>
            <p className="whitespace-pre-wrap break-words text-xs leading-5 text-foreground">{intent.outcome}</p>
            {intent.hypothesis && <p className="whitespace-pre-wrap break-words text-xs italic leading-5 text-muted-foreground">{intent.hypothesis}</p>}
          </Section>
        </div>

        {lists.some(([, items]) => items.length > 0) && (
          <div className="grid gap-2.5 sm:grid-cols-3">
            {lists.map(([label, items, testId]) => items.length > 0 && (
              <Section key={testId} label={label} testId={testId}><Bullets items={items} /></Section>
            ))}
          </div>
        )}

        {intent.openQuestions.length > 0 && (
          <Section label={t('intentDraft.openQuestions')} testId="agent-intent-draft-questions">
            <ul className="flex flex-col gap-0.5">
              {intent.openQuestions.map((item) => (
                <li key={item.question} className="text-xs leading-5 text-foreground">
                  <span className="break-words">{item.question}</span>
                  {item.answer && <span className="block break-words pl-3 text-muted-foreground">{item.answer}</span>}
                </li>
              ))}
            </ul>
          </Section>
        )}

        <div className="grid gap-2 sm:grid-cols-2">
          <Reading label={t('intentDraft.restated')} text={readings.restated} testId="agent-intent-draft-reading-restated" onSelect={pick} disabled={isStreaming} />
          <Reading label={t('intentDraft.alternative')} text={readings.alternative} testId="agent-intent-draft-reading-alternative" onSelect={pick} disabled={isStreaming} />
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-accent-primary/25 bg-accent-primary/[0.07] px-2.5 py-2">
          <CircleHelp className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-primary" aria-hidden="true" />
          <div className="min-w-0">
            <div className="text-xs font-semibold text-accent-primary">{t('intentDraft.discriminator')}</div>
            <div className="mt-0.5 text-xs leading-5 text-foreground">{readings.discriminator}</div>
          </div>
        </div>

        {showPaths && (
          <div role="group" aria-label={t('intentDraft.pathsLabel')} data-testid="agent-intent-draft-paths" className="flex flex-col gap-2 border-t border-border/40 pt-2.5">
            <div className="text-label text-muted-foreground">{t('intentDraft.pathsLabel')}</div>
            <div className={cn('grid gap-2', IntentExplore && conversationId ? 'sm:grid-cols-2' : '')}>
              {IntentExplore && conversationId && (
                <IntentExplore projectId={projectId ?? null} conversationId={conversationId} intent={intent} {...(draft.title ? { title: draft.title } : {})} disabled={!!isStreaming} />
              )}
              <button
                type="button"
                data-testid="agent-intent-draft-delegate"
                disabled={!!isStreaming || !onSelect}
                onClick={() => onSelect?.(t('intentDraft.delegateReply'))}
                className="group flex flex-col items-start gap-1 rounded-lg border border-border/60 bg-surface/50 p-2.5 text-left transition-colors hover:border-accent-primary/45 hover:bg-accent-primary/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50 disabled:cursor-default disabled:opacity-60"
              >
                <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                  <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('intentDraft.delegate')}
                </span>
                <span className="text-caption text-muted-foreground">{t('intentDraft.delegateHint')}</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** Shimmer chip while an intent-draft block is still streaming in. */
export function AgentIntentDraftPending() {
  const { t } = useTranslation('agent')
  return (
    <span data-testid="agent-intent-draft-pending" className="inline-flex w-fit items-center gap-1.5 rounded-full border border-accent-info/25 bg-accent-info/10 px-2.5 py-1 text-xs text-accent-info">
      <Compass className="h-3 w-3 motion-safe:animate-pulse" aria-hidden="true" />
      {t('intentDraft.writing')}
    </span>
  )
}
