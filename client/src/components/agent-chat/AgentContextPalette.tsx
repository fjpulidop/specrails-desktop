import {
  AtSign,
  Bot,
  BriefcaseBusiness,
  Camera,
  FileText,
  GitPullRequest,
  Hash,
  Paperclip,
  Plus,
  Search,
  Sparkles,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentContextChip, AgentContextKind, AgentPaletteItem, AgentPaletteMode } from '../../lib/agent-context-palette'

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
  return 'border-border/60 bg-surface/70 text-foreground/80'
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
            className={`inline-flex max-w-[240px] items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] ${chipTone(chip.kind)}`}
          >
            <Icon className="h-3 w-3 shrink-0" />
            <span className="truncate font-medium">{chip.label}</span>
            {chip.status && <span className="text-foreground/40">{chip.status}</span>}
            <button
              type="button"
              onClick={() => onRemove(chip)}
              aria-label={t('palette.remove', { label: chip.label })}
              className="rounded-sm text-foreground/45 hover:bg-background/60 hover:text-foreground"
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
  items,
  mode,
  query,
  activeIndex,
  onActiveIndexChange,
  onSelect,
}: {
  items: AgentPaletteItem[]
  mode: AgentPaletteMode
  query: string
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onSelect: (item: AgentPaletteItem) => void
}) {
  const { t } = useTranslation('agent')
  const ModeIcon = modeIcon[mode]
  let previousGroup = ''
  return (
    <div
      data-testid="agent-context-palette"
      className="absolute bottom-[calc(100%+0.5rem)] left-0 right-0 z-30 overflow-hidden rounded-lg border border-border/70 bg-background/95 shadow-xl shadow-black/15 backdrop-blur"
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-2.5 py-2">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-surface text-foreground/70">
          <ModeIcon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-foreground">{modeGlyph(mode)} {t(`palette.mode.${mode}.title`)}</div>
          <div className="truncate text-[11px] text-foreground/45">
            {query ? t('palette.filtering', { query }) : t(`palette.mode.${mode}.hint`)}
          </div>
        </div>
        <div className="hidden text-[10px] text-foreground/35 sm:block">{t('palette.keyboard')}</div>
      </div>
      {items.length === 0 ? (
        <div className="flex items-center gap-2 px-3 py-3 text-xs text-foreground/55">
          <Search className="h-3.5 w-3.5 text-foreground/35" />
          <span>{query ? t('palette.noMatchesFor', { query }) : t('palette.noMatches')}</span>
        </div>
      ) : (
        <div className="max-h-[19rem] overflow-y-auto py-1">
          {items.map((item, index) => {
            const Icon = iconMap[item.icon] ?? Sparkles
            const showGroup = item.group !== previousGroup
            previousGroup = item.group
            const active = index === activeIndex
            return (
              <div key={item.id}>
                {showGroup && (
                  <div className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-foreground/35">
                    {item.group}
                  </div>
                )}
                <button
                  type="button"
                  role="option"
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
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium">{item.title}</span>
                      {item.risk && (
                        <span className="shrink-0 rounded-sm border border-border/60 px-1 py-0.5 text-[10px] uppercase text-foreground/45">
                          {item.risk}
                        </span>
                      )}
                    </span>
                    {(item.subtitle || item.detail) && (
                      <span className="mt-0.5 block truncate text-[11px] text-foreground/45">
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

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Node && rootRef.current?.contains(target)) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open, onClose])

  return (
    <div ref={rootRef} className="relative mb-1">
      <button
        type="button"
        onClick={onToggle}
        aria-label={t('palette.addContextAction')}
        title={t('palette.addContextAction')}
        data-agent-interactive
        className="rounded-md p-1 text-foreground/50 hover:bg-surface hover:text-foreground disabled:opacity-50"
      >
        <Plus className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute bottom-8 left-0 z-40 w-64 overflow-hidden rounded-lg border border-border/70 bg-background/95 py-1 shadow-xl shadow-black/15 backdrop-blur">
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => onOpenMode('reference')} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface">
            <AtSign className="h-4 w-4 text-accent-primary" />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{t('palette.plus.reference')}</span>
              <span className="block truncate text-[11px] text-foreground/45">{t('palette.plus.referenceHint')}</span>
            </span>
          </button>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => onOpenMode('trace')} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface">
            <Hash className="h-4 w-4 text-accent-info" />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{t('palette.plus.trace')}</span>
              <span className="block truncate text-[11px] text-foreground/45">{t('palette.plus.traceHint')}</span>
            </span>
          </button>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => onOpenMode('action')} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface">
            <Sparkles className="h-4 w-4 text-accent-highlight" />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{t('palette.plus.action')}</span>
              <span className="block truncate text-[11px] text-foreground/45">{t('palette.plus.actionHint')}</span>
            </span>
          </button>
          <div className="my-1 border-t border-border/60" />
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onAttachFile}
            disabled={!canAttach || uploading}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Paperclip className="h-4 w-4 text-foreground/50" />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{t('palette.plus.fileAttachment')}</span>
              <span className="block truncate text-[11px] text-foreground/45">{t('palette.plus.fileAttachmentHint')}</span>
            </span>
          </button>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => { onClose(); onOpenBrowser() }}
            disabled={!canBrowserCapture}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface disabled:cursor-not-allowed disabled:opacity-45"
            data-testid="agent-plus-browser-capture"
          >
            <Camera className="h-4 w-4 text-foreground/50" />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{t('palette.plus.browserCapture')}</span>
              <span className="block truncate text-[11px] text-foreground/45">{t('palette.plus.browserCaptureHint')}</span>
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
