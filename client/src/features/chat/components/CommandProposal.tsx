import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { cn } from '../../../lib/utils'

interface CommandProposalProps {
  command: string
  onRun: (command: string) => void
  onDismiss: (command: string) => void
}

export function CommandProposal({ command, onRun, onDismiss }: CommandProposalProps) {
  const { t } = useTranslation('addspec')
  const [ran, setRan] = useState(false)

  function handleRun() {
    setRan(true)
    onRun(command)
  }

  return (
    <div className="my-2 rounded-md border border-accent-primary/30 bg-accent-primary/10 p-2.5 text-xs">
      <div className="mb-2 font-medium text-accent-primary">{t('commandProposal.heading')}</div>
      <pre className="mb-2 overflow-x-auto rounded bg-background/60 px-2 py-1 font-mono text-accent-info">
        {command}
      </pre>
      <div className="flex items-center gap-2">
        {ran ? (
          <span className="rounded bg-accent-success/20 px-2 py-0.5 text-accent-success">{t('common:status.queued')}</span>
        ) : (
          <>
            <Button
              size="sm"
              variant="default"
              className={cn('h-6 px-2 text-xs')}
              onClick={handleRun}
            >
              {t('commandProposal.run')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={() => onDismiss(command)}
            >
              {t('commandProposal.dismiss')}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
