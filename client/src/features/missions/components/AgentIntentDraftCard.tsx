// ─── In-conversation intent card (intent-mode) ─────────────────────────────────
// Renders the operator's fenced ```intent-draft snapshot (agent-intent-draft.ts)
// BEFORE any spec exists: the problem, the outcome sought (and its hypothesis),
// how we will know, who and what it affects, the constraints, the open
// questions — never a solution — plus, while the intent is still open, two
// readings of the request and the question that separates them.
//
// The two readings keep IDENTICAL visual weight and are one-click answers to
// the discriminating question (the same send() the composer uses), exactly as
// the legacy problem-frame card did. Open questions on the newest card seed
// the composer with the question so the person answers in the chat. Once the
// agent marks the intent settled (`ready`), the readings fold into one
// confirmed line and the latest settled card offers the two paths with equal
// weight: Explore (an Intent session, provided by the extension seam when
// Intent is mounted) and Delegate (the agent writes the spec from the intent).
// Nothing here ranks or recommends either path.
//
// Long intents collapse: the descriptive content clamps to a fixed height with
// a fade and the lists show their first items, until the person asks for the
// whole thing. The open questions (what the card most wants answered) never sit
// under the clamp: they follow it, like the readings and the discriminator.

import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp, Compass, CircleHelp, CornerDownLeft, FileText, MessageSquare } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../../lib/utils'
import type { IntentDraft } from '../../specs/lib/spec-intent'
import { composerDrafts, composerReferenceDrafts, writeComposerDraft } from '../lib/agent-composer-drafts'
import { useMissionExtensions, type MissionIntentExploreProps } from '../context/MissionExtensionsContext'

/** Items a list shows while the card is collapsed. */
const COLLAPSED_ITEMS = 3

const CHOICE_SHELL =
  'flex min-w-0 flex-col gap-1.5 rounded-lg border border-border/50 bg-surface/50 p-2.5 text-left'
const CHOICE_BUTTON =
  'group/choice transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50'
const CHOICE_ENABLED = 'cursor-pointer hover:border-accent-primary/45 hover:bg-accent-primary/[0.09]'
/** The affordance of a choice (reply with it / answer it): visible on hover, keyboard focus and on touch (no hover there). */
const CHOICE_HINT =
  'mt-0.5 inline-flex items-center gap-1 text-label text-accent-primary transition-opacity opacity-0 group-hover/choice:opacity-100 group-focus-visible/choice:opacity-100 [@media(hover:none)]:opacity-100'

/** Path buttons: a disabled one reads muted with a faint border, never through opacity. */
const PATH_BUTTON =
  'flex flex-col items-start gap-1 rounded-lg border p-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50'
const PATH_ENABLED = 'border-border/60 bg-surface/50 text-foreground hover:border-accent-primary/45 hover:bg-accent-primary/[0.06]'
const PATH_DISABLED = 'cursor-default border-border/40 bg-surface/30 text-muted-foreground'

function Reading({ label, text, testId, onSelect, disabled, describedBy }: { label: string; text: string; testId: string; onSelect?: (text: string) => void; disabled?: boolean; describedBy?: string }) {
  const { t } = useTranslation('agent')
  const body = (
    <>
      <div className="text-label text-muted-foreground">{label}</div>
      <div className="text-body text-foreground">{text}</div>
    </>
  )
  if (!onSelect) return <div data-testid={testId} className={CHOICE_SHELL}>{body}</div>
  return (
    <button
      type="button"
      data-testid={testId}
      data-agent-interactive
      disabled={disabled}
      aria-describedby={describedBy}
      onClick={() => onSelect(text)}
      className={cn(CHOICE_SHELL, CHOICE_BUTTON, disabled ? 'cursor-default' : CHOICE_ENABLED)}
    >
      {body}
      {!disabled && (
        <span aria-hidden className={CHOICE_HINT}>
          <CornerDownLeft className="h-2.5 w-2.5" />
          {t('intentDraft.pick')}
        </span>
      )}
    </button>
  )
}

function Section({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-testid={testId}>
      <div className="text-label text-muted-foreground">{label}</div>
      {children}
    </div>
  )
}

