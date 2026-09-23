import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'

interface ChatHeaderProps {
  title: string | null
  projectName?: string
  canCreateNew: boolean
  isMaximized: boolean
  onToggle: () => void
  onMaximize: () => void
  onRestore: () => void
  onNewConversation: () => void
  onDeleteConversation: () => void
  hasActiveConversation: boolean
}

export function ChatHeader({
  title,
  projectName,
  canCreateNew,
  isMaximized,
  onToggle,
  onMaximize,
  onRestore,
  onNewConversation,
  onDeleteConversation,
  hasActiveConversation,
}: ChatHeaderProps) {
  const { t } = useTranslation('chat')
  return (
    <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/30 px-2.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-xs font-medium text-foreground">
          {title ?? t('header.fallbackTitle')}
        </span>
        {projectName && (
          <span className="shrink-0 rounded px-1 py-0.5 text-[9px] font-medium bg-accent-primary/15 text-accent-primary/80 leading-none">
            {projectName}
          </span>
        )}
      </div>
      <div className="flex items-center gap-0.5">
        <Button
          size="icon"
          variant="ghost"
          disabled={!canCreateNew}
          title={t('header.newConversation')}
          className="h-6 w-6"
          onClick={onNewConversation}
        >
          <span className="text-sm leading-none">+</span>
        </Button>
        {hasActiveConversation && (
          <Button
            size="icon"
            variant="ghost"
            title={t('header.deleteConversation')}
            className="h-6 w-6 text-muted-foreground hover:text-destructive"
            onClick={onDeleteConversation}
          >
            <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth="1.5">
              <path strokeLinecap="round" d="M2 4h12M5.5 4V2.5h5V4M6 7v5M10 7v5M3 4l.9 8.5a1 1 0 001 .9h6.2a1 1 0 001-.9L13 4" />
            </svg>
          </Button>
        )}
        {isMaximized ? (
          <Button
            size="icon"
            variant="ghost"
            title={t('header.restorePanel')}
            className="h-6 w-6 text-muted-foreground hover:text-foreground"
            onClick={onRestore}
          >
            <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth="1.5">
              <rect x="2" y="5" width="7" height="7" rx="1" />
              <path strokeLinecap="round" d="M7 5V3h6v6h-2" />
            </svg>
          </Button>
        ) : (
          <Button
            size="icon"
            variant="ghost"
            title={t('header.maximizePanel')}
            className="h-6 w-6 text-muted-foreground hover:text-foreground"
            onClick={onMaximize}
          >
            <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth="1.5">
              <rect x="2" y="2" width="12" height="12" rx="1" />
              <path strokeLinecap="round" d="M9 2v4h5M7 14v-4H2" />
            </svg>
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          title={t('header.closeChat')}
          className="h-6 w-6 text-muted-foreground"
          onClick={onToggle}
        >
          <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth="1.5">
            <path strokeLinecap="round" d="M12 4L4 12M4 4l8 8" />
          </svg>
        </Button>
      </div>
    </div>
  )
}
