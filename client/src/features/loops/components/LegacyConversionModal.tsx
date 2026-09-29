import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { Button } from '../../../components/ui/button'
import { LoopPublishError, loopsApi, type LoopDefinition } from '../lib/loops-api'

export function LegacyConversionModal({ loop, projects, onClose, onConverted }: {
  loop: LoopDefinition
  projects: Array<{ id: string; name: string; repositories?: Array<{ id: string; name: string }> }>
  onClose(): void
  onConverted(loop: LoopDefinition): void
}) {
  const { t } = useTranslation('loops')
  const [selection, setSelection] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const needsRepository = loop.graph.nodes.some(node => node.type === 'shell' && !node.data?.repositoryId)
  const repositories = projects.flatMap(project => (project.repositories ?? []).map(repository => ({
    key: JSON.stringify([project.id, repository.id]), id: repository.id, label: `${project.name} / ${repository.name}`,
  })))
  const selected = repositories.find(repository => repository.key === selection)
  async function convert() {
    setBusy(true); setError('')
    try { onConverted((await loopsApi.convert(loop.id, selected?.id)).loop) }
    catch (cause) {
      setError(cause instanceof LoopPublishError ? cause.errors.map(issue => `${issue.nodeId ? issue.nodeId + ': ' : ''}${issue.message}`).join('\n')
        : cause instanceof Error && cause.message === 'engine_unsupported' ? t('conversion.coreRequired')
        : cause instanceof Error ? t('conversion.error') + ': ' + cause.message : t('conversion.error'))
    }
    finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent><DialogHeader>
      <DialogTitle>{t('conversion.title', { name: loop.name })}</DialogTitle>
      <DialogDescription>{t('conversion.description')}</DialogDescription>
    </DialogHeader>
      {needsRepository && <label className="flex flex-col gap-2 text-sm">{t('conversion.repository')}
        <select className="rounded border border-border bg-background p-2" value={selection} onChange={event => setSelection(event.target.value)} disabled={busy}>
          <option value="">{t('conversion.selectRepository')}</option>
          {repositories.map(repository => <option key={repository.key} value={repository.key}>{repository.label}</option>)}
        </select>
      </label>}
      {error && <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">{error}</p>}
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={onClose}>{t('common:actions.cancel')}</Button>
        <Button disabled={busy || (needsRepository && !selected)} onClick={() => void convert()}>{t(busy ? 'conversion.pending' : 'conversion.submit')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
