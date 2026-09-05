import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, AlertTriangle, CircleDashed, Loader2, Rocket, Sparkles, X } from 'lucide-react'
import { motion, AnimatePresence } from 'motion/react'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'
import { useAgentChat } from '../../context/AgentChatContext'
import { cutUnterminatedBlock } from '../../lib/blueprint-draft'
import { BlueprintCommitForm } from './BlueprintCommitForm'
import { BuilderComposer } from './BuilderComposer'
import { BuilderHalo } from './BuilderHalo'
import { BuilderRecentBlueprints } from './BuilderRecentBlueprints'
import { BuilderGenerationProgress } from './BuilderGenerationProgress'
import { AgentMessage } from '../agent-chat/AgentMessage'
import { AgentActivityChip } from '../agent-chat/AgentActivityChip'
import { COMMIT_STEP_ORDER, githubErrorKey } from '../../hooks/useBuilderSession'
import { BuilderDoneMilestone } from './BuilderDoneMilestone'
import { BuilderDecisionCard } from './BuilderDecisionCard'
import { MilestoneAutoAdvanceToggle } from './MilestoneProgressCard'
import { readMilestoneAutoAdvance, readMilestoneLaunchMode, saveMilestoneAutoAdvance } from '../../lib/milestone-launch'

// Shared composer card chrome — the morph target of `layoutId` (the mission's
// "agent-composer-dock" twin) so the empty hero card lowers smoothly into the
// docked composer on first send.
const COMPOSER_CARD = 'w-full rounded-2xl border border-border/60 bg-card/90 p-3 shadow-2xl backdrop-blur-xl'

// The builder-mode conversation body (reskin follow-up): the MISSION format —
// messages in a centered column with the halo'd BuilderComposer docked at the
// bottom (centered while empty, mission-style morph), plus the commit /
// progress / done phases in the same column. Rendered by BOTH the floating
// AgentChatPanel and the Agent Mode surface.

interface BuilderConversationProps {
  variant: 'floating' | 'inline'
}

