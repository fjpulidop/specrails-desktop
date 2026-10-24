import {
  AtSign,
  Bot,
  BriefcaseBusiness,
  Camera,
  FileText,
  GitPullRequest,
  Hash,
  Loader2,
  Paperclip,
  Plus,
  Search,
  Sparkles,
  X,
  Route,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentContextChip, AgentContextKind, AgentPaletteItem, AgentPaletteMode } from '../lib/agent-context-palette'

const modeIcon: Record<AgentPaletteMode, LucideIcon> = {
  reference: AtSign,
  trace: Hash,
  action: Sparkles,
}

const iconMap: Record<AgentContextKind | 'action', LucideIcon> = {
  project: BriefcaseBusiness,
  spec: FileText,
  job: Bot,
  trace: Hash,
  conversation: Bot,
  file: Paperclip,
  alias: AtSign,
  pr: GitPullRequest,
  rail: Route,
  action: Sparkles,
}

function modeGlyph(mode: AgentPaletteMode): string {
  if (mode === 'reference') return '@'
  if (mode === 'trace') return '#'
  return '/'
}

function chipTone(kind: AgentContextKind): string {
  if (kind === 'spec') return 'border-accent-highlight/30 bg-accent-highlight/10 text-accent-highlight'
  if (kind === 'job' || kind === 'trace') return 'border-accent-info/30 bg-accent-info/10 text-accent-info'
  if (kind === 'action') return 'border-accent-highlight/30 bg-accent-highlight/10 text-accent-highlight'
  if (kind === 'project' || kind === 'alias') return 'border-accent-primary/30 bg-accent-primary/10 text-accent-primary'
  if (kind === 'rail') return 'border-accent-warning/30 bg-accent-warning/10 text-accent-warning'
  return 'border-border/60 bg-surface/70 text-foreground/80'
}

/** Below this much room above its anchor a composer popover opens BELOW it
 *  (the centred empty-state composer); otherwise it opens above, capped. */
export const COMPOSER_POPOVER_MIN_SPACE = 240
const POPOVER_GAP = 8
const POPOVER_MARGIN = 16
const POPOVER_MIN_HEIGHT = 160

export type ComposerPopoverPlacement = 'above' | 'below'

/**
 * Measures the room around a composer popover's anchor so the popover never
 * opens off-screen: flips below when the space above is too small, and caps
 * the scrollable body to the room that is left on the chosen side.
 */
