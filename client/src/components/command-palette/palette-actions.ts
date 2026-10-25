import {
  FilePlus2,
  Sparkles,
  Rocket,
  MoveRight,
  ClipboardCheck,
  FileDown,
  ClipboardCopy,
  Pause,
  Play,
  Check,
  MessagesSquare,
  Palette,
  LayoutDashboard,
  Settings,
  SlidersHorizontal,
  Workflow,
  PanelLeft,
  PanelRight,
  ArrowLeft,
  ArrowRight,
  Undo2,
  Trash2,
  FolderOpen,
  Inbox,
  ListChecks,
  X,
  BookmarkPlus,
  Bookmark,
  Tag,
  Flag,
  Gauge,
  type LucideIcon,
} from 'lucide-react'
import type { PaletteSurfaces } from '../../lib/palette-bridge'
import { foldText, matchesPaletteQuery } from '../../features/missions/lib/mission-search'
import { THEME_IDS, THEMES, type ThemeId } from '../../features/settings/lib/themes'
import { APP_SETTINGS_SECTIONS, openBudgetPanel, type AppSettingsSection } from '../../lib/app-settings-events'
import { PROJECT_SETTINGS_SECTION_IDS } from '../../features/settings/lib/project-settings-section-ids'

/**
 * ⌘K as an action hub (QW1). A typed registry of actions the palette can run,
 * each with an availability rule (`when`) so the list is context-aware, an
 * optional argument page (cmdk "pages": a second palette page, never a dialog)
 * and a shortcut that teaches the key.
 *
 * Actions own no business logic. They call what the buttons call: handlers
 * published by the mounted surfaces through `lib/palette-bridge` (launch
 * gating, Jira-backed status moves, Flow availability) or the app-level
 * callbacks in `PaletteContext.go`. A surface that is not mounted is absent,
 * so the actions depending on it are not offered.
 */

export type TFn = (key: string, options?: Record<string, unknown>) => string

export type ActionGroup = 'board' | 'mission' | 'global'

/** Rows the Actions group may show: a hard cap so the list never drowns the other groups. */
export const MAX_ACTION_ROWS = 8
/** Same cap when the Actions group trails (query is not action-like). */
export const MAX_TRAILING_ACTION_ROWS = 4
/** Rows an argument page shows before the person narrows it down. */
export const MAX_ARG_ROWS = 12
/** Recent actions remembered per viewer. */
export const MAX_RECENT_ACTIONS = 5
/** Recent places listed with an empty query. */
export const MAX_RECENT_PLACES = 5

export interface PaletteContext {
  t: TFn
  uiMode: 'kanban' | 'agent'
  projectId: string | null
  projects: { id: string; name: string }[]
  /** Spec open in the detail modal (`?spec=`), the one actions default to. */
  focusedSpecId: number | null
  surfaces: Partial<PaletteSurfaces>
  flags: { agentMode: boolean; loops: boolean }
  theme: { id: ThemeId; set: (id: ThemeId) => Promise<void> } | null
  history: { canBack: boolean; canForward: boolean; back: () => void; forward: () => void } | null
  /** The "Needs you" inbox (null where no inbox exists, e.g. secondary windows). */
  inbox: { count: number; open: () => void } | null
  /** Label of what ⌘Z would undo right now. */
  undoLabel: string | null
  /** Labels of the left/right sidebar toggles. */
  sidebarLabels: { left: string; right: string }
  go: {
    navigate: (path: string) => void
    setUiMode: (mode: 'kanban' | 'agent') => void
    openAppSettings: (section: AppSettingsSection, settingId?: string) => void
    openProjectSettings: (section: string, settingId?: string) => void
    newMission: () => void
    setProject: (id: string) => void
    toggleLeftSidebar: () => void
    toggleRightSidebar: () => void
    undoLast: () => void
    /** Loops that run without a spec, for the Run loop page. */
    listRunnableLoops: () => Promise<{ id: string; name: string }[]>
    runLoop: (loopId: string, name: string) => void
  }
}

export interface ArgOption {
  id: string
  label: string
  /** Secondary text (status, rail state, ...). */
  hint?: string
  /** Shown but not selectable; `hint` says why. */
  disabled?: boolean
  /** The value handed to `run(ctx, arg)` (when there is no `next`). */
  arg?: unknown
  /** A further page (multi-step arguments: pick a spec, then a rail). */
  next?: ArgPage
}

export interface ArgPage {
  /** Heading of the page. */
  title: string
  placeholder: string
  /** Options known now... */
  options?: ArgOption[]
  /** ...or loaded when the page opens. */
  load?: () => Promise<ArgOption[]>
  emptyLabel: string
}

