import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Ban, Pencil } from 'lucide-react'
import { Button } from '../../../components/ui/button'

/**
 * "Out of scope" (feedback-2026-10 task 3.2): the spec's non-goals, shown
 * under the description and edited one item per line. Controlled: the modal
 * owns the value and saves it with the rest of the ticket.
 */
export function parseNonGoalLines(text: string): string[] {
  const out: string[] = []
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const item = raw.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, '').replace(/\s+/g, ' ').trim()
    if (item && !out.includes(item)) out.push(item)
  }
  return out
}

interface NonGoalsSectionProps {
  value: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
}

export function NonGoalsSection({ value, onChange, disabled }: NonGoalsSectionProps) {
  const { t } = useTranslation('tickets')
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(value.join('\n'))
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!editing) setText(value.join('\n'))
  }, [value, editing])

  useEffect(() => {
    if (editing) textareaRef.current?.focus()
  }, [editing])

  const finish = () => {
    onChange(parseNonGoalLines(text))
    setEditing(false)
  }

  return (
    <section data-testid="ticket-non-goals" aria-labelledby="ticket-non-goals-heading">
      <div className="flex items-center justify-between mb-1.5">
        <span id="ticket-non-goals-heading" className="text-label text-muted-foreground flex items-center gap-1.5">
          <Ban className="w-3 h-3" aria-hidden="true" />
          {t('nonGoals.title')}
        </span>
        {!editing && value.length > 0 && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => setEditing(true)}
            className="text-caption text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1 disabled:opacity-50"
          >
            <Pencil className="w-2.5 h-2.5" />
            {t('common:actions.edit')}
          </button>
        )}
      </div>
      {editing ? (
        <div className="space-y-1.5">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); finish() } }}
            rows={Math.min(8, Math.max(3, text.split('\n').length + 1))}
            aria-label={t('nonGoals.ariaLabel')}
            placeholder={t('nonGoals.placeholder')}
            className="w-full rounded-lg border border-border bg-input px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground resize-y"
          />
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" className="h-6 text-caption" onClick={finish}>
              {t('detailModal.doneEditing')}
            </Button>
            <span className="text-caption text-muted-foreground">{t('nonGoals.onePerLine')}</span>
          </div>
        </div>
      ) : value.length > 0 ? (
        <ul className="rounded-lg border border-border/40 bg-muted/10 px-3 py-2 space-y-1">
          {value.map((item) => (
            <li key={item} className="flex items-start gap-2 text-xs text-foreground">
              <span aria-hidden="true" className="mt-[5px] h-1 w-1 shrink-0 rounded-full bg-muted-foreground/60" />
              <span className="min-w-0 break-words">{item}</span>
            </li>
          ))}
        </ul>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setEditing(true)}
          className="w-full rounded-lg border border-dashed border-border/40 bg-muted/10 px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/20 transition-colors text-left disabled:opacity-50"
        >
          {t('nonGoals.add')}
        </button>
      )}
    </section>
  )
}
