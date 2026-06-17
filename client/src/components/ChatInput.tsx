import { useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { cn } from '../lib/utils'
import type { ProviderId } from '../lib/provider-capabilities'

const CLAUDE_MODEL_OPTIONS = [
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
]

const CODEX_MODEL_OPTIONS = [
  { value: 'gpt-5.5', label: 'GPT-5.5' },
  { value: 'gpt-5.4', label: 'GPT-5.4' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
  { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
]

const GEMINI_MODEL_OPTIONS = [
  { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
  { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)' },
  { value: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite' },
  { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
]

// Per-provider model options; unknown provider falls back to Claude's list.
const MODEL_OPTIONS_BY_PROVIDER: Record<string, { value: string; label: string }[]> = {
  claude: CLAUDE_MODEL_OPTIONS,
  codex: CODEX_MODEL_OPTIONS,
  gemini: GEMINI_MODEL_OPTIONS,
}

interface ChatInputProps {
  conversationId: string
  model: string
  hasMessages: boolean
  isStreaming: boolean
  provider?: ProviderId
  onSend: (conversationId: string, text: string) => void
  onAbort: (conversationId: string) => void
  onModelChange: (model: string) => void
}

export function ChatInput({
  conversationId,
  model,
  hasMessages,
  isStreaming,
  provider = 'claude',
  onSend,
  onAbort,
  onModelChange,
}: ChatInputProps) {
  const { t } = useTranslation('chat')
  const MODEL_OPTIONS = MODEL_OPTIONS_BY_PROVIDER[provider] ?? CLAUDE_MODEL_OPTIONS
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  function handleSend() {
    const trimmed = text.trim()
    if (!trimmed || isStreaming) return
    onSend(conversationId, trimmed)
    setText('')
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  function handleInput() {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    // Clamp to ~4 lines (line-height ~20px)
    el.style.height = `${Math.min(el.scrollHeight, 80)}px`
  }

  return (
    <div className="border-t border-border/30 p-2">
      {/* Model selector */}
      <div className="mb-1.5 flex items-center justify-between">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={hasMessages ? 'cursor-not-allowed' : undefined}>
              <select
                value={model}
                disabled={hasMessages}
                className={cn(
                  'rounded bg-transparent text-[10px] text-muted-foreground outline-none',
                  'border border-border/20 px-1.5 py-0.5',
                  hasMessages && 'opacity-50 pointer-events-none'
                )}
                onChange={(e) => onModelChange(e.target.value)}
              >
                {MODEL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value} className="bg-background">
                    {opt.label}
                  </option>
                ))}
              </select>
            </span>
          </TooltipTrigger>
          {hasMessages && (
            <TooltipContent side="top">
              {t('input.modelLocked')}
            </TooltipContent>
          )}
        </Tooltip>
        {isStreaming && (
          <Button
            size="sm"
            variant="ghost"
            className="h-5 px-1.5 text-[10px] text-destructive hover:text-destructive"
            onClick={() => onAbort(conversationId)}
          >
            {t('input.stop')}
          </Button>
        )}
      </div>

      {/* Text input row */}
      <div className="flex items-end gap-1.5">
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          disabled={isStreaming}
          placeholder={t('input.placeholder')}
          className={cn(
            'flex-1 resize-none rounded-md border border-border/30 bg-background/60',
            'px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground',
            'focus:outline-none focus:ring-1 focus:ring-accent-primary/50',
            'disabled:opacity-50',
            'max-h-[80px] overflow-y-auto'
          )}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
        />
        <Button
          size="sm"
          variant="default"
          disabled={!text.trim() || isStreaming}
          className="h-7 shrink-0 px-2.5 text-xs"
          onClick={handleSend}
        >
          {t('input.send')}
        </Button>
      </div>
    </div>
  )
}