export function BuilderConversation({ variant }: BuilderConversationProps) {
  const { t } = useTranslation('builder')
  const { builderMode } = useAgentChat()
  const session = builderMode.session
  const [confirmExit, setConfirmExit] = useState(false)
  const [doneAutoAdvance, setDoneAutoAdvance] = useState<boolean>(() => readMilestoneAutoAdvance())
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Decision cards: offered after the newest settled Builder reply while the
  // corresponding decision is open — "surprise me" until the blueprint's five
  // dimensions are decided, then "approve" until the Milestone-1 specs exist.
  const lastMessage = session.messages[session.messages.length - 1]
  const blueprintStep = session.readiness.steps.find((step) => step.key === 'blueprint')
  const specsStep = session.readiness.steps.find((step) => step.key === 'specs')
  const decisionWindow = session.phase === 'chat'
    && !session.busy
    && session.streamBuffer === null
    && lastMessage?.role === 'assistant'
    && session.snapshot.status !== 'generating'
  const surpriseOffer = decisionWindow && blueprintStep?.state !== 'done'
  const approveOffer = decisionWindow
    && blueprintStep?.state === 'done'
    && (specsStep === undefined || (specsStep.state === 'pending' && Number(specsStep.params.count ?? 0) === 0))
    && (session.blueprint?.m1Specs.length ?? 0) === 0

  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight })
  }, [session.messages, session.streamBuffer])

  const requestExit = useCallback(() => {
    if (session.dirty && session.phase !== 'done') setConfirmExit(true)
    else builderMode.exit()
  }, [session.dirty, session.phase, builderMode])

  // Esc: commit form → back to chat; chat → exit (confirm-gated); confirm → dismiss.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (confirmExit) setConfirmExit(false)
      else if (session.phase === 'commit' && !session.submitting) session.backToChat()
      else if (session.phase === 'chat') requestExit()
    },
    [confirmExit, session, requestExit],
  )

  const empty = session.messages.length === 0 && session.streamBuffer === null && !session.busy
  // 1:1 with AgentConversationView: same centered thread cap inline, same
  // full-frame behavior in the floating panel.
  const threadClass = variant === 'inline'
    ? 'mx-auto flex w-full max-w-[820px] flex-1 flex-col overflow-hidden'
    : 'flex flex-1 flex-col overflow-hidden'

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown} data-testid="builder-conversation">
      {session.phase === 'chat' && (empty ? (
        // ── EMPTY: centered composer card, the mission empty-state shape. The
        // card carries the shared `layoutId`, so the first send morphs it down
        // into the docked composer (the smooth "lower the agent" effect). The
        // halo is the ENTRY flourish — only here, gone once work starts.
        <div className="relative z-10 flex h-full w-full items-center justify-center px-6">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.28, ease: [0.34, 1.56, 0.64, 1] }}
            className={cn('w-full', variant === 'inline' ? 'max-w-[680px]' : 'max-w-[560px]')}
          >
            <div className="mb-4 text-center">
              <Sparkles className="mx-auto h-7 w-7 text-accent-primary/60" />
              <p className="mt-2 text-sm font-medium">{t('shell.emptyTitle')}</p>
              <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">{t('shell.emptyHint')}</p>
            </div>
            <div className="relative">
              <BuilderHalo active inset={-3} radius="1rem" />
              <motion.div
                layoutId={variant === 'inline' ? 'builder-composer-dock' : undefined}
                data-testid="builder-composer-card"
                data-composer-position="hero"
                data-layout-id={variant === 'inline' ? 'builder-composer-dock' : undefined}
                transition={{ layout: { type: 'spring', stiffness: 350, damping: 34 } }}
                className={COMPOSER_CARD}
              >
                <BuilderComposer session={session} autoFocus />
              </motion.div>
            </div>
            {/* Durable blueprints: resume an unfinished conversation instead of
                starting over (harden-project-builder-snapshots). */}
            <BuilderRecentBlueprints
              items={session.recent}
              loading={session.recentLoading}
              disabled={!session.conversationReady}
              onResume={(id) => void session.resume(id)}
              onDiscard={(id) => void session.discardRecent(id)}
            />
          </motion.div>
        </div>
      ) : (
        // ── ACTIVE: the MISSION chat, 1:1 — same AgentMessage bubbles
        // (markdown, timestamp, hover copy, option chips), same thread column,
        // same thinking/activity chip, and the docked composer sharing the
        // `layoutId` so it morphs down from the centered card. Only what
        // happens underneath differs (blueprint transport, not the operator MCP).
        <div className={threadClass}>
          <div ref={scrollRef} className="flex-1 space-y-5 overflow-y-auto px-4 py-4" data-testid="builder-messages">
            {session.messages.map((m, i) => (
              m.role === 'user' && m.intent ? (
                // A decision taken from a card stays a card — fixed in the thread.
                <div key={`${i}-${m.createdAt}`} className="flex justify-end">
                  <BuilderDecisionCard kind={m.intent} mode="settled" createdAt={m.createdAt} />
                </div>
              ) : (
                <AgentMessage
                  key={`${i}-${m.createdAt}`}
                  role={m.role}
                  content={m.content}
                  createdAt={m.createdAt}
                  // Option chips clickable only on the newest settled message —
                  // identical rule to the mission thread.
                  isLast={session.streamBuffer === null && !session.busy && i === session.messages.length - 1}
                  onPickOption={(option) => session.send(option)}
                />
              )
            ))}
            {/* The interview is open and the Builder just answered: one click
                lets it decide every remaining dimension (the prose keeps
                inviting "surprise me" — this is the affordance). */}
            <AnimatePresence initial={false}>
              {surpriseOffer && (
                <BuilderDecisionCard key="surprise" kind="surprise" mode="offer" onAction={session.surpriseMe} disabled={!session.conversationReady} />
              )}
              {approveOffer && (
                <BuilderDecisionCard key="approve" kind="approve" mode="offer" onAction={session.approveBlueprint} disabled={!session.conversationReady} />
              )}
            </AnimatePresence>
            {(session.busy || session.streamBuffer !== null) && (
              <div className="space-y-2">
                {session.streamBuffer !== null && cutUnterminatedBlock(session.streamBuffer) && (
                  <AgentMessage role="assistant" content={cutUnterminatedBlock(session.streamBuffer)} streaming />
                )}
                {/* A snapshot block streaming in (hidden by the tail cut) or an
                    app-driven repair turn reads as real progress, not "Thinking…". */}
                {session.generation.generating || session.snapshot.status === 'repairing' || session.snapshot.status === 'generating' ? (
                  <BuilderGenerationProgress specsStarted={session.generation.specsStarted} snapshot={session.snapshot} />
                ) : (
                  <AgentActivityChip tool={null} />
                )}
              </div>
            )}
          </div>
          <div className="shrink-0 px-4 pb-4">
            <motion.div
              layoutId={variant === 'inline' ? 'builder-composer-dock' : undefined}
              data-testid="builder-composer-card"
              data-composer-position="docked"
              data-layout-id={variant === 'inline' ? 'builder-composer-dock' : undefined}
              transition={{ layout: { type: 'spring', stiffness: 350, damping: 34 } }}
              className={cn(COMPOSER_CARD, variant === 'inline' && 'mx-auto max-w-[680px]')}
            >
              <BuilderComposer session={session} />
            </motion.div>
          </div>
        </div>
      ))}

      {session.phase === 'commit' && session.blueprint && (
        <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto">
          <BlueprintCommitForm
            blueprint={session.blueprint}
            onSubmit={session.submitCommit}
            onBack={session.backToChat}
            submitting={session.submitting}
            error={session.commitError}
            errorDetail={session.commitErrorDetail}
          />
        </div>
      )}

      {session.phase === 'progress' && (
        <div className="mx-auto mt-10 w-full max-w-md p-6" data-testid="commit-progress">
          <h2 className="text-sm font-semibold">{t('progress.title')}</h2>
          <ul className="mt-4 space-y-2">
            {COMMIT_STEP_ORDER.map((step) => {
              const state = session.commitSteps.find((s) => s.step === step)
              if (!state && step === 'github') return null
              return (
                <li key={step} className="flex items-center gap-2 text-xs">
                  {!state && <CircleDashed className="h-3.5 w-3.5 text-muted-foreground/40" />}
                  {state?.status === 'running' && <Loader2 className="h-3.5 w-3.5 animate-spin text-accent-info" />}
                  {state?.status === 'done' && <Check className="h-3.5 w-3.5 text-accent-success" />}
                  {state?.status === 'warning' && <AlertTriangle className="h-3.5 w-3.5 text-accent-warning" />}
                  {state?.status === 'failed' && <X className="h-3.5 w-3.5 text-destructive" />}
                  <span className={cn(!state && 'text-muted-foreground/50')}>{t(`progress.steps.${step}`)}</span>
                  {state?.status === 'warning' && step === 'github' ? (
                    <span className="truncate text-[10px] text-accent-warning" title={state.detail}>
                      {t(githubErrorKey(state.code))}
                    </span>
                  ) : (
                    state?.detail && <span className="truncate text-[10px] text-muted-foreground" title={state.detail}>{state.detail}</span>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {session.phase === 'done' && (
        <div className="mx-auto mt-12 w-full max-w-md p-6 text-center" data-testid="commit-done">
          <Check className="mx-auto h-10 w-10 rounded-full bg-accent-success/15 p-2 text-accent-success" />
          <h2 className="mt-3 text-sm font-semibold">{t('done.title')}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t('done.description')}</p>
          {/* After Launch: the LIVE milestone card (server-derived progress,
              rails, chain) replaces the button — never a fire-and-forget exit. */}
          {session.launched && session.createdProjectId && (
            <BuilderDoneMilestone projectId={session.createdProjectId} />
          )}
          <div className="mt-5 flex flex-col gap-2">
            {!session.launched && (
              <>
                <Button onClick={() => void session.launchM1()} disabled={session.launching} data-testid="launch-m1">
                  {session.launching ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Rocket className="mr-1.5 h-3.5 w-3.5" />}
                  {t('done.launchM1')}
                </Button>
                {/* Wave checkpoints (D9): the stored preference the launch reads. */}
                {readMilestoneLaunchMode() === 'sequential' && (
                  <MilestoneAutoAdvanceToggle
                    checked={doneAutoAdvance}
                    onChange={(on) => { setDoneAutoAdvance(on); saveMilestoneAutoAdvance(on) }}
                    disabled={session.launching}
                    testId="done-auto-advance"
                  />
                )}
              </>
            )}
            <Button variant="outline" onClick={session.openProject} data-testid="open-project">
              {t('done.openProject')}
            </Button>
          </div>
        </div>
      )}

      {/* Exit confirmation — rendered in-surface (not a Radix portal) so it
          stacks correctly inside the floating panel. */}
      {confirmExit && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/70 backdrop-blur-sm" data-testid="builder-exit-confirm">
          <div
            className="w-72 rounded-lg border border-border/60 bg-card p-4 shadow-xl"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="builder-exit-confirm-title"
          >
            <p id="builder-exit-confirm-title" className="text-sm font-medium">{t('mode.exitConfirmTitle')}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('mode.exitConfirmBody')}</p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setConfirmExit(false)} data-testid="builder-exit-cancel">
                {t('mode.exitConfirmCancel')}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => { setConfirmExit(false); builderMode.exit() }}
                data-testid="builder-exit-confirm-btn"
              >
                {t('mode.exitConfirmDiscard')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
