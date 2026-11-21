import { useTranslation } from 'react-i18next'
import { useMergePreview } from '../../hooks/useMergePreview'
import { MergePreviewView } from '../MergePreviewLine'

/** Review packet section: the delivery's merge preview in full (clean and unknown included). */
export function PacketMergePreview({ deliveryId }: { deliveryId: string | null | undefined }) {
  const { t } = useTranslation('dashboard')
  const preview = useMergePreview(deliveryId)
  if (!preview) return null
  return (
    <section className="rounded-lg border border-border bg-card p-4" data-testid="packet-merge-preview" aria-labelledby="packet-merge-preview-title">
      <h2 id="packet-merge-preview-title" className="mb-2 text-sm font-medium text-foreground">{t('mergePreview.title')}</h2>
      <MergePreviewView preview={preview} detailed />
    </section>
  )
}
