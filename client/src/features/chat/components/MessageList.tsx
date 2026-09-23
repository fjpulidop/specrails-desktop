import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { MessageSquare } from 'lucide-react'
import { MessageBubble } from './MessageBubble'
import type { ChatMessage } from '../../../types'
import type { DesktopProject } from '../../../hooks/useDesktop'

const SUGGESTION_KEYS = [
  'currentStatus',
  'recentFailures',
  'testsToRun',
  'mainArchitecture',
] as const

interface MessageListProps {
  messages: ChatMessage[]
  streamingText: string
  isStreaming: boolean
  project?: DesktopProject
  onConfirmCommand: (command: string) => void
  onDismissCommand: (command: string) => void
  onSuggestion?: (text: string) => void
}

export function MessageList({
  messages,
  streamingText,
  isStreaming,
  project,
  onConfirmCommand,
  onDismissCommand,
  onSuggestion,
}: MessageListProps) {
  const { t } = useTranslation('chat')
  const sentinelRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const userScrolledRef = useRef(false)

  // Detect manual scroll-up
  function handleScroll() {
    const el = containerRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    userScrolledRef.current = distanceFromBottom > 100
  }

  // Auto-scroll to bottom when messages or streaming text changes
  useEffect(() => {
    if (userScrolledRef.current) return
    sentinelRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingText])

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto py-2"
      onScroll={handleScroll}
    >
      {messages.length === 0 && !isStreaming && (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-3 py-8 text-center">
          <MessageSquare className="w-5 h-5 text-muted-foreground/30" />
          {project ? (
            <>
              <div className="flex flex-col gap-0.5">
                <p className="text-xs font-medium text-foreground">{project.name}</p>
                <p className="text-[10px] text-muted-foreground/50">{t('messageList.contextLoaded')}</p>
              </div>
              <div className="flex flex-col gap-1.5 w-full">
                {SUGGESTION_KEYS.map((key) => {
                  const s = t(`messageList.suggestions.${key}`)
                  return (
                    <button
                      key={key}
                      className="rounded border border-border/30 px-2.5 py-1.5 text-left text-[11px] text-muted-foreground hover:border-accent-primary/40 hover:text-foreground transition-colors"
                      onClick={() => onSuggestion?.(s)}
                    >
                      {s}
                    </button>
                  )
                })}
              </div>
            </>
          ) : (
            <>
              <p className="text-xs font-medium text-muted-foreground">{t('messageList.noMessages')}</p>
              <p className="text-[11px] text-muted-foreground/60 max-w-[180px]">
                {t('messageList.askAnything')}
              </p>
            </>
          )}
        </div>
      )}

      {messages.map((msg) => (
        <MessageBubble
          key={msg.id}
          message={msg}
          onConfirmCommand={onConfirmCommand}
          onDismissCommand={onDismissCommand}
        />
      ))}

      {isStreaming && streamingText && (
        <div className="flex justify-start px-3 py-1">
          <div className="max-w-[95%] rounded-2xl rounded-bl-sm bg-surface/30 px-3 py-2 text-xs text-foreground whitespace-pre-wrap">
            {streamingText}
          </div>
        </div>
      )}

      {isStreaming && !streamingText && (
        <div className="flex justify-start px-3 py-1" data-testid="thinking-indicator">
          <div className="rounded-2xl rounded-bl-sm bg-surface/30 px-3 py-2 flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:0ms]" />
            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:150ms]" />
            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:300ms]" />
          </div>
        </div>
      )}

      <div ref={sentinelRef} />
    </div>
  )
}
