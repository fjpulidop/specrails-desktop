import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Attachment } from '../../../types'
import { deleteAttachment, listAttachments } from '../lib/attachments'
import { cn } from '../../../lib/utils'
import { AttachmentPreviewLightbox } from './AttachmentPreviewLightbox'

interface Props {
  ticketKey: string | number
  attachments: Attachment[]
  onChange?: (next: Attachment[]) => void
  className?: string
}

function mergeById(a: Attachment[], b: Attachment[]): Attachment[] {
  const seen = new Set<string>()
  const out: Attachment[] = []
  for (const x of [...a, ...b]) {
    if (seen.has(x.id)) continue
    seen.add(x.id)
    out.push(x)
  }
  return out
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function iconForMime(mime: string): string {
  if (mime.startsWith('image/')) return '🖼'
  if (mime === 'application/pdf') return '📄'
  if (mime === 'text/csv' || mime.includes('spreadsheetml') || mime === 'application/vnd.ms-excel') return '📊'
  if (mime === 'application/json') return '{ }'
  if (mime === 'text/plain' || mime.includes('sql')) return '📝'
  return '📎'
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return iso
  }
}

export function AttachmentsSection({ ticketKey, attachments, onChange, className }: Props) {
  const { t } = useTranslation('attachments')
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState<Attachment | null>(null)

  // Safety net: re-hydrate from server on mount / ticket change.
  // Covers the race where the ticket_created WS message arrives before attachment migration
  // completes server-side, or when viewing a ticket created before the prop was populated.
  useEffect(() => {
    let cancelled = false
    listAttachments(ticketKey)
      .then((fresh) => {
        if (cancelled) return
        const merged = mergeById(attachments, fresh)
        if (merged.length !== attachments.length) onChange?.(merged)
      })
      .catch(() => {})
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketKey])

  if (!attachments || attachments.length === 0) return null

  const sorted = [...attachments].sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1))

  async function handleRemove(a: Attachment) {
    setError(null)
    setRemovingIds((prev) => {
      const next = new Set(prev)
      next.add(a.id)
      return next
    })
    try {
      await deleteAttachment(ticketKey, a.id)
      // brief exit animation delay
      await new Promise((r) => setTimeout(r, 160))
      onChange?.(attachments.filter((x) => x.id !== a.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.removeFailed'))
      setRemovingIds((prev) => {
        const next = new Set(prev)
        next.delete(a.id)
        return next
      })
    }
  }

  return (
    <section className={cn('mt-4', className)} aria-label={t('section.ariaLabel')}>
      <header className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('section.title')}</h3>
        <span className="text-[10px] text-muted-foreground">{t('section.fileCount', { count: sorted.length })}</span>
      </header>
      <ul className="flex flex-col gap-1">
        {sorted.map((a) => {
          const leaving = removingIds.has(a.id)
          return (
            <li
              key={a.id}
              className={cn(
                'flex items-center gap-3 px-2.5 py-2 rounded-md border border-border bg-card/60 hover:bg-card transition-all duration-200',
                leaving && 'opacity-0 scale-95 max-h-0 py-0 border-transparent overflow-hidden',
              )}
            >
              <span aria-hidden className="w-6 text-center text-sm shrink-0">{iconForMime(a.mimeType)}</span>
              <button
                type="button"
                onClick={() => setPreviewing(a)}
                className="flex-1 min-w-0 flex flex-col text-sm text-left hover:text-primary transition-colors"
              >
                <span className="font-medium truncate text-foreground">{a.filename}</span>
                <span className="text-[11px] text-muted-foreground">
                  {formatBytes(a.size)} · {formatDate(a.addedAt)}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setPreviewing(a)}
                className="text-[11px] text-primary hover:underline shrink-0"
              >
                {t('common:actions.open')}
              </button>
              <button
                type="button"
                onClick={() => handleRemove(a)}
                aria-label={t('removeFile', { name: a.filename })}
                disabled={leaving}
                className="w-6 h-6 inline-flex items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
              >
                ×
              </button>
            </li>
          )
        })}
      </ul>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      <AttachmentPreviewLightbox
        ticketKey={ticketKey}
        attachment={previewing}
        onClose={() => setPreviewing(null)}
      />
    </section>
  )
}
