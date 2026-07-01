import { useTranslation, Trans } from 'react-i18next'
import { FolderOpen, Terminal } from 'lucide-react'
import { Button } from './ui/button'
import { FEATURE_JIRA, FEATURE_MCP, FEATURE_AGENT_CHAT } from '../lib/feature-flags'

interface WelcomeScreenProps {
  onAddProject: () => void
}

export function WelcomeScreen({ onAddProject }: WelcomeScreenProps) {
  const { t } = useTranslation('setup')
  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[400px] gap-6 px-8 text-center">
      <div className="w-14 h-14 rounded-2xl bg-muted/50 flex items-center justify-center">
        <Terminal className="w-7 h-7 text-muted-foreground" />
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
        {FEATURE_JIRA && (
          <p className="text-xs text-muted-foreground/80 max-w-sm">
            {t('welcome.jiraHint')}
          </p>
        )}
        {FEATURE_MCP && (
          <p className="text-xs text-muted-foreground/80 max-w-sm">
            {t('welcome.mcpHint')}
          </p>
        )}
        {FEATURE_AGENT_CHAT && (
          <p className="text-xs text-muted-foreground/80 max-w-sm">
            {t('welcome.agentChatHint')}
          </p>
        )}
      </div>

      <Button onClick={onAddProject} size="sm" className="gap-2">
        <FolderOpen className="w-3.5 h-3.5" />
        {t('welcome.addFirstProject')}
      </Button>
    </div>
  )
}
