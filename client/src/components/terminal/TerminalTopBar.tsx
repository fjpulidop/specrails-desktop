import { Plus, Trash2, Maximize2, Minimize2, Sparkles, Globe, Code2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { PanelChevronButton } from './PanelChevronButton'
import type { PanelVisibility } from '../../context/TerminalsContext'
import type { ProviderId } from '../../lib/provider-capabilities'

interface TerminalTopBarProps {
  visibility: PanelVisibility
  canCreate: boolean
  hasActive: boolean
  /** CLI to launch from the Sparkles shortcut: 'claude' (default) or 'codex'.
   *  Used for the button label when only one provider is installed. */
  provider?: ProviderId
  /** All installed providers. When >1, clicking the Sparkles shortcut opens a
   *  picker (anchored at the click) instead of launching directly. */
  providers?: readonly string[]
  onCreate: () => void
  /** Receives click coords so a multi-provider picker can anchor to the button. */
  onOpenCli: (anchor?: { x: number; y: number }) => void
  onOpenBrowser: () => void
  onPasteScript: () => void
  pasteScriptDisabled: boolean
  onConfigureBrowser: (anchor: { x: number; y: number }) => void
  onConfigureScript: (anchor: { x: number; y: number }) => void
  onKillActive: () => void
  onToggleMaximize: () => void
  onCollapse: () => void
}

export function TerminalTopBar({
  visibility, canCreate, hasActive, provider = 'claude', providers,
  onCreate, onOpenCli, onOpenBrowser, onPasteScript, pasteScriptDisabled,
  onConfigureBrowser, onConfigureScript,
  onKillActive, onToggleMaximize, onCollapse,
}: TerminalTopBarProps) {
  const { t } = useTranslation('terminal')
  const multiProvider = !!providers && providers.length > 1
  const cliDisplayName = provider === 'codex' ? 'Codex' : 'Claude'
  const maxTerminalsLabel = t('topBar.maxTerminals', { max: 10 })
  const cliLabel = canCreate
    ? (multiProvider ? t('topBar.openCliMulti') : t('topBar.openCli', { cli: cliDisplayName }))
    : maxTerminalsLabel
  return (
    <div
      className={cn(
        'flex items-center justify-between h-7 px-2 shrink-0',
        'bg-background/95 backdrop-blur-sm',
        'border-b border-border/40',
        'text-[10px] uppercase tracking-wide text-muted-foreground select-none',
      )}
    >
      <div className="flex items-center gap-2 pl-1">
        <span className="font-medium text-foreground">{t('topBar.title')}</span>
      </div>
      <div className="flex items-center gap-0.5">
        <ActionButton
          label={cliLabel}
          disabled={!canCreate}
          onClick={(ev) => onOpenCli(ev ? { x: ev.clientX, y: ev.clientY } : undefined)}
        >
          <Sparkles className="h-3.5 w-3.5" />
        </ActionButton>
        <ActionButton
          label={t('topBar.openInBrowser')}
          onClick={onOpenBrowser}
          onContextMenu={(ev) => { ev.preventDefault(); onConfigureBrowser({ x: ev.clientX, y: ev.clientY }) }}
        >
          <Globe className="h-3.5 w-3.5" />
        </ActionButton>
        <ActionButton
          label={pasteScriptDisabled ? t('topBar.pasteScriptNoActive') : t('topBar.pasteScript')}
          disabled={pasteScriptDisabled}
          onClick={onPasteScript}
          onContextMenu={(ev) => { ev.preventDefault(); onConfigureScript({ x: ev.clientX, y: ev.clientY }) }}
        >
          <Code2 className="h-3.5 w-3.5" />
        </ActionButton>
        <ActionButton
          label={canCreate ? t('topBar.newTerminal') : maxTerminalsLabel}
          disabled={!canCreate}
          onClick={onCreate}
        >
          <Plus className="h-3.5 w-3.5" />
        </ActionButton>
        <ActionButton
          label={t('topBar.killActive')}
          disabled={!hasActive}
          onClick={onKillActive}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </ActionButton>
        <ActionButton
          label={visibility === 'maximized' ? t('topBar.restorePanel') : t('topBar.maximizePanel')}
          onClick={onToggleMaximize}
        >
          {visibility === 'maximized'
            ? <Minimize2 className="h-3.5 w-3.5" />
            : <Maximize2 className="h-3.5 w-3.5" />}
        </ActionButton>
        <PanelChevronButton isOpen onClick={onCollapse} />
      </div>
    </div>
  )
}

interface ActionButtonProps {
  label: string
  disabled?: boolean
  onClick: (ev?: React.MouseEvent) => void
  onContextMenu?: (ev: React.MouseEvent) => void
  children: React.ReactNode
}

function ActionButton({ label, disabled, onClick, onContextMenu, children }: ActionButtonProps) {
  return (
    <button
      type="button"
      onClick={(e) => onClick(e)}
      onContextMenu={onContextMenu}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        'inline-flex items-center justify-center h-5 w-6 rounded',
        'text-muted-foreground transition-colors duration-120',
        disabled
          ? 'opacity-40 cursor-not-allowed'
          : 'hover:bg-border/40 hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-primary/60',
      )}
    >
      {children}
    </button>
  )
}
