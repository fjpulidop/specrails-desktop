import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowUp, MessageCircleQuestion, RotateCcw } from 'lucide-react'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { Button } from '../../../components/ui/button'
import { RailTrack } from '../../../components/brand/RailTrack'
import { cn } from '../../../lib/utils'
import { askAboutSelection, type SideQuestionTurn } from '../lib/agent-api'
import { MISSION_MARKDOWN_CLASS } from './AgentMessage'

/** Bounds mirrored from the server (server/modules/missions/runtime/mission-side-question.ts). */
const THREAD_ENTRIES = 10
const THREAD_CHARS = 16_000
const QUESTION_CHARS = 4_000
const LONG_SELECTION = 280

/** The newest whole Q&A pairs that fit the server's side-thread bounds. */
export function boundSideThread(thread: readonly SideQuestionTurn[]): SideQuestionTurn[] {
  const kept: SideQuestionTurn[] = []
  let chars = 0
  for (let index = thread.length - 2; index >= 0; index -= 2) {
    const pair = thread.slice(index, index + 2)
    const size = pair.reduce((sum, turn) => sum + turn.content.length, 0)
    if (kept.length + 2 > THREAD_ENTRIES || chars + size > THREAD_CHARS) break
    kept.unshift(...pair)
    chars += size
  }
  return kept
}

export interface MissionAskTarget {
  conversationId: string
  selection: string
  throughMessageId: string
  /** The mission's model label until the first answer names the model used. */
  modelLabel: string
}

/**
 * "Ask about this": a side conversation about selected mission text. Each
 * question is one no-tool provider call with the mission's earlier context.
 * Nothing is stored: closing discards the side thread, and the mission's own
 * conversation and provider session are never touched.
 */
export function MissionAskDialog({ target, onClose }: { target: MissionAskTarget | null; onClose: () => void }) {
  return (
    <Dialog open={!!target} onOpenChange={open => { if (!open) onClose() }}>
      {target && <AskPanel key={`${target.conversationId}:${target.throughMessageId}:${target.selection}`} target={target} />}
    </Dialog>
  )
}

function AskPanel({ target }: { target: MissionAskTarget }) {
  const { t, i18n } = useTranslation('agent')
  const [thread, setThread] = useState<SideQuestionTurn[]>([])
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<{ question: string; message: string } | null>(null)
  const [model, setModel] = useState(target.modelLabel)
  const [expanded, setExpanded] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const inflight = useRef<AbortController | null>(null)

  // Closing aborts an in-flight question; nothing outlives the dialog.
  useEffect(() => () => inflight.current?.abort(), [])
  useEffect(() => {
    const el = body.current
    if (el) el.scrollTop = el.scrollHeight
  }, [thread, pending, error])

  const ask = async (question: string) => {
    if (inflight.current) return
    const controller = new AbortController()
    inflight.current = controller
    setPending(question)
    setError(null)
    try {
      const result = await askAboutSelection(target.conversationId, {
        selection: target.selection,
        throughMessageId: target.throughMessageId,
        question,
        thread: boundSideThread(thread),
        language: i18n.language,
      }, controller.signal)
      if (controller.signal.aborted) return
      setThread(previous => [...previous, { role: 'user', content: question }, { role: 'assistant', content: result.answer }])
      setModel(result.model)
    } catch (caught) {
      if (controller.signal.aborted) return
      setError({ question, message: caught instanceof Error && caught.message ? caught.message : t('ask.failed') })
    } finally {
      if (inflight.current === controller) inflight.current = null
      setPending(null)
      requestAnimationFrame(() => input.current?.focus({ preventScroll: true }))
    }
  }

  const submit = () => {
    if (pending) return
    const question = draft.trim() || t('ask.defaultQuestion')
    setDraft('')
    void ask(question)
  }

  const long = target.selection.length > LONG_SELECTION
  const shownQuestion = pending ?? error?.question ?? null
  return (
    <DialogContent size="wide"
      onOpenAutoFocus={event => { event.preventDefault(); input.current?.focus() }}>
      <DialogHeader icon={<MessageCircleQuestion />}>
        <DialogTitle>{t('ask.title')}</DialogTitle>
        <DialogDescription>{t('ask.description')}</DialogDescription>
      </DialogHeader>
      <DialogBody ref={body} className="flex flex-col gap-4">
        <figure className="rounded-card border border-border bg-surface px-3 py-2">
          <figcaption className="text-label text-muted-foreground">{t('ask.selection')}</figcaption>
          <blockquote id="ask-selection" className={cn('mt-1 whitespace-pre-wrap text-body text-foreground [overflow-wrap:anywhere]', long && !expanded && 'line-clamp-4')}>
            {target.selection}
          </blockquote>
          {long && (
            <button type="button" aria-expanded={expanded} aria-controls="ask-selection"
              className="mt-1 rounded-control text-label text-accent-info hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
              onClick={() => setExpanded(value => !value)}>
              {expanded ? t('ask.showLess') : t('ask.showAll')}
            </button>
          )}
        </figure>
        <div role="log" aria-label={t('ask.thread')} className="flex flex-col gap-4">
          {thread.map((turn, index) => <Turn key={index} turn={turn} />)}
          {shownQuestion && <Turn turn={{ role: 'user', content: shownQuestion }} />}
        </div>
        {pending && (
          <p role="status" className="flex items-center gap-2 text-body text-muted-foreground">
            <span aria-hidden className="w-16 shrink-0"><RailTrack running /></span>{t('ask.running')}
          </p>
        )}
        {error && !pending && (
          <div role="alert" className="flex flex-col items-start gap-2 rounded-card border border-destructive/40 px-3 py-2">
            <p className="text-body text-destructive [overflow-wrap:anywhere]">{error.message}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => void ask(error.question)}>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />{t('ask.retry')}
            </Button>
          </div>
        )}
      </DialogBody>
      <div className="flex shrink-0 items-end gap-2 border-t border-border/40 px-5 py-3">
        <textarea
          ref={input}
          rows={2}
          value={draft}
          maxLength={QUESTION_CHARS}
          aria-label={t('ask.inputLabel')}
          placeholder={thread.length ? t('ask.placeholderFollowUp') : t('ask.placeholder')}
          className="min-h-[40px] max-h-40 flex-1 resize-none rounded-control border border-input bg-background px-3 py-2 text-body text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <Button type="button" size="icon" disabled={!!pending} aria-label={t('ask.send')} onClick={submit}>
          <ArrowUp className="h-4 w-4" aria-hidden />
        </Button>
      </div>
      <DialogFooter start={<p className="text-label text-muted-foreground">{thread.length ? t('ask.footer', { model }) : t('ask.footerPending', { model })}</p>} />
    </DialogContent>
  )
}

function Turn({ turn }: { turn: SideQuestionTurn }) {
  const { t } = useTranslation('agent')
  if (turn.role === 'user') {
    return (
      <article aria-label={t('message.you')} className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap rounded-card bg-muted px-3 py-2 text-body text-foreground [overflow-wrap:anywhere]">{turn.content}</p>
      </article>
    )
  }
  return (
    <article aria-label={t('ask.answer')} className={MISSION_MARKDOWN_CLASS}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{turn.content}</ReactMarkdown>
    </article>
  )
}
