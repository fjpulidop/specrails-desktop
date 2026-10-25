import { useTranslation } from 'react-i18next'
import { Inbox } from 'lucide-react'
import { inboxAriaShortcut, inboxShortcutLabel } from '../../../lib/keyboard-label'
import { cn } from '../../../lib/utils'
import { useInbox } from '../context/InboxContext'

/**
 * Title-bar Inbox button with the count of what needs the person. Renders
 * nothing outside the main window (no inbox there). No-drag, like its
 * neighbours in the title bar.
 */
export function InboxButton() {
  const { t } = useTranslation('inbox')
  const inbox = useInbox()
  if (!inbox) return null
  const { count, isOpen, toggleInbox } = inbox
  const label = count > 0 ? t('button.withCount', { count }) : t('button.empty')
  const shortcut = inboxShortcutLabel()
  return (
    <button
      type="button"
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={isOpen}
      aria-keyshortcuts={inboxAriaShortcut()}
      title={t('button.title', { label, shortcut })}
      data-testid="inbox-button"
      onClick={toggleInbox}
      className={cn(
        'relative flex h-6 w-7 shrink-0 items-center justify-center rounded focus-visible:outline focus-visible:outline-ring',
        isOpen ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
      )}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <Inbox className="h-4 w-4" aria-hidden />
      {count > 0 && (
        <span
          data-testid="inbox-badge"
          aria-hidden
          className="absolute -right-0.5 -top-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-pill bg-foreground px-1 text-caption tabular-nums text-background"
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  )
}
