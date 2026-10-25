import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkles } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { formatUsdBand } from '../../../lib/launch-forecast'
import { useActivateSample } from '../hooks/useActivateSample'
import { useSampleStatus } from '../hooks/useSampleStatus'
import { SampleProjectDialog } from './SampleProjectDialog'

/**
 * Welcome-screen entry: "Try it on a sample project" next to "Add your project",
 * with the cost stated up front. Looking around is free; the dollar band is the
 * static, labelled estimate of one cloud run (the exact statement, which knows
 * how the provider is billed, is in the dialog).
 */
export function SampleProjectEntry() {
  const { t, i18n } = useTranslation('onboarding')
  const { status } = useSampleStatus()
  const [open, setOpen] = useState(false)
  const activate = useActivateSample()
  const launch = status?.launch
  const line = !launch
    ? null
    : !launch.ready
      ? t('entry.recordedOnly')
      : launch.preset.local
        ? t('entry.local')
        : t('entry.cost', { usd: formatUsdBand(launch.estimate.usd[0], launch.estimate.usd[1], i18n.language || 'en') })
  return (
    <div className="flex flex-col items-center gap-1.5">
      <Button onClick={() => setOpen(true)} variant="secondary" className="gap-2" data-testid="try-sample">
        <Sparkles className="size-3.5" aria-hidden />
        {t('entry.try')}
      </Button>
      {line && <p className="max-w-xs text-caption text-muted-foreground" data-testid="try-sample-cost">{line}</p>}
      <SampleProjectDialog open={open} onOpenChange={setOpen} status={status} onCreated={activate} />
    </div>
  )
}
