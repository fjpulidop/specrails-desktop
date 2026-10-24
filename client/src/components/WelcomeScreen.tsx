import { useTranslation, Trans } from 'react-i18next'
import { FolderOpen, GraduationCap, Plug, MessageSquare, Cpu, GitBranch } from 'lucide-react'
import { RailMark } from './brand/RailMark'
import { Button } from './ui/button'
import { FEATURE_JIRA, FEATURE_MCP, FEATURE_AGENT_CHAT, FEATURE_LOCAL_ENGINES } from '../lib/feature-flags'

interface WelcomeScreenProps {
  onAddProject: () => void
  /** Re-open the platform tour (onboarding wizard). Hidden when omitted. */
  onReplayTour?: () => void
}

export function WelcomeScreen({ onAddProject, onReplayTour }: WelcomeScreenProps) {
  const { t } = useTranslation('setup')
  const hints = (
    [
      FEATURE_JIRA && { key: 'welcome.jiraHint', Icon: GitBranch },
      FEATURE_MCP && { key: 'welcome.mcpHint', Icon: Plug },
      FEATURE_AGENT_CHAT && { key: 'welcome.agentChatHint', Icon: MessageSquare },
      FEATURE_LOCAL_ENGINES && { key: 'welcome.localEnginesHint', Icon: Cpu },
    ] as const
  ).filter((h): h is Exclude<typeof h, false> => Boolean(h))

  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[400px] gap-6 px-8 text-center">
      <RailMark size={72} state="travel" />

      <div className="space-y-2">
        <h2 className="text-headline">
          <Trans
            t={t}
            i18nKey="welcome.title"
            components={{ spec: <span className="text-accent-primary" />, rails: <span className="text-accent-secondary" /> }}
          />
        </h2>
        <p className="text-strong text-foreground/80 max-w-sm">{t('welcome.tagline')}</p>
        <p className="text-caption text-muted-foreground max-w-sm">
          {t('welcome.description')}
        </p>
      </div>

      <div className="flex flex-col items-center gap-2">
        <Button onClick={onAddProject} size="default" className="gap-2">
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
        <ul className="max-w-md space-y-2 text-left text-caption text-muted-foreground">
          {hints.map(({ key, Icon }) => (
            <li key={key} className="flex items-start gap-2.5">
              <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-primary" aria-hidden />
              <span>{t(key)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
