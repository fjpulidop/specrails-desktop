import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderOpen, FolderGit2 } from 'lucide-react'
import { API_ORIGIN } from '../../../lib/origin'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../../components/ui/dialog'

/** Cloning is explicit and separate from registration: a completed checkout is never deleted on cancel. */
export function CloneRepositoryDialog({ onCloned, disabled = false }: { onCloned: (path: string) => void; disabled?: boolean }) {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [destination, setDestination] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [error, setError] = useState<string | null>(null)

  async function clone() {
    if (pending.current || !url.trim() || !destination.trim()) return
    pending.current = true
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`${API_ORIGIN}/api/repositories/clone`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), destination: destination.trim() }),
      })
      const data = await response.json() as { path?: string; error?: string }
      if (!response.ok || !data.path) throw new Error(data.error || t('repositories.clone.failed'))
      onCloned(data.path)
      setOpen(false)
      setUrl('')
      setDestination('')
    } catch (err) { setError(err instanceof Error ? err.message : t('repositories.clone.failed')) }
    finally { pending.current = false; setBusy(false) }
  }

  return <>
    <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => { setError(null); setOpen(true) }}>
      <FolderGit2 className="mr-1.5 h-4 w-4" />{t('repositories.clone.title')}
    </Button>
    <Dialog open={open} onOpenChange={(value) => { if (!pending.current) setOpen(value) }}>
      <DialogContent size="form" showCloseButton={!busy}>
        <DialogHeader icon={<FolderGit2 />}>
          <DialogTitle>{t('repositories.clone.title')}</DialogTitle>
          <DialogDescription>{t('repositories.clone.description')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <label className="block space-y-1.5 text-label">{t('repositories.clone.url')}
            <Input autoFocus value={url} disabled={busy} placeholder="https://github.com/owner/repo" onChange={(event) => setUrl(event.target.value)} />
          </label>
          <label className="block space-y-1.5 text-label">{t('repositories.clone.destination')}
            <Input value={destination} disabled={busy} placeholder="/Users/me/projects/repo" onChange={(event) => setDestination(event.target.value)} />
          </label>
          {'__TAURI_INTERNALS__' in window && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={async () => {
            try {
              const { open: choose } = await import('@tauri-apps/plugin-dialog')
              const parent = await choose({ directory: true, multiple: false })
              if (typeof parent === 'string') {
                const name = url.trim().split(/[/:]/).filter(Boolean).pop()?.replace(/\.git$/, '') || 'repo'
                setDestination(`${parent.replace(/[\\/]$/, '')}/${name}`)
              }
            } catch { /* The destination remains editable. */ }
          }}><FolderOpen className="mr-1.5 h-4 w-4" />{t('repositories.clone.browse')}</Button>}
          <p className="text-xs text-muted-foreground">{t('repositories.clone.hint')}</p>
          {destination.trim() && <p className="break-all rounded-md bg-muted p-3 text-xs">{t('repositories.clone.preview', { path: destination.trim() })}</p>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {busy && <p role="status" className="text-sm text-muted-foreground">{t('repositories.clone.busy')}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>{t('actions.cancel')}</Button>
          <Button disabled={busy || !url.trim() || !destination.trim()} onClick={() => void clone()}>{t('repositories.clone.submit')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
