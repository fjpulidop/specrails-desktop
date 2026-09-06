import { ArrowDownLeft, ExternalLink, LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAgentChat } from '../../context/AgentChatContext'
import { useMissionWindows } from '../../context/MissionWindowsContext'

export function MissionWindowAction() {
  const { t } = useTranslation('agent')
  const { active } = useAgentChat()
  const windows = useMissionWindows()
  if (!windows.available || !active) return null
  const secondary = windows.current?.conversationId === active.id
  const pending = windows.isPending(active.id)
  const label = t(secondary ? 'window.attach' : 'window.detach')
  return <button type="button" data-agent-interactive disabled={pending} title={label} aria-label={label}
    className="rounded-md p-1.5 text-foreground/60 hover:bg-surface hover:text-foreground disabled:opacity-40"
    onClick={() => { void (secondary ? windows.attach() : windows.detach(active.pinned_project_id, active.id)) }}>
    {pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : secondary ? <ArrowDownLeft className="h-4 w-4" /> : <ExternalLink className="h-4 w-4" />}
  </button>
}

export function MissionWindowError() {
  const { t } = useTranslation('agent')
  const { error, clearError } = useMissionWindows()
  if (!error) return null
  return <div role="alert" className="flex items-center gap-3 border-b border-border bg-destructive/10 px-4 py-2 text-sm">
    <span className="flex-1">{t('window.failed')} {error}</span>
    <button type="button" onClick={clearError} className="rounded px-2 py-1 hover:bg-muted">{t('window.dismiss')}</button>
  </div>
}
