import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, SendHorizontal } from 'lucide-react'
import { Button } from '../../../../../components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../../../components/ui/select'
import { formatLineRange, type LineSelection } from '../../../lib/changes-model'

export interface AskTicketOption { ticketId: number; label: string }

/**
 * "Ask agent to change this": a note on the selected lines. Submitting files it
 * as a spec addendum (the existing carrier), so the next run on the spec is
 * briefed with it; nothing here talks to a person.
 */
export function AskAgentForm({
  path, selection, tickets, initialNote, busy, onSubmit, onCancel,
}: {
  path: string | null
  selection: LineSelection | null
  tickets: readonly AskTicketOption[]
  initialNote?: string
  busy: boolean
  onSubmit: (ticketId: number, note: string) => void
  onCancel: () => void
}) {
  const { t } = useTranslation(['packet', 'common'])
  const [note, setNote] = useState(initialNote ?? '')
  const [ticketId, setTicketId] = useState<number>(tickets[0]?.ticketId ?? 0)
  const noteRef = useRef<HTMLTextAreaElement>(null)
  const noteId = useId()
  useEffect(() => { noteRef.current?.focus() }, [])
  const canSubmit = note.trim().length > 0 && ticketId > 0 && !busy

  return (
    <form
      className="flex flex-col gap-2 rounded-card border border-border/70 bg-background-deep/40 p-3"
      data-testid="changes-ask-form"
      onSubmit={(event) => { event.preventDefault(); if (canSubmit) onSubmit(ticketId, note) }}
    >
      <label htmlFor={noteId} className="text-label text-foreground">
        {t('packet:changes.ask.title')} {path ? <code className="font-mono text-caption text-muted-foreground">{path}{selection ? `:${formatLineRange(selection)}` : ''}</code> : null}
      </label>
      <textarea
        id={noteId}
        ref={noteRef}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canSubmit) { event.preventDefault(); onSubmit(ticketId, note) } }}
        rows={3}
        placeholder={t('packet:changes.ask.placeholder')}
        className="resize-y rounded-control border border-border bg-surface px-2 py-1.5 text-body text-foreground placeholder:text-muted-foreground"
      />
      {tickets.length > 1 ? (
        <div className="flex items-center gap-2 text-caption text-muted-foreground">
          <span id={`${noteId}-ticket`}>{t('packet:changes.ask.ticket')}</span>
          <Select value={String(ticketId)} onValueChange={(value) => setTicketId(Number(value))}>
            <SelectTrigger aria-labelledby={`${noteId}-ticket`} className="h-7 w-auto min-w-[10rem] text-caption">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {tickets.map((ticket) => <SelectItem key={ticket.ticketId} value={String(ticket.ticketId)}>{ticket.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={!canSubmit} className="gap-1.5" data-testid="changes-ask-submit">
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <SendHorizontal className="size-4" aria-hidden />}
          {t('packet:changes.ask.submit')}
        </Button>
        <button type="button" onClick={onCancel} className="rounded-control border border-border px-3 py-1.5 text-body text-foreground hover:bg-surface">
          {t('common:actions.cancel')}
        </button>
        <span className="text-caption text-muted-foreground">{t('packet:changes.ask.hint')}</span>
      </div>
    </form>
  )
}
