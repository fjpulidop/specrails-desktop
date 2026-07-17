import { useTranslation } from 'react-i18next'
import { SendHorizontal, Bot, Hammer, Sparkles, Gauge } from 'lucide-react'
import { AgentToolbarSelector } from '../agent-chat/AgentToolbarSelector'
import { AgentModelSelector } from '../agent-chat/AgentModelSelector'
import type { BuilderSession } from '../../hooks/useBuilderSession'

// The builder-mode composer CONTENT (reskin follow-up) — 1:1 with the MISSION
// composer's inner layout: identity row, the provider · model · effort selector
// row (+ surprise-me), and the same resize-y textarea box with the same
// SendHorizontal button. The card chrome, halo, and layoutId morph live in
// BuilderConversation (mirroring how AgentConversationView wraps AgentComposer)
// so builder mode reads as "the agent, transformed", not a different app.

const PROVIDERS = ['claude', 'codex', 'gemini']

interface BuilderComposerProps {
  session: BuilderSession
  autoFocus?: boolean
}

export function BuilderComposer({ session, autoFocus = false }: BuilderComposerProps) {
  const { t } = useTranslation('builder')
  const { t: tAgent } = useTranslation('agent')

  const sendInput = () => {
    if (!session.draft.trim() || session.busy || !session.conversationReady) return
    session.send(session.draft)
    session.setDraft('')
  }

  return (
    <>
      {/* Identity row — the transformed agent (mode indicator; the mission's
          twin is "¿Cuál es la misión?"). No exit button: leaving the Builder is
          a mission action ("+ New mission" / picking a mission) or Esc. */}
      <div className="mb-3 flex items-center gap-2 px-1">
        <Hammer className="h-4 w-4 text-accent-primary" />
        <span className="text-sm font-medium text-foreground/80">{t('mode.title')}</span>
      </div>

      {/* Selector row — the SAME primitives as the mission composer. */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <AgentToolbarSelector
          label={tAgent('provider.label')}
          value={session.provider}
          options={PROVIDERS.map((p) => ({ value: p, label: tAgent(`provider.${p}`) }))}
          icon={Bot}
          onSelect={session.setProvider}
          disabled={session.busy || !session.conversationReady}
          testId="builder-provider-selector"
        />
        <AgentModelSelector
          models={session.models}
          model={session.model}
          onSelect={session.setModel}
          disabled={session.busy || !session.conversationReady}
          testId="builder-model-selector"
        />
        {session.efforts.length > 0 && (
          <AgentToolbarSelector
            label={tAgent('effort.label')}
            value={session.effort}
            options={session.efforts.map((level) => ({ value: level, label: tAgent(`effort.${level}`) }))}
            icon={Gauge}
            onSelect={session.setEffort}
            disabled={session.busy || !session.conversationReady}
            testId="builder-effort-selector"
          />
        )}
        {session.showSurpriseMe && (
          <button
            type="button"
            onClick={session.surpriseMe}
            disabled={session.busy || !session.conversationReady}
            className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-accent-highlight/40 bg-accent-highlight/10 px-3 py-1 text-[11px] text-accent-highlight transition-colors hover:bg-accent-highlight/20 disabled:opacity-40"
            data-testid="surprise-me"
          >
            <Sparkles className="h-3 w-3" />
            {t('shell.surpriseMe')}
          </button>
        )}
      </div>

      {/* Input box — 1:1 with the mission composer: same rounded box, same
          resize-y grip (native), same SendHorizontal button. */}
      <div className="relative flex items-end gap-2 rounded-xl border border-border/60 bg-background/60 px-3 py-2">
        <textarea
          value={session.draft}
          autoFocus={autoFocus}
          onChange={(e) => session.setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              sendInput()
            }
          }}
          rows={2}
          placeholder={t('shell.inputPlaceholder')}
          aria-label={t('shell.inputPlaceholder')}
          data-agent-interactive
          className="min-h-[3.25rem] max-h-64 min-w-[12rem] flex-1 resize-y bg-transparent text-sm text-foreground outline-none placeholder:text-foreground/40"
          data-testid="builder-input"
        />
        <button
          type="button"
          onClick={sendInput}
          disabled={session.busy || !session.draft.trim() || !session.conversationReady}
          aria-label={tAgent('send')}
          className="rounded-lg bg-accent-primary p-1.5 text-white transition-opacity disabled:opacity-40"
          data-testid="builder-send"
        >
          <SendHorizontal className="h-4 w-4" />
        </button>
      </div>
    </>
  )
}