/** A bullet list that shows its first items while collapsed; "+N more" opens the whole card. */
function Bullets({ items, collapsed, onExpand }: { items: readonly string[]; collapsed: boolean; onExpand: () => void }) {
  const { t } = useTranslation('agent')
  const hidden = collapsed ? Math.max(0, items.length - COLLAPSED_ITEMS) : 0
  const shown = hidden > 0 ? items.slice(0, COLLAPSED_ITEMS) : items
  return (
    <ul className="flex flex-col gap-0.5">
      {shown.map((item, i) => (
        <li key={`${i}-${item}`} className="flex items-start gap-1.5 text-body text-foreground">
          <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-foreground/30" />
          <span className="min-w-0 break-words">{item}</span>
        </li>
      ))}
      {hidden > 0 && (
        <li>
          <button type="button" data-agent-interactive data-testid="agent-intent-draft-more" onClick={onExpand} className="-my-1 min-h-6 rounded px-1 py-1 pl-2.5 text-caption text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50">
            {t('intentDraft.more', { count: hidden })}
          </button>
        </li>
      )}
    </ul>
  )
}

/** The pill in the header: "Agreed" or "N open", both the Intent lamp (dot + label; amber is caution or cost, and an open question is neither). */
function StatePill({ ready, open }: { ready: boolean; open: number }) {
  const { t } = useTranslation('agent')
  if (!ready && open === 0) return null
  return (
    <span
      data-testid="agent-intent-draft-state"
      className={cn(
        'ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-caption font-medium',
        'border-accent-intent/30 text-accent-intent',
      )}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent-intent" />
      {ready ? t('intentDraft.settled') : t('intentDraft.openCount', { count: open })}
    </span>
  )
}

export interface AgentIntentDraftCardProps {
  draft: IntentDraft
  /** This card belongs to the NEWEST message in the thread. */
  isLatest?: boolean
  /**
   * This card is the latest SETTLED intent of the thread, even when later
   * messages exist: its paths stay offered. The conversation renderer computes
   * it (the last message whose intent-draft is `ready`); without it the card
   * falls back to `isLatest`, so the paths leave as soon as anyone speaks.
   */
  isLatestSettledIntent?: boolean
  /** A turn is streaming: readings and paths render disabled. */
  isStreaming?: boolean
  conversationId?: string | null
  projectId?: string | null
  /** Sends a reply as the user's next turn (the composer's send()). */
  onSelect?: (text: string) => void
}