export function useComposerPopoverPlacement(
  anchor: () => HTMLElement | null | undefined,
  options: { active: boolean; headerRef?: RefObject<HTMLElement | null>; revision?: unknown },
): { placement: ComposerPopoverPlacement; maxHeight: number | undefined } {
  const [state, setState] = useState<{ placement: ComposerPopoverPlacement; maxHeight: number | undefined }>({ placement: 'above', maxHeight: undefined })
  const anchorRef = useRef(anchor)
  anchorRef.current = anchor
  const { active, headerRef, revision } = options
  useLayoutEffect(() => {
    if (!active) return
    const measure = (): void => {
      const element = anchorRef.current()
      if (!element) return
      const rect = element.getBoundingClientRect()
      const header = headerRef?.current?.offsetHeight ?? 0
      const placement: ComposerPopoverPlacement = rect.top < COMPOSER_POPOVER_MIN_SPACE ? 'below' : 'above'
      const room = placement === 'above' ? rect.top : window.innerHeight - rect.bottom
      const maxHeight = Math.max(POPOVER_MIN_HEIGHT, Math.floor(room - POPOVER_GAP - header - POPOVER_MARGIN))
      setState((previous) => previous.placement === placement && previous.maxHeight === maxHeight ? previous : { placement, maxHeight })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [active, headerRef, revision])
  return state
}

export function AgentComposerContextChips({
  chips,
  onRemove,
}: {
  chips: AgentContextChip[]
  onRemove: (chip: AgentContextChip) => void
}) {
  const { t } = useTranslation('agent')
  if (chips.length === 0) return null
  return (
    <>
      {chips.map((chip) => {
        const Icon = iconMap[chip.kind] ?? AtSign
        return (
          <span
            key={`${chip.kind}:${chip.id}`}
            title={[chip.label, chip.detail, chip.projectName, chip.status].filter(Boolean).join(' · ')}
            className={`inline-flex max-w-[240px] items-center gap-1.5 rounded-full border px-2 py-0.5 text-caption ${chipTone(chip.kind)}`}
          >
            <Icon className="h-3 w-3 shrink-0" />
            <span className="truncate font-medium">{chip.label}</span>
            {chip.status && <span className="text-foreground/70">{chip.status}</span>}
            <button
              type="button"
              onClick={() => onRemove(chip)}
              aria-label={t('palette.remove', { label: chip.label })}
              className="rounded-sm text-foreground/70 hover:bg-background/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        )
      })}
    </>
  )
}

export function AgentContextPalette({
  paletteId,
  items,
  mode,
  query,
  activeIndex,
  onActiveIndexChange,
  onSelect,
}: {
  /** DOM id of the listbox; options are `${paletteId}-opt-${index}` so the
   *  editor (the combobox) can point `aria-activedescendant` at them. */
  paletteId: string
  items: AgentPaletteItem[]
  mode: AgentPaletteMode
  query: string
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onSelect: (item: AgentPaletteItem) => void
}) {
  const { t } = useTranslation('agent')
  const ModeIcon = modeIcon[mode]
  const rootRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  // The palette is anchored to the composer card: measure the room around it.
  const { placement, maxHeight } = useComposerPopoverPlacement(() => rootRef.current?.parentElement, { active: true, headerRef, revision: items.length })
  useEffect(() => {
    document.getElementById(`${paletteId}-opt-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [paletteId, activeIndex])
  let previousGroup = ''
  return (
    <div
      ref={rootRef}
      data-testid="agent-context-palette"
      data-placement={placement}
      className={`absolute ${placement === 'below' ? 'top-[calc(100%+0.5rem)]' : 'bottom-[calc(100%+0.5rem)]'} left-0 right-0 z-30 overflow-hidden rounded-lg border border-border/70 bg-popover shadow-xl shadow-black/15`}
    >
      <div ref={headerRef} className="flex items-center gap-2 border-b border-border/60 px-2.5 py-2">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-surface text-foreground/70">
          <ModeIcon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-label text-foreground">{modeGlyph(mode)} {t(`palette.mode.${mode}.title`)}</div>
          <div className="truncate text-xs text-foreground/65">
            {query ? t('palette.filtering', { query }) : t(`palette.mode.${mode}.hint`)}
          </div>
        </div>
        <div className="hidden text-xs text-foreground/65 sm:block">{t('palette.keyboard')}</div>
      </div>
      {items.length === 0 ? (
        <div role="status" className="flex items-center gap-2 px-3 py-3 text-xs text-foreground/70">
          <Search className="h-3.5 w-3.5 text-foreground/60" aria-hidden />
          <span>{query ? t('palette.noMatchesFor', { query }) : t('palette.noMatches')}</span>
        </div>
      ) : (
        <div
          id={paletteId}
          role="listbox"
          aria-label={t(`palette.mode.${mode}.title`)}
          className="max-h-[19rem] overflow-y-auto py-1"
          style={maxHeight !== undefined ? { maxHeight } : undefined}
        >
          {items.map((item, index) => {
            const Icon = iconMap[item.icon] ?? Sparkles
            const showGroup = item.group !== previousGroup
            previousGroup = item.group
            const active = index === activeIndex
            return (
              <div key={item.id} role="presentation">
                {showGroup && (
                  <div role="presentation" className="px-3 pb-1 pt-2 text-label text-muted-foreground">
                    {item.group}
                  </div>
                )}
                <button
                  type="button"
                  id={`${paletteId}-opt-${index}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={active}
                  onMouseEnter={() => onActiveIndexChange(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onSelect(item)}
                  className={`flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors ${
                    active ? 'bg-accent-primary/10 text-foreground' : 'text-foreground/80 hover:bg-surface/70'
                  }`}
                >
                  <span className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
                    active ? 'bg-background text-accent-primary' : 'bg-surface text-foreground/50'
                  }`}>
                    <Icon className="h-3.5 w-3.5" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium">{item.title}</span>
                      {item.risk && (
                        <span className="shrink-0 rounded-sm border border-border/60 px-1 py-0.5 text-caption text-foreground/70">
                          {item.risk}
                        </span>
                      )}
                    </span>
                    {(item.subtitle || item.detail) && (
                      <span className="mt-0.5 block truncate text-xs text-foreground/65">
                        {item.subtitle}{item.subtitle && item.detail ? ' · ' : ''}{item.detail}
                      </span>
                    )}
                  </span>
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function AgentPlusMenu({
  open,
  canAttach,
  uploading,
  onToggle,
  onClose,
  onOpenMode,
  onAttachFile,
  canBrowserCapture,
  onOpenBrowser,
}: {
  open: boolean
  canAttach: boolean
  uploading: boolean
  onToggle: () => void
  onClose: () => void
  onOpenMode: (mode: AgentPaletteMode) => void
  onAttachFile: () => void
  /** Browser capture is available when the capture feature is on and a project
   *  is active — a conversation is NOT required (a capture on the empty compose
   *  screen materializes the draft mission). */
  canBrowserCapture: boolean
  onOpenBrowser: () => void
}) {
  const { t } = useTranslation('agent')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const { placement, maxHeight } = useComposerPopoverPlacement(() => rootRef.current, { active: open })
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const enabledItems = (): HTMLButtonElement[] =>
    Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []).filter((item) => !item.disabled)

  useEffect(() => {
    if (!open) return
    // A menu opened from the keyboard or the pointer lands on its first item.
    enabledItems()[0]?.focus()
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Node && rootRef.current?.contains(target)) return
      onCloseRef.current()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onCloseRef.current()
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const items = enabledItems()
    if (items.length === 0) return
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    let next: number | null = null
    if (event.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % items.length
    else if (event.key === 'ArrowUp') next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    else if (event.key === 'Tab') { onClose(); return }
    if (next === null) return
    event.preventDefault()
    event.stopPropagation()
    items[next].focus()
  }

  const itemClass = 'flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface focus:bg-surface focus:outline-none disabled:cursor-not-allowed disabled:opacity-45'
  const hintClass = 'block truncate text-xs text-foreground/65'

  return (
    <div ref={rootRef} className="relative flex shrink-0 items-center">
      <button
        ref={triggerRef}
        type="button"
        onClick={onToggle}
        aria-label={t('palette.addContextAction')}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('palette.addContextAction')}
        data-agent-interactive
        className="inline-flex h-8 w-8 items-center justify-center rounded-md p-1 text-foreground/60 hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary disabled:opacity-50"
      >
        <Plus className="h-4 w-4" />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={t('palette.addContextAction')}
          data-placement={placement}
          onKeyDown={onMenuKeyDown}
          style={maxHeight !== undefined ? { maxHeight } : undefined}
          className={`absolute ${placement === 'below' ? 'top-9' : 'bottom-9'} left-0 z-40 w-64 overflow-y-auto rounded-lg border border-border/70 bg-popover py-1 shadow-xl shadow-black/15`}
        >
          <button type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => onOpenMode('reference')} className={itemClass}>
            <AtSign className="h-4 w-4 text-accent-primary" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{t('palette.plus.reference')}</span>
              <span className={hintClass}>{t('palette.plus.referenceHint')}</span>
            </span>
          </button>
          <button type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => onOpenMode('trace')} className={itemClass}>
            <Hash className="h-4 w-4 text-accent-info" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{t('palette.plus.trace')}</span>
              <span className={hintClass}>{t('palette.plus.traceHint')}</span>
            </span>
          </button>
          <button type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => onOpenMode('action')} className={itemClass}>
            <Sparkles className="h-4 w-4 text-accent-highlight" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{t('palette.plus.action')}</span>
              <span className={hintClass}>{t('palette.plus.actionHint')}</span>
            </span>
          </button>
          <div role="separator" className="my-1 border-t border-border/60" />
          <button
            type="button"
            role="menuitem"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onAttachFile}
            disabled={!canAttach || uploading}
            aria-busy={uploading || undefined}
            className={itemClass}
            data-testid="agent-plus-file-attachment"
          >
            {uploading
              ? <Loader2 className="h-4 w-4 animate-spin text-accent-primary motion-reduce:animate-none" aria-hidden />
              : <Paperclip className="h-4 w-4 text-foreground/60" aria-hidden />}
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{t('palette.plus.fileAttachment')}</span>
              <span className={hintClass}>{uploading ? t('composer.uploading') : t('palette.plus.fileAttachmentHint')}</span>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => { onClose(); onOpenBrowser() }}
            disabled={!canBrowserCapture}
            className={itemClass}
            data-testid="agent-plus-browser-capture"
          >
            <Camera className="h-4 w-4 text-foreground/60" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{t('palette.plus.browserCapture')}</span>
              <span className={hintClass}>{t('palette.plus.browserCaptureHint')}</span>
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
