import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bookmark, Check, Link2, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { toolbarButtonClass } from '../../../components/ui/board-toolbar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../../components/ui/dropdown-menu'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog'
import { MAX_SPEC_VIEWS, MAX_VIEW_NAME, viewMatchesState, type SpecView, type SpecViewState } from '../lib/spec-views'

export interface SpecsViewsMenuHandle {
  /** Opens the "Save current view" dialog (⌘K "Save current view"). */
  promptSave: () => void
}

interface SpecsViewsMenuProps {
  views: SpecView[]
  /** The board's filters, sort and density right now. */
  current: SpecViewState
  onApply: (view: SpecView) => void
  onSave: (name: string) => void
  onRename: (id: string, name: string) => void
  onUpdate: (id: string) => void
  onDelete: (id: string) => void
  onCopyLink: (id: string) => void
  /** Narrow toolbar: icon only. */
  compact: boolean
}

type DialogMode = 'closed' | 'save' | 'manage'

/**
 * Saved views of the specs board: a switcher (apply a view with one click) plus
 * a dialog to save the current setup and to rename, update, copy the link of or
 * delete a view. Views are per project (see lib/spec-views).
 */
export const SpecsViewsMenu = forwardRef<SpecsViewsMenuHandle, SpecsViewsMenuProps>(function SpecsViewsMenu(
  { views, current, onApply, onSave, onRename, onUpdate, onDelete, onCopyLink, compact },
  ref,
) {
  const { t } = useTranslation('specs')
  const [mode, setMode] = useState<DialogMode>('closed')
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const active = views.find((v) => viewMatchesState(v, current)) ?? null
  const full = views.length >= MAX_SPEC_VIEWS

  useImperativeHandle(ref, () => ({ promptSave: () => { setName(''); setMode('save') } }), [])

  const close = () => { setMode('closed'); setEditing(null) }
  const submitSave = () => {
    if (!name.trim()) return
    onSave(name)
    close()
  }
  const commitRename = () => {
    if (editing && editing.name.trim()) onRename(editing.id, editing.name)
    setEditing(null)
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          ref={triggerRef}
          aria-label={active ? t('views.triggerActive', { name: active.name }) : t('views.trigger')}
          title={t('views.trigger')}
          data-testid="specs-views-trigger"
          className={cn(toolbarButtonClass, compact && 'w-8 px-0')}
        >
          <Bookmark className={cn('h-3.5 w-3.5', active && 'text-accent-primary')} aria-hidden />
          {!compact && <span className="max-w-[8rem] truncate">{active ? active.name : t('views.trigger')}</span>}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" aria-label={t('views.menuLabel')} className="min-w-[14rem] max-w-[20rem]">
          {views.length === 0 && <p className="px-2 py-1.5 text-caption text-muted-foreground">{t('views.empty')}</p>}
          {views.map((view) => {
            const isActive = active?.id === view.id
            return (
              <DropdownMenuItem
                key={view.id}
                onSelect={() => onApply(view)}
                aria-current={isActive || undefined}
                data-testid={`specs-view-${view.id}`}
                className={cn('gap-2', isActive && 'font-medium text-foreground')}
              >
                <span className="inline-flex w-3.5 justify-center" aria-hidden>{isActive && <Check className="h-3.5 w-3.5" />}</span>
                <span className="truncate">{view.name}</span>
              </DropdownMenuItem>
            )
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => { setName(''); setMode('save') }} disabled={full} data-testid="specs-views-save">
            {t('views.saveCurrent')}
          </DropdownMenuItem>
          {views.length > 0 && (
            <DropdownMenuItem onSelect={() => setMode('manage')} data-testid="specs-views-manage">
              {t('views.manage')}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={mode === 'save'} onOpenChange={(o) => { if (!o) close() }}>
        <DialogContent size="confirm" data-testid="specs-views-save-dialog">
          <DialogHeader icon={<Bookmark />}>
            <DialogTitle>{t('views.saveTitle')}</DialogTitle>
            <DialogDescription>{t('views.saveDescription')}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <form id="specs-view-save-form" onSubmit={(e) => { e.preventDefault(); submitSave() }}>
              <label className="mb-1.5 block text-caption font-medium text-foreground" htmlFor="specs-view-name">{t('views.nameLabel')}</label>
              <Input
                id="specs-view-name"
                value={name}
                maxLength={MAX_VIEW_NAME}
                autoFocus
                placeholder={t('views.namePlaceholder')}
                onChange={(e) => setName(e.target.value)}
                data-testid="specs-views-name"
              />
            </form>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>{t('common:actions.cancel')}</Button>
            <Button type="submit" form="specs-view-save-form" disabled={!name.trim()} data-testid="specs-views-save-confirm">{t('views.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={mode === 'manage'} onOpenChange={(o) => { if (!o) close() }}>
        <DialogContent size="form" data-testid="specs-views-manage-dialog">
          <DialogHeader icon={<Bookmark />}>
            <DialogTitle>{t('views.manageTitle')}</DialogTitle>
            <DialogDescription>{t('views.manageDescription')}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {views.length === 0 && <p className="text-body text-muted-foreground">{t('views.empty')}</p>}
            <ul className="divide-y divide-border/40">
              {views.map((view) => {
                const matches = viewMatchesState(view, current)
                const isEditing = editing?.id === view.id
                return (
                  <li key={view.id} className="flex items-center gap-2 py-2" data-testid={`specs-views-row-${view.id}`}>
                    {isEditing ? (
                      <form className="flex-1" onSubmit={(e) => { e.preventDefault(); commitRename() }}>
                        <Input
                          value={editing.name}
                          maxLength={MAX_VIEW_NAME}
                          autoFocus
                          aria-label={t('views.nameLabel')}
                          onChange={(e) => setEditing({ id: view.id, name: e.target.value })}
                          onBlur={commitRename}
                          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEditing(null) } }}
                          data-testid="specs-views-rename-input"
                        />
                      </form>
                    ) : (
                      <span className="flex-1 truncate text-body text-foreground">{view.name}</span>
                    )}
                    <RowButton label={t('views.rename')} onClick={() => setEditing({ id: view.id, name: view.name })} testId={`specs-views-rename-${view.id}`}><Pencil className="h-3.5 w-3.5" aria-hidden /></RowButton>
                    <RowButton label={matches ? t('views.upToDate') : t('views.updateFromCurrent')} disabled={matches} onClick={() => onUpdate(view.id)} testId={`specs-views-update-${view.id}`}><RefreshCw className="h-3.5 w-3.5" aria-hidden /></RowButton>
                    <RowButton label={t('views.copyLink')} onClick={() => onCopyLink(view.id)} testId={`specs-views-link-${view.id}`}><Link2 className="h-3.5 w-3.5" aria-hidden /></RowButton>
                    <RowButton label={t('views.delete')} destructive onClick={() => onDelete(view.id)} testId={`specs-views-delete-${view.id}`}><Trash2 className="h-3.5 w-3.5" aria-hidden /></RowButton>
                  </li>
                )
              })}
            </ul>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>{t('views.done')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
})

function RowButton({ label, onClick, disabled, destructive, testId, children }: { label: string; onClick: () => void; disabled?: boolean; destructive?: boolean; testId: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded-control text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40',
        destructive && 'hover:text-destructive',
      )}
    >
      {children}
    </button>
  )
}
