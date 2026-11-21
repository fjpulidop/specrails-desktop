/**
 * Merge preview of a delivery, as the base stands now: conflicts with the
 * base (the `blocked` look — it cannot merge as it is), siblings it collides
 * with, how many commits the base moved since the branch was cut, or that the
 * change already landed. Compact on cards (nothing when it merges cleanly),
 * detailed in the review packet (also the clean and unknown cases).
 */
import { useTranslation } from 'react-i18next'
import { GitCommitHorizontal } from 'lucide-react'
import { RunStateGlyph } from '../../../components/ui/run-state/run-state-glyph'
import { useMergePreview } from '../hooks/useMergePreview'
import { baseName, mergePreviewRunState, summarize, type DeliveryMergePreview } from '../lib/merge-preview'

const FILES_SHOWN = 3

function fileList(files: string[], total: number, more: (count: number) => string): string {
  const shown = files.slice(0, FILES_SHOWN).join(', ')
  return total > FILES_SHOWN ? `${shown} ${more(total - FILES_SHOWN)}` : shown
}

export function MergePreviewView({ preview, detailed = false, className = '' }: { preview: DeliveryMergePreview | null; detailed?: boolean; className?: string }) {
  const { t } = useTranslation('dashboard')
  if (!preview) return null
  const base = baseName(preview.baseRef)
  const state = mergePreviewRunState(summarize(preview))
  const more = (count: number): string => t('mergePreview.moreFiles', { count })
  const lines: Array<{ key: string; text: string; title?: string }> = []
  if (preview.status === 'conflicts') {
    lines.push({
      key: 'base',
      text: t('mergePreview.conflictsWithBase', { base, count: preview.conflictFileCount, files: fileList(preview.conflictFiles, preview.conflictFileCount, more) }),
      title: preview.conflictFiles.join('\n'),
    })
  }
  for (const sibling of preview.siblings) {
    lines.push({
      key: `sibling-${sibling.deliveryId}`,
      text: t('mergePreview.collidesWithRail', { rail: sibling.railIndex + 1, files: fileList(sibling.files, sibling.fileCount, more) }),
      title: sibling.files.join('\n'),
    })
  }
  if (preview.status === 'already_merged') lines.push({ key: 'landed', text: t('mergePreview.alreadyMerged', { base }) })
  if (detailed && preview.status === 'clean' && preview.siblings.length === 0) lines.push({ key: 'clean', text: t('mergePreview.clean', { base }) })
  if (detailed && preview.status === 'unknown') lines.push({ key: 'unknown', text: t('mergePreview.unknown') })
  const moved = preview.baseAdvancedBy ?? 0
  if (lines.length === 0 && moved === 0) return null
  return (
    <div className={`flex min-w-0 flex-col gap-0.5 text-caption ${className}`} data-testid="merge-preview" data-merge-preview={preview.status}>
      {lines.map((line) => (
        <span key={line.key} className="flex min-w-0 items-start gap-1.5" title={line.title}>
          {state ? <RunStateGlyph state={state} size="xs" className="mt-0.5" /> : <span className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />}
          <span className={`min-w-0 [overflow-wrap:anywhere] ${state === 'blocked' ? 'text-foreground' : 'text-muted-foreground'}`}>{line.text}</span>
        </span>
      ))}
      {moved > 0 ? (
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground" data-testid="merge-preview-base-moved">
          <GitCommitHorizontal className="h-3 w-3 shrink-0" aria-hidden />
          <span className="min-w-0 [overflow-wrap:anywhere]">{t('mergePreview.baseMoved', { base, count: moved })}</span>
        </span>
      ) : null}
    </div>
  )
}

/** The live merge preview of `deliveryId` (shared per project, refreshed on delivery and run events). */
export function MergePreviewLine({ deliveryId, detailed = false, className = '' }: { deliveryId: string | null | undefined; detailed?: boolean; className?: string }) {
  const preview = useMergePreview(deliveryId)
  return <MergePreviewView preview={preview} detailed={detailed} className={className} />
}
