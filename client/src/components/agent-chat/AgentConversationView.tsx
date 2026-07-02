import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { Bot, ShieldAlert, PackageOpen } from 'lucide-react'
import { useAgentChat } from '../../context/AgentChatContext'
import { useActiveTheme } from '../../context/ThemeContext'
import { useSmoothStream } from '../explore-spec/useSmoothStream'
import { AgentActivityChip } from './AgentActivityChip'
import { AgentMessage } from './AgentMessage'
import { AgentComposer } from './AgentComposer'

/**
 * Shared inner conversation UI — banners + sticky-scroll message list + streaming
 * + composer — consumed by BOTH the floating `AgentChatPanel` (variant='floating')
 * and the inline `AgentModeSurface` (variant='inline'). Window chrome
 * (drag/resize/maximize) stays in the panel wrapper. Context-driven.
 */
export function AgentConversationView({ variant }: { variant: 'floating' | 'inline' }) {
  const { t } = useTranslation('agent')
  const {
    messages, streamingText, isStreaming, liveTools,
    mcpEnabled, enablingMcp, enableMcpServer, providersReady, cycleTier, send,
  } = useAgentChat()
  const scrollRef = useRef<HTMLDivElement>(null)
  const smoothed = useSmoothStream(streamingText, isStreaming)
  // Easter egg: on the Matrix theme, the agent becomes agent Smith.
  const emptyTitle = useActiveTheme().id === 'matrix' ? t('emptyTitleMatrix') : t('emptyTitle')

  // Stick-to-bottom: only auto-scroll while the user is already near the bottom.
  const pinnedRef = useRef(true)
  const onMessagesScroll = () => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }
  useEffect(() => {
    if (!pinnedRef.current) return
    scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight, behavior: 'auto' })
  }, [messages.length, smoothed, liveTools.length])

  // Shift+Tab anywhere in the view (incl. the composer) cycles the tier ladder.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.shiftKey && (e.key === 'Tab' || e.code === 'Tab')) {
      e.preventDefault()
      e.stopPropagation()
      void cycleTier()
    }
  }

  const inline = variant === 'inline'
  // The inline surface caps the conversation column so it reads like Cursor's
  // centered thread on wide screens; the floating panel fills its own frame.
  const threadClass = inline
    ? 'mx-auto flex w-full max-w-[820px] flex-1 flex-col overflow-hidden'
    : 'flex flex-1 flex-col overflow-hidden'

  return (
    <div className={`flex h-full flex-col overflow-hidden ${inline ? '' : ''}`} onKeyDown={onKeyDown}>
      {providersReady === false && (
        <div className="flex items-start gap-2 border-b border-border/50 bg-accent-warning/10 px-3 py-2 text-xs text-foreground">
          <PackageOpen className="mt-0.5 h-4 w-4 shrink-0 text-accent-warning" />
          <div className="flex-1">
            <p className="font-medium">{t('noProvider.title')}</p>
            <p className="mt-0.5 text-foreground/70">{t('noProvider.body')}</p>
          </div>
        </div>
      )}
      {providersReady !== false && !mcpEnabled && (
        <div className="flex items-center gap-2 border-b border-border/50 bg-accent-warning/10 px-3 py-2 text-xs text-foreground">
          <ShieldAlert className="h-4 w-4 shrink-0 text-accent-warning" />
          <span className="flex-1">{t('degraded.body')}</span>
          <button type="button" onClick={() => void enableMcpServer()} disabled={enablingMcp} className="rounded-md bg-accent-primary px-2 py-1 text-xs font-medium text-white disabled:opacity-60">
            {enablingMcp ? t('degraded.enabling') : t('degraded.enable')}
          </button>
        </div>
      )}

      <div className={threadClass}>
        {/* Inline: the thread eases in once while the composer card morphs into
            place below — conversation switches keep it mounted (no re-fade). */}
        <motion.div
          ref={scrollRef}
          onScroll={onMessagesScroll}
          initial={inline ? { opacity: 0, y: 8 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: 'easeOut' }}
          className="flex-1 space-y-5 overflow-y-auto px-4 py-4"
        >
          {messages.length === 0 && !isStreaming && (
            <div className="flex h-full flex-col items-center justify-center text-center text-foreground/50">
              <Bot className="mb-2 h-8 w-8 text-accent-primary/60" />
              <p className="text-sm font-medium text-foreground/70">{emptyTitle}</p>
              <p className="mt-1 max-w-[280px] text-xs">{t('emptyHint')}</p>
            </div>
          )}
          {messages.map((m, i) => (
            <AgentMessage
              key={m.id}
              role={m.role}
              content={m.content}
              // Option chips are clickable only on the newest settled message —
              // a streaming turn suppresses them everywhere.
              isLast={!isStreaming && i === messages.length - 1}
              onPickOption={(option) => void send(option)}
            />
          ))}
          {isStreaming && (
            <div className="space-y-2">
              {smoothed && <AgentMessage role="assistant" content={smoothed} streaming />}
              <AgentActivityChip tool={liveTools.length ? liveTools[liveTools.length - 1].tool : null} />
            </div>
          )}
        </motion.div>

        {inline ? (
          // Docked composer card — same visual language as the EMPTY hero card
          // (rounded glass card, not an edge-to-edge bar) and the morph target
          // of its shared `layoutId`.
          <div className="shrink-0 px-4 pb-4">
            <motion.div
              layoutId="agent-composer-dock"
              transition={{ layout: { type: 'spring', stiffness: 350, damping: 34 } }}
              className="mx-auto w-full max-w-[680px] rounded-2xl border border-border/60 bg-card/90 p-3 shadow-2xl backdrop-blur-xl"
            >
              <AgentComposer />
            </motion.div>
          </div>
        ) : (
          <div className="shrink-0 border-t border-border/50 bg-surface/30 p-3">
            {/* Kanban floating panel: the project selector lives in the panel
                HEADER (next to the Agent title), so the composer hides its own. */}
            <AgentComposer hideProjectSelector />
          </div>
        )}
      </div>
    </div>
  )
}
