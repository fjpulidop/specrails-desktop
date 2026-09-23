import { useTranslation } from 'react-i18next'
import { MessagesSquare, Sparkles, X } from 'lucide-react'
import type { MinimizedChat, MinimizedChatKind } from '../../context/MinimizedChatsContext'

/** Hard cap on visible label length. CSS truncate handles the visual ellipsis
 *  when the rendered glyph width exceeds the chip, but a JS trim guards
 *  against any case where the toast wrapper's width isn't strictly enforced
 *  (e.g. flex children that overflow before truncate kicks in). */
const MAX_LABEL_CHARS = 42

function trimLabel(label: string): string {
  const flat = label.replace(/\s+/g, ' ').trim()
  if (flat.length <= MAX_LABEL_CHARS) return flat
  return flat.slice(0, MAX_LABEL_CHARS - 1).trimEnd() + '…'
}

/** Visual chip rendered by `MinimizedChatsDock` (a dedicated bottom-left dock,
 *  NOT a sonner toast). The dock supplies the glass-card chrome; this component
 *  owns the icon / label / restore / close layout. */
export function MinimizedChatChip({
  chat,
  projectName,
  onRestore,
  onClose,
}: {
  chat: MinimizedChat
  projectName: string
  onRestore: () => void
  onClose: () => void
}) {
  const { t } = useTranslation('chat')
  const visibleLabel = trimLabel(chat.label)
  return (
    <div
      data-testid={`minimized-chat-chip-${chat.id}`}
      className="grid items-start gap-2 w-full max-w-full"
      style={{ gridTemplateColumns: 'auto minmax(0, 1fr) auto' }}
    >
      <KindIcon kind={chat.kind} />
      <button
        type="button"
        onClick={onRestore}
        className="min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50 rounded overflow-hidden"
        aria-label={t('chip.restore', { label: chat.label })}
        title={chat.label}
      >
        <div className="text-sm font-medium text-foreground truncate">
          {visibleLabel}
        </div>
        <div className="text-[11px] text-muted-foreground mt-0.5 truncate">
          {t('chip.continueEditing', { projectName })}
        </div>
      </button>
      <button
        type="button"
        onClick={onClose}
        className="flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50"
        aria-label={t('chip.close', { label: chat.label })}
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

function KindIcon({ kind }: { kind: MinimizedChatKind }) {
  const { t } = useTranslation('chat')
  const Icon = kind === 'ai-edit' ? Sparkles : MessagesSquare
  return (
    <Icon
      className="w-4 h-4 text-accent-primary flex-shrink-0 mt-0.5"
      aria-label={kind === 'ai-edit' ? t('chip.kindAiEdit') : t('chip.kindExploreSpec')}
    />
  )
}
