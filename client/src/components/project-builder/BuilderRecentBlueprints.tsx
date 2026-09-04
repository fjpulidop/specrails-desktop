import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDistanceToNow } from 'date-fns'
import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, Check, History, Layers, Loader2, Play, Trash2, X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { getDateFnsLocale } from '../../lib/i18n'
import type { RecentBlueprint } from '../../hooks/useBuilderSession'

// "Continue where you left off" (harden-project-builder-snapshots): the
// durable answer to a closed panel, a crash, or a refresh mid-blueprint. The
// snapshot now lives in desktop.sqlite, so an unfinished Builder conversation
// can be picked up with its transcript, its last accepted blueprint, and its
// resumable provider session. Rendered under the hero composer only while the
// session is still empty; each row is a one-click resume with a two-step
// inline discard (trash → ✓/✕) so nothing is deleted by a stray click.

interface BuilderRecentBlueprintsProps {
  items: RecentBlueprint[]
  loading: boolean
  disabled?: boolean
  onResume: (id: string) => void
  onDiscard: (id: string) => void
}

function relativeTime(iso: string): string {
  const ms = Date.parse(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z')
  if (!Number.isFinite(ms)) return ''
  return formatDistanceToNow(new Date(ms), { addSuffix: true, locale: getDateFnsLocale() })
}

export function BuilderRecentBlueprints({ items, loading, disabled = false, onResume, onDiscard }: BuilderRecentBlueprintsProps) {
  const { t } = useTranslation('builder')
  const [confirmId, setConfirmId] = useState<string | null>(null)

  if (!loading && items.length === 0) return null

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: 'easeOut', delay: 0.08 }}
      className="mt-4 w-full rounded-2xl border border-border/50 bg-card/70 p-3 shadow-lg backdrop-blur-xl"
      data-testid="builder-recent"
      aria-label={t('recent.title')}
    >
      <div className="mb-2 flex items-center gap-2 px-1">
        <History className="h-3.5 w-3.5 text-accent-secondary" aria-hidden />
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t('recent.title')}</h3>
        {loading && <Loader2 className="ml-auto h-3 w-3 animate-spin text-muted-foreground/60" aria-hidden />}
      </div>
      <ul className="space-y-1">
        <AnimatePresence initial={false}>
          {items.map((item) => {
            const name = item.productName || item.title || t('recent.untitled')
            const confirming = confirmId === item.id
            return (
              <motion.li
                key={item.id}
                layout
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, height: 0 }}
                className={cn(
                  'group flex items-center gap-2 rounded-xl border border-transparent px-2.5 py-2 transition-colors',
                  'hover:border-border/60 hover:bg-surface/60',
                )}
                data-testid={`builder-recent-${item.id}`}
              >
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onResume(item.id)}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left disabled:opacity-50"
                  data-testid={`builder-recent-resume-${item.id}`}
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-primary/10 text-accent-primary">
                    <Play className="h-3.5 w-3.5" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">{name}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
                      {item.platform && <span>{item.platform}</span>}
                      <span className="inline-flex items-center gap-1">
                        <Layers className="h-2.5 w-2.5" aria-hidden />
                        {item.specCount > 0
                          ? item.specsComplete
                            ? t('recent.specsComplete', { count: item.specCount })
                            : t('recent.specsInProgress', { count: item.specCount })
                          : t('recent.dimensions', { filled: item.dimensionsFilled, total: 5 })}
                      </span>
                      {item.pendingIssue && (
                        <span className="inline-flex items-center gap-1 text-accent-warning" data-testid="builder-recent-pending-issue">
                          <AlertTriangle className="h-2.5 w-2.5" aria-hidden />
                          {t('recent.pendingIssue')}
                        </span>
                      )}
                      {item.updatedAt && <span className="opacity-80">{relativeTime(item.updatedAt)}</span>}
                    </span>
                  </span>
                </button>
                <div className="flex shrink-0 items-center gap-0.5">
                  {confirming ? (
                    <>
                      <button
                        type="button"
                        onClick={() => { setConfirmId(null); onDiscard(item.id) }}
                        aria-label={t('recent.discardConfirm')}
                        title={t('recent.discardConfirm')}
                        className="rounded-md p-1 text-destructive hover:bg-destructive/10"
                        data-testid={`builder-recent-discard-confirm-${item.id}`}
                      >
                        <Check className="h-3.5 w-3.5" aria-hidden />
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmId(null)}
                        aria-label={t('recent.discardCancel')}
                        title={t('recent.discardCancel')}
                        className="rounded-md p-1 text-muted-foreground hover:bg-surface"
                        data-testid={`builder-recent-discard-cancel-${item.id}`}
                      >
                        <X className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmId(item.id)}
                      aria-label={t('recent.discard')}
                      title={t('recent.discard')}
                      className="rounded-md p-1 text-muted-foreground/40 opacity-0 transition-opacity hover:bg-surface hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                      data-testid={`builder-recent-discard-${item.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  )}
                </div>
              </motion.li>
            )
          })}
        </AnimatePresence>
      </ul>
    </motion.section>
  )
}