export interface PaletteAction {
  id: string
  /** i18n key (commands namespace) of the row label. */
  labelKey: string
  labelParams?: (ctx: PaletteContext) => Record<string, unknown>
  /** Overrides labelKey/labelParams for rows whose label is already resolved (sidebar toggles). */
  resolveLabel?: (ctx: PaletteContext) => string
  group: ActionGroup
  icon: LucideIcon
  /** Display string with macOS glyphs; rendered through `keyboardLabel`. */
  shortcut?: string
  /** Extra match terms (English, so any locale finds the action). */
  keywords?: string[]
  /** i18n key (commands namespace) of a comma-separated list of localized match terms, added to `keywords`. */
  keywordsKey?: string
  /** Availability: false hides the row. */
  when: (ctx: PaletteContext) => boolean
  /** Argument page (the action then runs with the picked `arg`); null means this context needs no argument and `run` fires directly. */
  page?: (ctx: PaletteContext) => ArgPage | null
  run: (ctx: PaletteContext, arg?: unknown) => void
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Specs the person can pick when none is open, narrowed by a predicate. */
function specOptions(ctx: PaletteContext, keep: (id: number) => boolean, next: (id: number) => ArgPage | undefined, arg: (id: number) => unknown): ArgOption[] {
  const specs = ctx.surfaces.board?.specs() ?? []
  return specs
    .filter((s) => keep(s.id))
    .map((s) => ({ id: `spec-${s.id}`, label: `#${s.id} ${s.title}`, hint: s.status, next: next(s.id), arg: arg(s.id) }))
}

function railPage(ctx: PaletteContext, ticketId: number): ArgPage {
  const board = ctx.surfaces.board
  const blocker = board?.launchBlocker(ticketId) ?? null
  return {
    title: ctx.t('palette.actions.pages.railTitle', { id: ticketId }),
    placeholder: ctx.t('palette.actions.pages.railPlaceholder'),
    emptyLabel: ctx.t('palette.actions.pages.noRails'),
    options: (board?.rails(ticketId) ?? []).map((rail) => ({
      id: `rail-${rail.id}`,
      label: rail.label,
      hint: blocker ?? (rail.running ? ctx.t('palette.actions.pages.railRunning') : rail.hasSpec ? ctx.t('palette.actions.pages.railHasSpec') : undefined),
      disabled: blocker !== null || rail.running,
      arg: { ticketId, railId: rail.id },
    })),
  }
}

function statusPage(ctx: PaletteContext, ticketId: number): ArgPage {
  const board = ctx.surfaces.board
  return {
    title: ctx.t('palette.actions.pages.statusTitle', { id: ticketId }),
    placeholder: ctx.t('palette.actions.pages.statusPlaceholder'),
    emptyLabel: ctx.t('palette.actions.pages.noStatuses'),
    load: async () => (await (board?.statusOptions(ticketId) ?? Promise.resolve([]))).map((o) => ({
      id: `status-${o.id}`,
      label: o.label,
      hint: o.current ? ctx.t('palette.actions.pages.current') : undefined,
      disabled: o.current,
      arg: { ticketId, optionId: o.id },
    })),
  }
}

const launchableSpecs = (ctx: PaletteContext) => (ctx.surfaces.board?.specs() ?? []).filter((s) => ctx.surfaces.board?.launchBlocker(s.id) === null)


const selectionCount = (ctx: PaletteContext): number => ctx.surfaces.selection?.count() ?? 0

function selectedPage(ctx: PaletteContext, titleKey: string, placeholderKey: string, options: ArgOption[], emptyKey: string): ArgPage {
  return {
    title: ctx.t(titleKey, { count: selectionCount(ctx) }),
    placeholder: ctx.t(placeholderKey),
    emptyLabel: ctx.t(emptyKey),
    options,
  }
}

function flowControl(ctx: PaletteContext, id: 'pause' | 'resume' | 'hand-off') {
  const control = ctx.surfaces.flow?.controls().find((c) => c.id === id)
  return control && !control.disabled ? control : null
}

function sectionOptions(sections: readonly string[], labelOf: (id: string) => string): ArgOption[] {
  return sections.map((id) => ({ id: `section-${id}`, label: labelOf(id), arg: id }))
}

// ─── Registry ───────────────────────────────────────────────────────────────

export const PALETTE_ACTIONS: readonly PaletteAction[] = [
  // Board
  {
    id: 'spec.new', labelKey: 'palette.actions.newSpec', group: 'board', icon: FilePlus2, shortcut: '⌘↵',
    keywords: ['create', 'add', 'spec', 'ticket', 'idea'],
    when: (ctx) => !!ctx.surfaces.specs,
    run: (ctx) => ctx.surfaces.specs?.openNewSpec('quick'),
  },
  {
    id: 'spec.newExplore', labelKey: 'palette.actions.newSpecExplore', group: 'board', icon: Sparkles,
    keywords: ['create', 'add', 'spec', 'explore', 'chat'],
    when: (ctx) => !!ctx.surfaces.specs,
    run: (ctx) => ctx.surfaces.specs?.openNewSpec('explore'),
  },
  {
    id: 'spec.launch', labelKey: 'palette.actions.launchSpec', group: 'board', icon: Rocket,
    keywords: ['launch', 'run', 'rail', 'implement', 'start'],
    resolveLabel: (ctx) => ctx.focusedSpecId !== null ? ctx.t('palette.actions.launchSpecN', { id: ctx.focusedSpecId }) : ctx.t('palette.actions.launchSpec'),
    when: (ctx) => {
      const board = ctx.surfaces.board
      if (!board) return false
      return ctx.focusedSpecId !== null ? board.launchBlocker(ctx.focusedSpecId) === null && board.rails(ctx.focusedSpecId).length > 0 : launchableSpecs(ctx).length > 0
    },
    page: (ctx) => {
      if (ctx.focusedSpecId !== null) return railPage(ctx, ctx.focusedSpecId)
      return {
        title: ctx.t('palette.actions.pages.specTitle'),
        placeholder: ctx.t('palette.actions.pages.specPlaceholder'),
        emptyLabel: ctx.t('palette.actions.pages.noSpecs'),
        options: specOptions(ctx, (id) => ctx.surfaces.board?.launchBlocker(id) === null, (id) => railPage(ctx, id), () => undefined),
      }
    },
    run: (ctx, arg) => {
      const { ticketId, railId } = arg as { ticketId: number; railId: string }
      ctx.surfaces.board?.launchOnRail(ticketId, railId)
    },
  },
  {
    id: 'spec.move', labelKey: 'palette.actions.moveSpec', group: 'board', icon: MoveRight,
    keywords: ['move', 'status', 'todo', 'done', 'cancel', 'transition'],
    resolveLabel: (ctx) => ctx.focusedSpecId !== null ? ctx.t('palette.actions.moveSpecN', { id: ctx.focusedSpecId }) : ctx.t('palette.actions.moveSpec'),
    when: (ctx) => !!ctx.surfaces.board && (ctx.focusedSpecId !== null || (ctx.surfaces.board.specs().length > 0)),
    page: (ctx) => {
      if (ctx.focusedSpecId !== null) return statusPage(ctx, ctx.focusedSpecId)
      return {
        title: ctx.t('palette.actions.pages.specTitle'),
        placeholder: ctx.t('palette.actions.pages.specPlaceholder'),
        emptyLabel: ctx.t('palette.actions.pages.noSpecs'),
        options: specOptions(ctx, () => true, (id) => statusPage(ctx, id), () => undefined),
      }
    },
    run: (ctx, arg) => {
      const { ticketId, optionId } = arg as { ticketId: number; optionId: string }
      ctx.surfaces.board?.moveStatus(ticketId, optionId)
    },
  },
  {
    id: 'spec.moveFocused', labelKey: 'palette.actions.moveFocusedSpec', group: 'board', icon: MoveRight, shortcut: 'M',
    keywords: ['move', 'keyboard', 'focused', 'status', 'rail', 'picker', 'accessibility'],
    when: (ctx) => !!ctx.surfaces.specs?.canMoveFocused?.(),
    run: (ctx) => ctx.surfaces.specs?.openMovePicker(),
  },
  {
    id: 'spec.review', labelKey: 'palette.actions.openReview', group: 'board', icon: ClipboardCheck,
    keywords: ['review', 'pr', 'pull request', 'packet', 'delivery'],
    resolveLabel: (ctx) => ctx.focusedSpecId !== null ? ctx.t('palette.actions.openReviewN', { id: ctx.focusedSpecId }) : ctx.t('palette.actions.openReview'),
    when: (ctx) => {
      const board = ctx.surfaces.board
      if (!board) return false
      return ctx.focusedSpecId !== null ? board.reviewPath(ctx.focusedSpecId) !== null : board.specs().some((s) => board.reviewPath(s.id) !== null)
    },
    page: (ctx) => {
      const board = ctx.surfaces.board
      if (ctx.focusedSpecId !== null) return null
      return {
        title: ctx.t('palette.actions.pages.specTitle'),
        placeholder: ctx.t('palette.actions.pages.specPlaceholder'),
        emptyLabel: ctx.t('palette.actions.pages.noSpecs'),
        options: specOptions(ctx, (id) => board?.reviewPath(id) != null, () => undefined, (id) => id),
      }
    },
    run: (ctx, arg) => {
      const id = typeof arg === 'number' ? arg : ctx.focusedSpecId
      const path = id !== null && id !== undefined ? ctx.surfaces.board?.reviewPath(id) : null
      if (path) ctx.go.navigate(path)
    },
  },

  // Spec hand-off (BB2): both run the handlers the spec modal's Export menu calls; offered only while that modal is open.
  {
    id: 'spec.exportHandoff', labelKey: 'palette.actions.exportHandoff', group: 'board', icon: FileDown,
    keywords: ['export', 'handoff', 'hand-off', 'summary', 'markdown', 'report', 'timeline'],
    resolveLabel: (ctx) => ctx.t('palette.actions.exportHandoffN', { id: ctx.focusedSpecId }),
    when: (ctx) => ctx.focusedSpecId !== null && ctx.surfaces.handoff?.ticketId() === ctx.focusedSpecId,
    run: (ctx) => { if (ctx.focusedSpecId !== null) ctx.surfaces.handoff?.exportHandoff(ctx.focusedSpecId) },
  },
  {
    id: 'spec.copyPrDescription', labelKey: 'palette.actions.copyPrDescription', group: 'board', icon: ClipboardCopy,
    keywords: ['copy', 'pr', 'pull request', 'description', 'clipboard'],
    resolveLabel: (ctx) => ctx.t('palette.actions.copyPrDescriptionN', { id: ctx.focusedSpecId }),
    when: (ctx) => ctx.focusedSpecId !== null && ctx.surfaces.handoff?.ticketId() === ctx.focusedSpecId,
    run: (ctx) => { if (ctx.focusedSpecId !== null) ctx.surfaces.handoff?.copyPrDescription(ctx.focusedSpecId) },
  },


  // Board selection (CD4): bulk actions exist only while specs are selected.
  {
    id: 'selection.selectAll', labelKey: 'palette.actions.selectAll', group: 'board', icon: ListChecks, shortcut: '⌘A',
    keywords: ['select', 'all', 'column', 'multi', 'bulk'],
    when: (ctx) => !!ctx.surfaces.selection && !!ctx.surfaces.board,
    run: (ctx) => ctx.surfaces.selection?.selectAllInColumn(),
  },
  {
    id: 'selection.clear', labelKey: 'palette.actions.clearSelection', group: 'board', icon: X, shortcut: 'Esc',
    keywords: ['clear', 'deselect', 'selection', 'unselect'],
    when: (ctx) => selectionCount(ctx) > 0,
    run: (ctx) => ctx.surfaces.selection?.clear(),
  },
  {
    id: 'selection.move', labelKey: 'palette.actions.moveSelected', group: 'board', icon: MoveRight,
    keywords: ['move', 'status', 'selected', 'bulk', 'todo', 'done', 'jira'],
    resolveLabel: (ctx) => ctx.t('palette.actions.moveSelectedN', { count: selectionCount(ctx) }),
    when: (ctx) => selectionCount(ctx) > 0,
    page: (ctx) => ({
      title: ctx.t('palette.actions.pages.statusSelectedTitle', { count: selectionCount(ctx) }),
      placeholder: ctx.t('palette.actions.pages.statusPlaceholder'),
      emptyLabel: ctx.t('palette.actions.pages.noStatuses'),
      load: async () => (await (ctx.surfaces.selection?.statusOptions() ?? Promise.resolve([]))).map((o) => ({ id: `status-${o.id}`, label: o.label, arg: o.id })),
    }),
    run: (ctx, arg) => ctx.surfaces.selection?.moveStatus(arg as string),
  },
  {
    id: 'selection.label', labelKey: 'palette.actions.labelSelected', group: 'board', icon: Tag,
    keywords: ['label', 'tag', 'selected', 'bulk'],
    resolveLabel: (ctx) => ctx.t('palette.actions.labelSelectedN', { count: selectionCount(ctx) }),
    when: (ctx) => selectionCount(ctx) > 0 && (ctx.surfaces.selection?.labelOptions().length ?? 0) > 0,
    page: (ctx) => selectedPage(ctx, 'palette.actions.pages.labelSelectedTitle', 'palette.actions.pages.labelPlaceholder',
      (ctx.surfaces.selection?.labelOptions() ?? []).map((l) => ({ id: `label-${l}`, label: l, arg: l })), 'palette.actions.pages.noLabels'),
    run: (ctx, arg) => ctx.surfaces.selection?.addLabel(arg as string),
  },
  {
    id: 'selection.priority', labelKey: 'palette.actions.prioritySelected', group: 'board', icon: Flag,
    keywords: ['priority', 'critical', 'high', 'low', 'selected', 'bulk'],
    resolveLabel: (ctx) => ctx.t('palette.actions.prioritySelectedN', { count: selectionCount(ctx) }),
    when: (ctx) => selectionCount(ctx) > 0,
    page: (ctx) => selectedPage(ctx, 'palette.actions.pages.prioritySelectedTitle', 'palette.actions.pages.priorityPlaceholder',
      (ctx.surfaces.selection?.priorityOptions() ?? []).map((p) => ({ id: `priority-${p.id}`, label: p.label, arg: p.id })), 'palette.actions.pages.noPriorities'),
    run: (ctx, arg) => ctx.surfaces.selection?.setPriority(arg as string),
  },
  {
    id: 'selection.rail', labelKey: 'palette.actions.railSelected', group: 'board', icon: MoveRight,
    keywords: ['rail', 'add', 'selected', 'bulk', 'queue'],
    resolveLabel: (ctx) => ctx.t('palette.actions.railSelectedN', { count: selectionCount(ctx) }),
    when: (ctx) => selectionCount(ctx) > 0,
    page: (ctx) => selectedPage(ctx, 'palette.actions.pages.railSelectedTitle', 'palette.actions.pages.railPlaceholder',
      (ctx.surfaces.selection?.railOptions() ?? []).map((r) => ({
        id: `rail-${r.id}`, label: r.label, hint: r.running ? ctx.t('palette.actions.pages.railRunning') : undefined, disabled: r.running, arg: r.id,
      })), 'palette.actions.pages.noRails'),
    run: (ctx, arg) => ctx.surfaces.selection?.addToRail(arg as string),
  },
  {
    id: 'selection.launch', labelKey: 'palette.actions.launchSelected', group: 'board', icon: Rocket,
    keywords: ['launch', 'run', 'start', 'implement', 'selected', 'bulk'],
    resolveLabel: (ctx) => ctx.t('palette.actions.launchSelectedN', { count: selectionCount(ctx) }),
    when: (ctx) => selectionCount(ctx) > 0,
    run: (ctx) => ctx.surfaces.selection?.launch(),
  },
  {
    id: 'selection.delete', labelKey: 'palette.actions.deleteSelected', group: 'board', icon: Trash2,
    keywords: ['delete', 'remove', 'selected', 'bulk', 'trash'],
    resolveLabel: (ctx) => ctx.t('palette.actions.deleteSelectedN', { count: selectionCount(ctx) }),
    when: (ctx) => selectionCount(ctx) > 0,
    run: (ctx) => ctx.surfaces.selection?.remove(),
  },
  // Saved views (CD4)
  {
    id: 'view.save', labelKey: 'palette.actions.saveView', group: 'board', icon: BookmarkPlus,
    keywords: ['save', 'view', 'filters', 'sort', 'saved'],
    when: (ctx) => !!ctx.surfaces.selection,
    run: (ctx) => ctx.surfaces.selection?.saveCurrentView(),
  },
  {
    id: 'view.switch', labelKey: 'palette.actions.switchView', group: 'board', icon: Bookmark,
    keywords: ['view', 'saved', 'filters', 'switch', 'apply'],
    when: (ctx) => (ctx.surfaces.selection?.views().length ?? 0) > 0,
    page: (ctx) => ({
      title: ctx.t('palette.actions.pages.viewTitle'),
      placeholder: ctx.t('palette.actions.pages.viewPlaceholder'),
      emptyLabel: ctx.t('palette.actions.pages.noViews'),
      options: (ctx.surfaces.selection?.views() ?? []).map((v) => ({ id: `view-${v.id}`, label: v.name, arg: v.id })),
    }),
    run: (ctx, arg) => ctx.surfaces.selection?.switchView(arg as string),
  },

  // Mission
  {
    id: 'flow.handOff', labelKey: 'palette.actions.handOffFlow', group: 'mission', icon: Check, shortcut: 'H',
    keywords: ['flow', 'hand off', 'handoff', 'spec', 'implement'],
    when: (ctx) => flowControl(ctx, 'hand-off') !== null,
    run: (ctx) => flowControl(ctx, 'hand-off')?.run(),
  },
  {
    id: 'flow.pause', labelKey: 'palette.actions.pauseFlow', group: 'mission', icon: Pause, shortcut: 'P',
    keywords: ['flow', 'pause', 'stop'],
    when: (ctx) => flowControl(ctx, 'pause') !== null,
    run: (ctx) => flowControl(ctx, 'pause')?.run(),
  },
  {
    id: 'flow.resume', labelKey: 'palette.actions.resumeFlow', group: 'mission', icon: Play, shortcut: 'P',
    keywords: ['flow', 'resume', 'continue'],
    when: (ctx) => flowControl(ctx, 'resume') !== null,
    run: (ctx) => flowControl(ctx, 'resume')?.run(),
  },
  {
    id: 'mission.new', labelKey: 'palette.actions.newMission', group: 'mission', icon: MessagesSquare,
    keywords: ['create', 'agent', 'chat', 'conversation'],
    when: (ctx) => ctx.uiMode === 'agent' && ctx.projectId !== null,
    run: (ctx) => ctx.go.newMission(),
  },

  // Global
  {
    id: 'theme.switch', labelKey: 'palette.actions.switchTheme', group: 'global', icon: Palette,
    keywords: ['theme', 'appearance', 'dark', 'light', 'colors'],
    when: (ctx) => ctx.theme !== null,
    page: (ctx) => ({
      title: ctx.t('palette.actions.pages.themeTitle'),
      placeholder: ctx.t('palette.actions.pages.themePlaceholder'),
      emptyLabel: ctx.t('palette.actions.pages.noThemes'),
      options: THEME_IDS.map((id) => ({
        id: `theme-${id}`, label: THEMES[id].displayName, hint: ctx.theme?.id === id ? ctx.t('palette.actions.pages.current') : undefined, disabled: ctx.theme?.id === id, arg: id,
      })),
    }),
    run: (ctx, arg) => { void ctx.theme?.set(arg as ThemeId) },
  },
  {
    id: 'mode.mission', labelKey: 'palette.actions.switchToMission', group: 'global', icon: MessagesSquare,
    keywords: ['mode', 'agent', 'mission', 'switch'],
    when: (ctx) => ctx.flags.agentMode && ctx.uiMode === 'kanban',
    run: (ctx) => ctx.go.setUiMode('agent'),
  },
  {
    id: 'mode.board', labelKey: 'palette.actions.switchToBoard', group: 'global', icon: LayoutDashboard,
    keywords: ['mode', 'kanban', 'board', 'switch'],
    when: (ctx) => ctx.flags.agentMode && ctx.uiMode === 'agent',
    run: (ctx) => ctx.go.setUiMode('kanban'),
  },
  {
    id: 'settings.app', labelKey: 'palette.actions.openAppSettings', group: 'global', icon: Settings,
    keywords: ['settings', 'preferences', 'configuration', 'desktop'],
    when: () => true,
    page: (ctx) => ({
      title: ctx.t('palette.actions.pages.appSettingsTitle'),
      placeholder: ctx.t('palette.actions.pages.sectionPlaceholder'),
      emptyLabel: ctx.t('palette.actions.pages.noSections'),
      options: sectionOptions(APP_SETTINGS_SECTIONS, (id) => ctx.t(`settings:desktop.nav.${id}`)),
    }),
    run: (ctx, arg) => ctx.go.openAppSettings(arg as AppSettingsSection),
  },
  {
    id: 'settings.project', labelKey: 'palette.actions.openProjectSettings', group: 'global', icon: SlidersHorizontal,
    keywords: ['settings', 'preferences', 'configuration', 'project'],
    when: (ctx) => ctx.projectId !== null,
    page: (ctx) => ({
      title: ctx.t('palette.actions.pages.projectSettingsTitle'),
      placeholder: ctx.t('palette.actions.pages.sectionPlaceholder'),
      emptyLabel: ctx.t('palette.actions.pages.noSections'),
      options: sectionOptions(PROJECT_SETTINGS_SECTION_IDS, (id) => ctx.t(`settings:projectDialog.nav.${id}`)),
    }),
    run: (ctx, arg) => ctx.go.openProjectSettings(arg as string),
  },
  {
    id: 'project.switch', labelKey: 'palette.actions.switchProject', group: 'global', icon: FolderOpen,
    keywords: ['project', 'workspace', 'switch', 'change'],
    when: (ctx) => ctx.projects.length > 1,
    page: (ctx) => ({
      title: ctx.t('palette.actions.pages.projectTitle'),
      placeholder: ctx.t('palette.actions.pages.projectPlaceholder'),
      emptyLabel: ctx.t('palette.actions.pages.noProjects'),
      options: ctx.projects.map((p) => ({ id: `project-${p.id}`, label: p.name, hint: p.id === ctx.projectId ? ctx.t('palette.actions.pages.current') : undefined, disabled: p.id === ctx.projectId, arg: p.id })),
    }),
    run: (ctx, arg) => ctx.go.setProject(arg as string),
  },
  {
    id: 'loop.run', labelKey: 'palette.actions.runLoop', group: 'global', icon: Workflow,
    keywords: ['loop', 'run', 'execute', 'workflow'],
    when: (ctx) => ctx.flags.loops && ctx.projectId !== null,
    page: (ctx) => ({
      title: ctx.t('palette.actions.pages.loopTitle'),
      placeholder: ctx.t('palette.actions.pages.loopPlaceholder'),
      emptyLabel: ctx.t('palette.actions.pages.noLoops'),
      load: async () => (await ctx.go.listRunnableLoops()).map((l) => ({ id: `loop-${l.id}`, label: l.name, arg: l })),
    }),
    run: (ctx, arg) => { const l = arg as { id: string; name: string }; ctx.go.runLoop(l.id, l.name) },
  },
  {
    id: 'sidebar.left', labelKey: 'palette.actions.toggleLeftSidebar', group: 'global', icon: PanelLeft, shortcut: '⌘B',
    keywords: ['sidebar', 'panel', 'left', 'pin', 'collapse', 'unpin', 'toggle'],
    resolveLabel: (ctx) => ctx.sidebarLabels.left,
    when: () => true,
    run: (ctx) => ctx.go.toggleLeftSidebar(),
  },
  {
    id: 'sidebar.right', labelKey: 'palette.actions.toggleRightSidebar', group: 'global', icon: PanelRight, shortcut: '⌥⌘B',
    keywords: ['sidebar', 'panel', 'right', 'nav', 'pin', 'collapse', 'unpin', 'toggle'],
    resolveLabel: (ctx) => ctx.sidebarLabels.right,
    when: () => true,
    run: (ctx) => ctx.go.toggleRightSidebar(),
  },
  {
    id: 'history.back', labelKey: 'palette.actions.goBack', group: 'global', icon: ArrowLeft, shortcut: '⌘[',
    keywords: ['back', 'previous', 'history'],
    when: (ctx) => ctx.history?.canBack === true,
    run: (ctx) => ctx.history?.back(),
  },
  {
    id: 'history.forward', labelKey: 'palette.actions.goForward', group: 'global', icon: ArrowRight, shortcut: '⌘]',
    keywords: ['forward', 'next', 'history'],
    when: (ctx) => ctx.history?.canForward === true,
    run: (ctx) => ctx.history?.forward(),
  },
  {
    id: 'undo.last', labelKey: 'palette.actions.undoLast', group: 'global', icon: Undo2, shortcut: '⌘Z',
    keywords: ['undo', 'revert', 'restore'],
    labelParams: (ctx) => ({ label: ctx.undoLabel ?? '' }),
    when: (ctx) => ctx.undoLabel !== null,
    run: (ctx) => ctx.go.undoLast(),
  },
  {
    id: 'inbox.open', labelKey: 'palette.actions.openInbox', group: 'global', icon: Inbox, shortcut: '⌘⇧I',
    keywords: ['inbox', 'needs you', 'attention', 'waiting', 'review', 'questions', 'failed'],
    resolveLabel: (ctx) => (ctx.inbox && ctx.inbox.count > 0 ? ctx.t('palette.actions.openInboxCount', { count: ctx.inbox.count }) : ctx.t('palette.actions.openInbox')),
    when: (ctx) => ctx.inbox !== null,
    run: (ctx) => ctx.inbox?.open(),
  },
  {
    // Caps, projection and what-if all live in Analytics ▸ Budget: one action that opens it. `/budget` finds it too.
    id: 'budget.open', labelKey: 'palette.actions.openBudget', group: 'global', icon: Gauge,
    keywords: ['budget', 'cap', 'limit', 'weekly', 'monthly', 'daily', 'spend', 'cost', 'projection', 'what if'],
    keywordsKey: 'palette.actions.openBudgetKeywords',
    when: (ctx) => ctx.projectId !== null,
    run: () => openBudgetPanel(),
  },
  {
    id: 'trash.open', labelKey: 'palette.actions.recentlyDeleted', group: 'global', icon: Trash2,
    keywords: ['deleted', 'trash', 'restore', 'recover', 'bin'],
    when: (ctx) => ctx.projectId !== null,
    run: (ctx) => ctx.go.openProjectSettings('recentlyDeleted'),
  },
]

/** English keywords plus the localized ones, so `>` finds an action in the viewer's own language. */
export function actionKeywords(action: PaletteAction, ctx: PaletteContext): string[] {
  const base = action.keywords ?? []
  if (!action.keywordsKey) return base
  const localized = ctx.t(action.keywordsKey)
  if (!localized || localized === action.keywordsKey) return base
  return [...base, ...localized.split(',').map((k) => k.trim()).filter(Boolean)]
}

export function actionLabel(action: PaletteAction, ctx: PaletteContext): string {
  return action.resolveLabel ? action.resolveLabel(ctx) : ctx.t(action.labelKey, action.labelParams?.(ctx))
}

export function availableActions(ctx: PaletteContext, actions: readonly PaletteAction[] = PALETTE_ACTIONS): PaletteAction[] {
  return actions.filter((a) => a.when(ctx))
}

// ─── Query: is it an action? ────────────────────────────────────────────────

/** Splits a leading `>` off the query. */
export function parseActionQuery(query: string): { explicit: boolean; text: string } {
  const trimmed = query.trimStart()
  if (trimmed.startsWith('>')) return { explicit: true, text: trimmed.slice(1).trim() }
  return { explicit: false, text: query.trim() }
}

/** Verbs of the locale ("new, launch, move..."), from the `palette.actions.verbs` string. */
export function localeVerbs(t: TFn): string[] {
  return t('palette.actions.verbs').split(',').map((v) => foldText(v.trim())).filter(Boolean)
}

/**
 * True when the query reads like a command: it starts with `>`, or its first
 * word is a verb (or the start, 3+ letters, of one). "new", "launch #15" and
 * "mov" lead with actions; "alpha" or "auth" do not.
 */
export function isActionQuery(query: string, verbs: readonly string[]): boolean {
  const { explicit, text } = parseActionQuery(query)
  if (explicit) return true
  const first = foldText(text).split(/\s+/)[0] ?? ''
  if (!first) return false
  return verbs.some((v) => v === first || (first.length >= 3 && v.startsWith(first)))
}

function matchScore(label: string, keywords: readonly string[], query: string): number {
  const q = foldText(query)
  const l = foldText(label)
  if (l.startsWith(q)) return 0
  if (l.split(/\s+/).some((w) => w.startsWith(q))) return 1
  if (l.includes(q)) return 2
  if (keywords.some((k) => foldText(k).includes(q))) return 3
  return 4
}

export interface RankedActions {
  /** Whether the Actions group leads the list. */
  leading: boolean
  rows: { action: PaletteAction; label: string }[]
}

/**
 * The Actions group for a query. Empty query: none (recents are shown
 * instead). Otherwise matching actions, best match first, capped.
 */
export function rankActions(ctx: PaletteContext, query: string): RankedActions {
  const { explicit, text } = parseActionQuery(query)
  const verbs = localeVerbs(ctx.t)
  const leading = isActionQuery(query, verbs)
  if (!explicit && !text) return { leading: false, rows: [] }
  const labelled = availableActions(ctx).map((action, order) => ({ action, label: actionLabel(action, ctx), keywords: actionKeywords(action, ctx), order }))
  // The text after `>` filters; a lone verb ("new") also matches by label start.
  const matched = labelled.filter(({ label, keywords }) => matchesPaletteQuery(text, label, keywords))
  const preferred: ActionGroup = ctx.uiMode === 'agent' ? 'mission' : 'board'
  const selected = selectionCount(ctx) > 0
  matched.sort((a, b) => {
    const sa = text ? matchScore(a.label, a.keywords, text) : 0
    const sb = text ? matchScore(b.label, b.keywords, text) : 0
    if (sa !== sb) return sa - sb
    // With specs selected, what can be done to the selection comes first.
    if (selected) {
      const xa = a.action.id.startsWith('selection.') ? 0 : 1
      const xb = b.action.id.startsWith('selection.') ? 0 : 1
      if (xa !== xb) return xa - xb
    }
    const ga = a.action.group === preferred ? 0 : 1
    const gb = b.action.group === preferred ? 0 : 1
    if (ga !== gb) return ga - gb
    return a.order - b.order
  })
  const cap = leading ? MAX_ACTION_ROWS : MAX_TRAILING_ACTION_ROWS
  return { leading, rows: matched.slice(0, cap).map(({ action, label }) => ({ action, label })) }
}

/** Available actions behind the ids a viewer ran lately, most recent first. */
export function recentActionRows(ctx: PaletteContext, ids: readonly string[]): { action: PaletteAction; label: string }[] {
  const available = new Map(availableActions(ctx).map((a) => [a.id, a]))
  return ids
    .map((id) => available.get(id))
    .filter((a): a is PaletteAction => !!a)
    .slice(0, MAX_RECENT_ACTIONS)
    .map((action) => ({ action, label: actionLabel(action, ctx) }))
}

/** Filters an argument page's options by the typed text. */
export function filterArgOptions(options: readonly ArgOption[], query: string): ArgOption[] {
  return options.filter((o) => matchesPaletteQuery(query, o.label, o.hint ? [o.hint] : [])).slice(0, MAX_ARG_ROWS * 4)
}
