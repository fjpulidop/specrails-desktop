import { useState, useRef, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { Bot, X, Plus, SendHorizontal, ShieldAlert, Maximize2, Minimize2, History } from 'lucide-react'
import type { CSSProperties } from 'react'
import { useAgentChat } from '../../context/AgentChatContext'
import { useMovableResizableModal } from '../../hooks/useMovableResizableModal'
import { useSmoothStream } from '../explore-spec/useSmoothStream'
import { ResizeGrips } from '../ui/ResizeGrips'
import { AgentProjectSelector } from './AgentProjectSelector'
import { AgentTierChip } from './AgentTierChip'
import { AgentActivityChip } from './AgentActivityChip'
import { AgentMessage } from './AgentMessage'
import { AgentModelSelector } from './AgentModelSelector'

const PROVIDERS = ['claude', 'codex', 'gemini'] as const

/** The floating, movable+resizable, non-modal agent chat panel (design D1/D3). */
export function AgentChatPanel() {
  const { t } = useTranslation('agent')
  const {
    active, messages, streamingText, isStreaming, liveTools,
    mcpEnabled, enablingMcp, enableMcpServer,
    minimize, send, cycleTier, setProvider, setModel, setPinnedProject, newConversation,
  } = useAgentChat()
  const [input, setInput] = useState('')
  const [maximized, setMaximized] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const { panelRef, panelStyle, headerHandleProps, resizeHandles } = useMovableResizableModal({
    enabled: true,
    allowMove: true,
    minWidth: 400,
    minHeight: 420,
    anchorFromCurrentRect: true, // bottom-right panel — don't jump to center on first drag
    persistKey: 'specrails-desktop:agent-panel-geom', // reopen where you left it
  })

  // When maximized, fill the viewport (minus a small inset) and ignore the
  // dragged position/size; restoring returns to the previous floating layout.
  const MAXIMIZED_STYLE: CSSProperties = { position: 'fixed', inset: 12, width: 'auto', height: 'auto', maxWidth: 'none', maxHeight: 'none' }

  const smoothed = useSmoothStream(streamingText, isStreaming)

  // Stick-to-bottom: only auto-scroll while the user is already near the bottom.
  // If they scroll up to read, DON'T yank them back on every streamed frame
  // (that "fights" the scroll and makes text jitter). Returning to the bottom
  // re-arms the follow.
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

  // ── Prompt history (shell-style): ↑/↓ recalls previous prompts when empty ────
  const [histIndex, setHistIndex] = useState<number | null>(null)
  const inHistory = histIndex !== null
  const history = useMemo(() => messages.filter((m) => m.role === 'user').map((m) => m.content), [messages])

  const submit = () => {
    if (!input.trim()) return
    void send(input)
    setInput('')
    setHistIndex(null)
  }

  const recall = (i: number) => {
    setHistIndex(i)
    setInput(history[i])
  }

  const onComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
      return
    }
    if (e.key === 'ArrowUp') {
      // Enter history from an empty box, then step to older prompts.
      if (!inHistory && input === '' && history.length > 0) {
        e.preventDefault()
        recall(history.length - 1)
      } else if (inHistory) {
        e.preventDefault()
        recall(Math.max(0, histIndex - 1))
      }
      return
    }
    if (e.key === 'ArrowDown' && inHistory) {
      e.preventDefault()
      if (histIndex < history.length - 1) recall(histIndex + 1)
      else {
        setHistIndex(null)
        setInput('')
      }
      return
    }
    // ←/→ while browsing history commits the recalled text to normal edit mode
    // (the caret then moves normally into the text).
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && inHistory) {
      setHistIndex(null)
    }
  }

  // Shift+Tab anywhere in the panel (incl. the composer) cycles the tier ladder,
  // mirroring Claude Code — intercept it so the browser doesn't move focus.
  const onPanelKeyDown = (e: React.KeyboardEvent) => {
    if (e.shiftKey && (e.key === 'Tab' || e.code === 'Tab')) {
      e.preventDefault()
      e.stopPropagation()
      void cycleTier()
    }
  }

  return (
    <>
    <motion.div
      ref={panelRef}
      initial={{ opacity: 0, scale: 0.85, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.34, 1.56, 0.64, 1] }}
      style={maximized ? MAXIMIZED_STYLE : panelStyle}
      role="dialog"
      aria-label={t('title')}
      onKeyDown={onPanelKeyDown}
      className={`fixed z-[60] flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/90 shadow-2xl backdrop-blur-xl ${
        maximized ? '' : 'bottom-4 right-4 h-[78vh] max-h-[94vh] w-[520px] max-w-[92vw]'
      }`}
    >
      {/* ── Header (drag band): just identity + window controls → maximum oxygen ── */}
      <div
        {...(maximized ? {} : headerHandleProps)}
        onDoubleClick={() => setMaximized((m) => !m)}
        className={`flex shrink-0 items-center gap-2 border-b border-border/50 bg-surface/40 px-3 py-2 ${maximized ? '' : 'cursor-grab'}`}
      >
        <Bot className="h-4 w-4 text-accent-primary" />
        <AgentProjectSelector pinnedProjectId={active?.pinned_project_id ?? null} onSelect={(id) => void setPinnedProject(id)} />
        <div className="ml-auto flex items-center gap-1.5">
          <button type="button" onClick={() => void newConversation()} title={t('newConversation')} data-agent-interactive className="rounded-md p-1 text-foreground/60 hover:bg-surface hover:text-foreground">
            <Plus className="h-4 w-4" />
          </button>
          <button type="button" onClick={() => setMaximized((m) => !m)} aria-label={maximized ? t('restore') : t('maximize')} title={maximized ? t('restore') : t('maximize')} data-agent-interactive className="rounded-md p-1 text-foreground/60 hover:bg-surface hover:text-foreground">
            {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
          <button type="button" onClick={minimize} aria-label={t('minimize')} title={t('minimize')} data-agent-interactive className="rounded-md p-1 text-foreground/60 hover:bg-surface hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* ── Degraded banner ── */}
      {!mcpEnabled && (
        <div className="flex items-center gap-2 border-b border-border/50 bg-accent-warning/10 px-3 py-2 text-xs text-foreground">
          <ShieldAlert className="h-4 w-4 shrink-0 text-accent-warning" />
          <span className="flex-1">{t('degraded.body')}</span>
          <button type="button" onClick={() => void enableMcpServer()} disabled={enablingMcp} className="rounded-md bg-accent-primary px-2 py-1 text-xs font-medium text-white disabled:opacity-60">
            {enablingMcp ? t('degraded.enabling') : t('degraded.enable')}
          </button>
        </div>
      )}

      {/* ── Messages ── */}
      <div ref={scrollRef} onScroll={onMessagesScroll} className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {messages.length === 0 && !isStreaming && (
          <div className="flex h-full flex-col items-center justify-center text-center text-foreground/50">
            <Bot className="mb-2 h-8 w-8 text-accent-primary/60" />
            <p className="text-sm font-medium text-foreground/70">{t('emptyTitle')}</p>
            <p className="mt-1 max-w-[280px] text-xs">{t('emptyHint')}</p>
          </div>
        )}
        {messages.map((m) => (
          <AgentMessage key={m.id} role={m.role} content={m.content} />
        ))}
        {isStreaming && (
          <div className="space-y-2">
            {smoothed && <AgentMessage role="assistant" content={smoothed} streaming />}
            {/* Status chip pinned at the very bottom of the conversation so the
                current state is always the last thing you read. */}
            <AgentActivityChip tool={liveTools.length ? liveTools[liveTools.length - 1].tool : null} />
          </div>
        )}
      </div>

      {/* ── Composer (with the provider · model · tier controls right above it) ── */}
      <div className="shrink-0 border-t border-border/50 bg-surface/30 p-3">
        <div className="mb-2 flex items-center gap-2">
          <select
            value={active?.provider ?? 'claude'}
            onChange={(e) => void setProvider(e.target.value)}
            data-agent-interactive
            aria-label={t('provider.label')}
            className="rounded-md border border-border/50 bg-surface/60 px-2 py-1 text-xs text-foreground outline-none hover:bg-surface"
          >
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>{t(`provider.${p}`)}</option>
            ))}
          </select>
          <AgentModelSelector
            provider={active?.provider ?? 'claude'}
            model={active?.model ?? null}
            onSelect={(m) => void setModel(m)}
          />
          <div className="ml-auto">
            <AgentTierChip level={active?.tier_level ?? 0} onCycle={() => void cycleTier()} />
          </div>
        </div>
        {inHistory && (
          <div className="mb-1 flex items-center gap-1.5 px-1 text-[11px] text-foreground/50">
            <History className="h-3 w-3" />
            {t('history.hint')}
          </div>
        )}
        <div className={`flex items-end gap-2 rounded-xl border bg-background/60 px-3 py-2 ${inHistory ? 'border-accent-info/40' : 'border-border/60'}`}>
          <textarea
            value={input}
            onChange={(e) => {
              if (inHistory) setHistIndex(null) // typing commits history to edit mode
              setInput(e.target.value)
            }}
            onKeyDown={onComposerKeyDown}
            rows={2}
            placeholder={t('composerPlaceholder')}
            data-agent-interactive
            title={inHistory ? t('history.hint') : undefined}
            className={`min-h-[3.25rem] max-h-64 flex-1 resize-y bg-transparent text-sm outline-none placeholder:text-foreground/40 ${
              inHistory ? 'italic text-foreground/50' : 'text-foreground'
            }`}
          />
          <button
            type="button"
            onClick={submit}
            disabled={!input.trim()}
            aria-label={t('send')}
            className="rounded-lg bg-accent-primary p-1.5 text-white transition-opacity disabled:opacity-40"
          >
            <SendHorizontal className="h-4 w-4" />
          </button>
        </div>
      </div>

      </motion.div>

      {/* Resize grips live OUTSIDE the panel: the panel's backdrop-blur/transform
          create a containing block that would trap the grips' `position: fixed`
          inside it (they'd appear over the conversation). This viewport-fixed
          overlay sits above the panel; only the grips capture pointer events. */}
      {!maximized && (
        <div className="pointer-events-none fixed inset-0 z-[61] [&>*]:pointer-events-auto">
          <ResizeGrips handles={resizeHandles} />
        </div>
      )}
    </>
  )
}

