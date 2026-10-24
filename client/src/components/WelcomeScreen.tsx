import { useTranslation, Trans } from 'react-i18next'
import { FolderOpen, GraduationCap, Terminal } from 'lucide-react'
import { Button } from './ui/button'
import { FEATURE_JIRA, FEATURE_MCP, FEATURE_AGENT_CHAT, FEATURE_LOCAL_ENGINES } from '../lib/feature-flags'

interface WelcomeScreenProps {
  onAddProject: () => void
  /** Re-open the platform tour (onboarding wizard). Hidden when omitted. */
  onReplayTour?: () => void
}

export function WelcomeScreen({ onAddProject, onReplayTour }: WelcomeScreenProps) {
  const { t } = useTranslation('setup')
  const hints = [
    FEATURE_JIRA && 'welcome.jiraHint',
    FEATURE_MCP && 'welcome.mcpHint',
    FEATURE_AGENT_CHAT && 'welcome.agentChatHint',
    FEATURE_LOCAL_ENGINES && 'welcome.localEnginesHint',
  ].filter((key): key is string => Boolean(key))

  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[400px] gap-6 px-8 text-center">
      <div className="w-14 h-14 rounded-2xl bg-muted/50 flex items-center justify-center">
        <Terminal className="w-7 h-7 text-muted-foreground" aria-hidden />
      </div>

      <div className="space-y-2">
        <h2 className="text-base font-semibold">
          <Trans
            t={t}
            i18nKey="welcome.title"
            components={{ spec: <span className="text-accent-primary" />, rails: <span className="text-accent-secondary" /> }}
          />
        </h2>
        <p className="text-sm text-muted-foreground max-w-sm">
          {t('welcome.description')}
        </p>
      </div>

      <div className="flex flex-col items-center gap-2">
        <Button onClick={onAddProject} size="sm" className="gap-2">
          <FolderOpen className="w-3.5 h-3.5" aria-hidden />
          {t('welcome.addFirstProject')}
        </Button>
        {onReplayTour && (
          <Button onClick={onReplayTour} size="sm" variant="ghost" className="gap-2 text-muted-foreground">
            <GraduationCap className="w-3.5 h-3.5" aria-hidden />
            {t('welcome.replayTour')}
          </Button>
        )}
      </div>

      {hints.length > 0 && (
        <ul className="max-w-sm space-y-1 text-xs text-muted-foreground">
          {hints.map((key) => (
            <li key={key}>{t(key)}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
