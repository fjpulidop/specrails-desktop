import { Terminal as TerminalIcon, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface EmptyTerminalPlaceholderProps {
  onCreate: () => void
}

export function EmptyTerminalPlaceholder({ onCreate }: EmptyTerminalPlaceholderProps) {
  const { t } = useTranslation('terminal')
  return (
    <div className="flex-1 flex items-center justify-center text-center px-6 bg-background-deep">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <TerminalIcon className="h-8 w-8 opacity-50" />
        <p className="text-xs">{t('emptyState.noTerminals')}</p>
        <button
          type="button"
          onClick={onCreate}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs bg-border/30 hover:bg-border/50 hover:text-foreground transition-colors"
        >
          <Plus className="h-3 w-3" /> {t('emptyState.newTerminal')}
        </button>
      </div>
    </div>
  )
}
