import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FileText, LifeBuoy, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import type { DialogLayer } from '../../../lib/layers'
import { ApiResponseError } from '../../../lib/api-response'
import { saveBinaryFile } from '../../../lib/save-text-file'
import { notifyError } from '../../../lib/notify-error'
import { cn } from '../../../lib/utils'
import { formatReportSize } from '../lib/format'
import { buildProblemReport, downloadProblemReport, type ReportPreview } from '../lib/diagnostics-api'

type State =
  | { kind: 'building' }
  | { kind: 'ready'; preview: ReportPreview }
  | { kind: 'error'; message: string }

/**
 * "Report a problem": builds a redacted report on the local server, shows every
 * file it contains, and saves exactly those files as a ZIP the person chooses.
 * Nothing is uploaded.
 */
export function ReportProblemDialog({ open, onOpenChange, layer }: { open: boolean; onOpenChange: (open: boolean) => void; layer?: DialogLayer }) {
  const { t, i18n } = useTranslation('diagnostics')
  const [state, setState] = useState<State>({ kind: 'building' })
  const [selected, setSelected] = useState(0)
  const [saving, setSaving] = useState(false)
  const run = useRef(0)

  const build = useCallback(() => {
    const id = ++run.current
    setState({ kind: 'building' })
    setSelected(0)
    buildProblemReport()
      .then(preview => { if (run.current === id) setState({ kind: 'ready', preview }) })
      .catch((error: unknown) => {
        if (run.current === id) setState({ kind: 'error', message: t('report.buildFailed', { error: error instanceof Error ? error.message : String(error) }) })
      })
  }, [t])

  useEffect(() => {
    if (open) build()
    else run.current++
  }, [open, build])

  async function save() {
    if (state.kind !== 'ready') return
    setSaving(true)
    try {
      const bytes = await downloadProblemReport(state.preview.id)
      const result = await saveBinaryFile(state.preview.fileName, bytes, 'application/zip')
      if (result === 'saved') {
        toast.success(t('report.saved'), { description: t('report.savedBody', { name: state.preview.fileName }) })
        onOpenChange(false)
      } else if (result === 'failed') {
        notifyError(t('report.saveFailed'))
      }
    } catch (error) {
      if (error instanceof ApiResponseError && error.status === 404) setState({ kind: 'error', message: t('report.expired') })
      else notifyError(t('report.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const files = state.kind === 'ready' ? state.preview.files : []
  const current = files[selected]

  return (
    <Dialog open={open} onOpenChange={next => { if (!saving) onOpenChange(next) }}>
      <DialogContent size="workspace" layer={layer} data-testid="report-problem-dialog">
        <DialogHeader icon={<LifeBuoy aria-hidden />}>
          <DialogTitle>{t('report.title')}</DialogTitle>
          <DialogDescription>{t('report.description')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex min-h-0 flex-col gap-3">
          {state.kind === 'building' && (
            <p role="status" className="flex items-center gap-2 text-body text-muted-foreground">
              <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />{t('report.building')}
            </p>
          )}
          {state.kind === 'error' && (
            <div role="alert" className="flex items-center gap-3 text-body text-destructive">
              <span>{state.message}</span>
              <Button type="button" size="sm" variant="outline" onClick={build}>{t('report.retry')}</Button>
            </div>
          )}
          {state.kind === 'ready' && <>
            <p className="text-caption text-muted-foreground">{t('report.redactionNote')}</p>
            <div className="flex min-h-0 flex-1 gap-3 max-sm:flex-col">
              <ul aria-label={t('report.fileListLabel')} className="w-64 shrink-0 space-y-1 overflow-auto max-sm:w-full max-sm:max-h-40">
                {files.map((file, index) => (
                  <li key={file.name}>
                    <button
                      type="button"
                      aria-current={index === selected ? 'true' : undefined}
                      onClick={() => setSelected(index)}
                      className={cn(
                        'flex w-full items-start gap-2 rounded-control px-2 py-1.5 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary',
                        index === selected && 'bg-muted',
                      )}
                    >
                      <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="truncate font-mono text-label text-foreground">{file.name}</span>
                          <span className="num shrink-0 text-caption text-muted-foreground">{formatReportSize(file.bytes, i18n.language)}</span>
                        </span>
                        <span className="block text-caption text-muted-foreground">{file.description}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <pre
                data-testid="report-file-content"
                tabIndex={0}
                aria-label={current?.name}
                className="min-h-48 min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-card border border-border bg-muted/40 p-3 font-mono text-caption text-foreground"
              >
                {current?.content}
              </pre>
            </div>
          </>}
        </DialogBody>
        <DialogFooter start={state.kind === 'ready' ? (
          <Button type="button" variant="ghost" size="sm" onClick={build} disabled={saving}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden />{t('report.rebuild')}
          </Button>
        ) : undefined}>
          <Button type="button" variant="ghost" disabled={saving} onClick={() => onOpenChange(false)}>{t('common:actions.cancel')}</Button>
          <Button type="button" disabled={state.kind !== 'ready' || saving} onClick={() => void save()} data-testid="report-problem-save">
            {saving && <Loader2 className="mr-1 h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />}
            {saving ? t('report.saving') : t('report.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default ReportProblemDialog