export function AgentIntentDraftCard({ draft, isLatest, isLatestSettledIntent, isStreaming, conversationId, projectId, onSelect }: AgentIntentDraftCardProps) {
  const { t } = useTranslation('agent')
  const { IntentExplore } = useMissionExtensions()
  const { intent, readings } = draft
  const pickDescriptionId = useId()
  const answerHintId = useId()
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const [exploreState, setExploreState] = useState<'entry' | 'in-intent' | null>(null)
  const entryOpen = exploreState === 'entry'
  const inIntent = exploreState === 'in-intent'
  const clampRef = useRef<HTMLDivElement>(null)

  const pick = onSelect && isLatest ? onSelect : undefined
  const open = intent.openQuestions.filter((item) => !item.answer).length
  // Open questions are answerable only on the newest, still-open card.
  const answerable = !!isLatest && !draft.ready
  const showPaths = draft.ready && (isLatestSettledIntent ?? !!isLatest)
  const lists: Array<[string, readonly string[], string]> = [
    [t('intentDraft.successSignals'), intent.successSignals, 'agent-intent-draft-signals'],
    [t('intentDraft.affects'), intent.affects, 'agent-intent-draft-affects'],
    [t('intentDraft.constraints'), intent.constraints, 'agent-intent-draft-constraints'],
  ]
  // Lists longer than the collapsed window make the card collapsible on their
  // own (deterministic, no layout read); measured overflow adds the fade.
  const longLists = lists.some(([, items]) => items.length > COLLAPSED_ITEMS)
  const collapsed = !expanded
  const collapsible = longLists || overflows

  // Does the clamped content overflow its window? Measured after layout and on
  // resize; the window only exists while collapsed.
  useLayoutEffect(() => {
    const node = clampRef.current
    if (!node || expanded) return
    const measure = () => setOverflows(node.scrollHeight > node.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [expanded, draft])

  // Seeds the composer with the question (the person answers in their words);
  // without a conversation to seed, the question goes out as the reply itself.
  const answer = (question: string) => {
    const seed = `${question} — `
    if (!conversationId) {
      onSelect?.(seed)
      return
    }
    const current = composerDrafts.get(conversationId) ?? ''
    writeComposerDraft(conversationId, `${current}${current && !/\s$/.test(current) ? '\n' : ''}${seed}`, composerReferenceDrafts.get(conversationId) ?? [])
    requestAnimationFrame(() => {
      const editor = clampRef.current?.ownerDocument.querySelector<HTMLElement>('[data-mission-composer] [role="textbox"]')
      editor?.focus()
    })
  }

  // `onExploreState` is the card's private handshake with IntentExploreAction:
  // Delegate hides while the Explore entry card is open, and the whole choice
  // goes once the mission is in Intent (the spec then comes from the hand-off);
  // the seam's public props stay as declared in MissionExtensionsContext.
  const exploreProps: MissionIntentExploreProps & { onExploreState?: (state: 'entry' | 'in-intent' | null) => void } = {
    projectId: projectId ?? null,
    conversationId: conversationId ?? '',
    intent,
    ...(draft.title ? { title: draft.title } : {}),
    disabled: !!isStreaming,
    onExploreState: setExploreState,
  }

  return (
    <div data-testid="agent-intent-draft-card" data-ready={draft.ready ? 'true' : 'false'} className="@container my-1 overflow-hidden rounded-xl border border-accent-intent/25 bg-card/80 shadow-1">
      <div className="flex items-center gap-1.5 border-b border-border/40 bg-accent-intent/[0.06] px-3.5 py-2 text-label font-semibold text-accent-intent">
        <Compass className="h-3 w-3" aria-hidden="true" />
        <span>{t('intentDraft.heading')}</span>
        <StatePill ready={draft.ready} open={open} />
      </div>

      <div className="flex flex-col gap-2.5 px-3.5 py-3">
        <div>
          <div ref={clampRef} data-testid="agent-intent-draft-content" className={cn('relative flex flex-col gap-2.5', collapsed && 'max-h-56 overflow-hidden')}>
            {draft.title && <div data-testid="agent-intent-draft-title" className="text-strong leading-snug text-foreground">{draft.title}</div>}

            <Section label={t('intentDraft.problem')}>
              <p className="whitespace-pre-wrap break-words text-body text-foreground">{intent.problem}</p>
            </Section>
            <Section label={t('intentDraft.outcome')}>
              <p className="whitespace-pre-wrap break-words text-body text-foreground">{intent.outcome}</p>
              {intent.hypothesis && <p className="whitespace-pre-wrap break-words text-body italic text-muted-foreground">{intent.hypothesis}</p>}
            </Section>

            {lists.map(([label, items, testId]) => items.length > 0 && (
              <Section key={testId} label={label} testId={testId}>
                <Bullets items={items} collapsed={collapsed} onExpand={() => setExpanded(true)} />
              </Section>
            ))}

            {collapsed && overflows && (
              <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card to-transparent" />
            )}
          </div>
          {collapsible && (
            <button
              type="button"
              data-testid="agent-intent-draft-expand"
              data-agent-interactive
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
              className="-mb-1 mt-1 flex min-h-6 items-center gap-1 rounded px-1 text-label text-accent-intent transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50"
            >
              {expanded ? <ChevronUp className="h-3 w-3" aria-hidden /> : <ChevronDown className="h-3 w-3" aria-hidden />}
              {expanded ? t('intentDraft.collapse') : t('intentDraft.expand')}
            </button>
          )}
        </div>

        {intent.openQuestions.length > 0 && (
          <Section label={open > 0 ? `${t('intentDraft.openQuestions')} · ${open}` : t('intentDraft.openQuestions')} testId="agent-intent-draft-questions">
            <ul className="flex flex-col gap-1">
              {intent.openQuestions.map((item) => {
                const pill = !item.answer && (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-accent-intent/30 px-1.5 py-px text-caption font-medium text-accent-intent"><span aria-hidden className="h-1 w-1 rounded-full bg-accent-intent" />{t('intentDraft.open')}</span>
                )
                if (answerable && !item.answer) {
                  return (
                    <li key={item.question}>
                      <button
                        type="button"
                        data-testid="agent-intent-draft-question"
                        data-agent-interactive
                        disabled={isStreaming}
                        aria-describedby={answerHintId}
                        onClick={() => answer(item.question)}
                        className={cn(CHOICE_SHELL, CHOICE_BUTTON, 'w-full', isStreaming ? 'cursor-default' : CHOICE_ENABLED)}
                      >
                        <span className="flex items-start justify-between gap-2">
                          <span className="min-w-0 break-words text-body text-foreground">{item.question}</span>
                          {pill}
                        </span>
                        {/* Answering seeds the composer (nothing is sent): its own hint, never "Reply with this". */}
                        {!isStreaming && (
                          <span aria-hidden className={CHOICE_HINT}>
                            <MessageSquare className="h-2.5 w-2.5" />
                            {t('intentDraft.answerPick', { defaultValue: t('intentDraft.answer') })}
                          </span>
                        )}
                      </button>
                    </li>
                  )
                }
                return (
                  <li key={item.question} data-testid="agent-intent-draft-question" className="flex flex-col gap-0.5">
                    <span className="flex items-start justify-between gap-2">
                      <span className="min-w-0 break-words text-body text-foreground">{item.question}</span>
                      {pill}
                    </span>
                    {item.answer && (
                      <span className="flex min-w-0 items-baseline gap-1.5 pl-3">
                        <span className="shrink-0 text-caption text-muted-foreground">{t('intentDraft.answer')}</span>
                        <span className="min-w-0 break-words text-body text-foreground">{item.answer}</span>
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
            {answerable && <p id={answerHintId} className="text-caption text-muted-foreground">{t('intentDraft.answerHint')}</p>}
          </Section>
        )}

        {draft.ready ? (
          <p data-testid="agent-intent-draft-reading-confirmed" className="text-caption text-muted-foreground">
            {t('intentDraft.readingConfirmed')}: {readings.restated}
          </p>
        ) : (
          <>
            {pick && <span id={pickDescriptionId} className="sr-only">{t('intentDraft.pickDescription')}</span>}
            {/* Two columns by the card's own width (a side panel stacks them), not the window's. */}
            <div className="grid gap-2 @xl:grid-cols-2">
              <Reading label={t('intentDraft.restated')} text={readings.restated} testId="agent-intent-draft-reading-restated" onSelect={pick} disabled={isStreaming} describedBy={pick ? pickDescriptionId : undefined} />
              <Reading label={t('intentDraft.alternative')} text={readings.alternative} testId="agent-intent-draft-reading-alternative" onSelect={pick} disabled={isStreaming} describedBy={pick ? pickDescriptionId : undefined} />
            </div>

            <div
              data-testid="agent-intent-draft-discriminator"
              className={cn(
                'flex items-start gap-2 rounded-lg border px-2.5 py-2',
                pick ? 'border-accent-primary/25 bg-accent-primary/[0.07]' : 'border-border/40 bg-surface/40 text-muted-foreground',
              )}
            >
              <CircleHelp className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', pick ? 'text-accent-primary' : 'text-muted-foreground')} aria-hidden="true" />
              <div className="min-w-0">
                <div className={cn('text-label font-semibold', pick ? 'text-accent-primary' : 'text-muted-foreground')}>{t('intentDraft.discriminator')}</div>
                <div className={cn('mt-0.5 text-body', pick ? 'text-foreground' : 'text-muted-foreground')}>{readings.discriminator}</div>
              </div>
            </div>
          </>
        )}

        {showPaths && (
          <div role="group" aria-label={t('intentDraft.pathsLabel')} data-testid="agent-intent-draft-paths" className="flex flex-col gap-2 border-t border-border/40 pt-2.5">
            {!inIntent && <div className="text-label text-muted-foreground">{t('intentDraft.pathsLabel')}</div>}
            <div className={cn('grid gap-2', IntentExplore && conversationId && !entryOpen && !inIntent ? '@xl:grid-cols-2' : '')}>
              {IntentExplore && conversationId && <IntentExplore {...exploreProps} />}
              {/* Delegate steps aside while the Explore entry card is open: one primary at a time. */}
              {!entryOpen && !inIntent && (
                <button
                  type="button"
                  data-testid="agent-intent-draft-delegate"
                  disabled={!!isStreaming || !onSelect}
                  onClick={() => onSelect?.(t('intentDraft.delegateReply'))}
                  className={cn(PATH_BUTTON, !!isStreaming || !onSelect ? PATH_DISABLED : PATH_ENABLED)}
                >
                  <span className="flex items-center gap-1.5 text-label font-semibold">
                    <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('intentDraft.delegate')}
                  </span>
                  <span className="text-caption text-muted-foreground">{t('intentDraft.delegateHint')}</span>
                </button>
              )}
            </div>
            {isStreaming && <p data-testid="agent-intent-draft-wait" className="text-caption text-muted-foreground">{t('flow.offer.waitForReply')}</p>}
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
    <span data-testid="agent-intent-draft-pending" className="inline-flex w-fit items-center gap-1.5 rounded-full border border-accent-intent/25 bg-accent-intent/10 px-2.5 py-1 text-label text-accent-intent">
      <Compass className="h-3 w-3 motion-safe:animate-pulse" aria-hidden="true" />
      {t('intentDraft.writing')}
    </span>
  )
}
