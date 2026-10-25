import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import enCommands from '../../../locales/en/commands.json'
import {
  MAX_ACTION_ROWS,
  MAX_RECENT_ACTIONS,
  MAX_TRAILING_ACTION_ROWS,
  PALETTE_ACTIONS,
  actionLabel,
  availableActions,
  filterArgOptions,
  isActionQuery,
  localeVerbs,
  parseActionQuery,
  rankActions,
  recentActionRows,
  type PaletteContext,
} from '../palette-actions'
import { RECENT_ACTIONS_KEY, readRecentActionIds, recordRecentAction } from '../recent-actions'
import { PROJECT_SETTINGS_SECTIONS } from '../../../features/settings/components/project-settings-sections'
import { PROJECT_SETTINGS_SECTION_IDS } from '../../../features/settings/lib/project-settings-section-ids'
import type { PaletteBoardSurface, PaletteFlowControl, PaletteSelectionSurface } from '../../../lib/palette-bridge'

// English resolver for the keys the registry uses (interpolates {{x}}).
function t(key: string, options?: Record<string, unknown>): string {
  const value = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], (enCommands as Record<string, unknown>))
  const raw = typeof value === 'string' ? value : key
  return raw.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? ''))
}
const tAny = ((key: string, options?: Record<string, unknown>) => (key.startsWith('settings:') ? key.slice(9) : t(key, options)))

function board(overrides: Partial<PaletteBoardSurface> = {}): PaletteBoardSurface {
  return {
    specs: () => [{ id: 14, title: 'Reviewable', status: 'on_review' }, { id: 15, title: 'Add achievements', status: 'todo' }],
    rails: () => [{ id: 'r1', label: 'Rail 1', running: false, hasSpec: false }, { id: 'r2', label: 'Rail 2', running: true, hasSpec: false }],
    launchBlocker: (id) => (id === 14 ? 'On review' : null),
    launchOnRail: vi.fn(),
    statusOptions: async () => [{ id: 'todo', label: 'To do', current: true }, { id: 'done', label: 'Done', current: false }],
    moveStatus: vi.fn(),
    reviewPath: (id) => (id === 14 ? '/review/pr-1' : null),
    ...overrides,
  }
}

function ctx(overrides: Partial<PaletteContext> = {}): PaletteContext {
  return {
    t: tAny,
    uiMode: 'kanban',
    projectId: 'p1',
    projects: [{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }],
    focusedSpecId: null,
    surfaces: {},
    flags: { agentMode: true, loops: true },
    theme: { id: 'specrails', set: vi.fn(async () => {}) },
    history: { canBack: true, canForward: false, back: vi.fn(), forward: vi.fn() },
    undoLabel: null,
    inbox: null,
    sidebarLabels: { left: 'Collapse left sidebar (keep pinned)', right: 'Pin right sidebar open' },
    go: {
      navigate: vi.fn(), setUiMode: vi.fn(), openAppSettings: vi.fn(), openProjectSettings: vi.fn(), newMission: vi.fn(), setProject: vi.fn(),
      toggleLeftSidebar: vi.fn(), toggleRightSidebar: vi.fn(), undoLast: vi.fn(),
      listRunnableLoops: async () => [{ id: 'l1', name: 'CI watch' }], runLoop: vi.fn(),
    },
    ...overrides,
  }
}

const ids = (c: PaletteContext) => availableActions(c).map((a) => a.id)

describe('spec hand-off actions (BB2)', () => {
  const handoff = (id: number) => ({ ticketId: () => id, exportHandoff: vi.fn(), copyPrDescription: vi.fn() })

  it('exist only while the modal of the focused spec is mounted', () => {
    expect(ids(ctx({ focusedSpecId: 7 }))).not.toContain('spec.exportHandoff')
    expect(ids(ctx({ focusedSpecId: null, surfaces: { handoff: handoff(7) } }))).not.toContain('spec.exportHandoff')
    expect(ids(ctx({ focusedSpecId: 8, surfaces: { handoff: handoff(7) } }))).not.toContain('spec.copyPrDescription')
    const open = ids(ctx({ focusedSpecId: 7, surfaces: { handoff: handoff(7) } }))
    expect(open).toContain('spec.exportHandoff')
    expect(open).toContain('spec.copyPrDescription')
  })

  it('name the spec and call the surface with it', () => {
    const surface = handoff(7)
    const c = ctx({ focusedSpecId: 7, surfaces: { handoff: surface } })
    const exportAction = PALETTE_ACTIONS.find((a) => a.id === 'spec.exportHandoff')!
    const copyAction = PALETTE_ACTIONS.find((a) => a.id === 'spec.copyPrDescription')!
    expect(actionLabel(exportAction, c)).toBe('Export hand-off for #7')
    expect(actionLabel(copyAction, c)).toBe('Copy PR description for #7')
    exportAction.run(c, undefined)
    copyAction.run(c, undefined)
    expect(surface.exportHandoff).toHaveBeenCalledWith(7)
    expect(surface.copyPrDescription).toHaveBeenCalledWith(7)
  })
})

describe('registry', () => {
  it('has unique ids and a bounded size', () => {
    const all = PALETTE_ACTIONS.map((a) => a.id)
    expect(new Set(all).size).toBe(all.length)
    expect(all.length).toBeGreaterThanOrEqual(20)
    // 30 before the board selection / saved-views actions (CD4); they exist only while mounted + selected.
    // 36 with the spec hand-off pair (BB2); they exist only while that spec's modal is open.
    // 37 with Move focused spec (BB4); it exists only while a board card has been focused.
    expect(all.length).toBeLessThanOrEqual(37)
  })

  it('pins the project settings ids to the real sections', () => {
    expect([...PROJECT_SETTINGS_SECTION_IDS]).toEqual(PROJECT_SETTINGS_SECTIONS.map((s) => s.id))
  })

  it('every label key exists in the English catalog', () => {
    for (const action of PALETTE_ACTIONS) {
      expect(t(action.labelKey), action.id).not.toBe(action.labelKey)
    }
  })
})

describe('availability per context', () => {
  it('offers only global actions with nothing mounted', () => {
    const got = ids(ctx())
    expect(got).toEqual(expect.arrayContaining(['theme.switch', 'mode.mission', 'settings.app', 'settings.project', 'project.switch', 'loop.run', 'sidebar.left', 'sidebar.right', 'history.back', 'trash.open']))
    expect(got).not.toContain('spec.new')
    expect(got).not.toContain('spec.launch')
    expect(got).not.toContain('flow.pause')
    expect(got).not.toContain('mission.new')
    expect(got).not.toContain('mode.board')
    expect(got).not.toContain('history.forward')
    expect(got).not.toContain('undo.last')
  })

  it('adds the board actions when the surfaces are mounted', () => {
    const got = ids(ctx({ surfaces: { specs: { openNewSpec: vi.fn() }, board: board() } }))
    expect(got).toEqual(expect.arrayContaining(['spec.new', 'spec.newExplore', 'spec.launch', 'spec.move', 'spec.review']))
  })

  it('hides Launch when the focused spec is blocked, and Review when it has no packet', () => {
    const blocked = ctx({ focusedSpecId: 14, surfaces: { board: board() } })
    expect(ids(blocked)).not.toContain('spec.launch')
    expect(ids(blocked)).toContain('spec.review')
    const plain = ctx({ focusedSpecId: 15, surfaces: { board: board() } })
    expect(ids(plain)).toContain('spec.launch')
    expect(ids(plain)).not.toContain('spec.review')
  })

  it('hides Launch with no focused spec when nothing is launchable', () => {
    const none = ctx({ surfaces: { board: board({ launchBlocker: () => 'blocked' }) } })
    expect(ids(none)).not.toContain('spec.launch')
  })

  it('shows mission actions only for the controls the Flow strip offers', () => {
    const control = (id: PaletteFlowControl['id'], disabled = false): PaletteFlowControl => ({ id, label: id, disabled, run: vi.fn() })
    const active = ctx({ uiMode: 'agent', surfaces: { flow: { controls: () => [control('pause'), control('hand-off')] } } })
    expect(ids(active)).toEqual(expect.arrayContaining(['flow.pause', 'flow.handOff', 'mission.new', 'mode.board']))
    expect(ids(active)).not.toContain('flow.resume')
    const paused = ctx({ uiMode: 'agent', surfaces: { flow: { controls: () => [control('resume'), control('hand-off', true)] } } })
    expect(ids(paused)).toContain('flow.resume')
    expect(ids(paused)).not.toContain('flow.handOff') // disabled in the strip => not offered
  })

  it('follows the feature flags, the project, undo and history', () => {
    const c = ctx({ flags: { agentMode: false, loops: false }, projectId: null, projects: [{ id: 'p1', name: 'A' }], undoLabel: 'Spec #3 deleted', history: { canBack: false, canForward: true, back: vi.fn(), forward: vi.fn() } })
    const got = ids(c)
    expect(got).not.toContain('mode.mission')
    expect(got).not.toContain('loop.run')
    expect(got).not.toContain('settings.project')
    expect(got).not.toContain('trash.open')
    expect(got).not.toContain('project.switch')
    expect(got).toContain('undo.last')
    expect(got).toContain('history.forward')
    expect(got).not.toContain('history.back')
  })

  it('offers Open inbox only where an inbox exists, shows how many wait, and opens it', () => {
    expect(ids(ctx({ inbox: null }))).not.toContain('inbox.open')
    const open = vi.fn()
    const c = ctx({ inbox: { count: 3, open } })
    expect(ids(c)).toContain('inbox.open')
    const action = PALETTE_ACTIONS.find((a) => a.id === 'inbox.open')!
    expect(actionLabel(action, c)).toBe('Open inbox (3 waiting)')
    expect(actionLabel(action, ctx({ inbox: { count: 0, open } }))).toBe('Open inbox')
    expect(action.shortcut).toBe('⌘⇧I')
    action.run(c)
    expect(open).toHaveBeenCalledOnce()
  })

  it('every action with a shortcut declares a key string', () => {
    for (const a of PALETTE_ACTIONS.filter((x) => x.shortcut)) expect(a.shortcut!.length).toBeGreaterThan(0)
    expect(PALETTE_ACTIONS.find((a) => a.id === 'undo.last')!.shortcut).toBe('⌘Z')
    expect(PALETTE_ACTIONS.find((a) => a.id === 'history.back')!.shortcut).toBe('⌘[')
  })
})

describe('query: is it an action', () => {
  const verbs = localeVerbs(t)
  it('parses the > prefix', () => {
    expect(parseActionQuery('> theme')).toEqual({ explicit: true, text: 'theme' })
    expect(parseActionQuery('theme')).toEqual({ explicit: false, text: 'theme' })
  })
  it('leads with actions for > and for verbs, not for nouns', () => {
    expect(isActionQuery('>', verbs)).toBe(true)
    expect(isActionQuery('new spec', verbs)).toBe(true)
    expect(isActionQuery('Launch #15', verbs)).toBe(true)
    expect(isActionQuery('mov', verbs)).toBe(true)
    expect(isActionQuery('ne', verbs)).toBe(false) // too short to commit to a verb
    expect(isActionQuery('alpha', verbs)).toBe(false)
    expect(isActionQuery('', verbs)).toBe(false)
  })
})

describe('rankActions', () => {
  const full = ctx({ surfaces: { specs: { openNewSpec: vi.fn() }, board: board() } })

  it('returns nothing for an empty query and everything (capped) for a bare >', () => {
    expect(rankActions(full, '').rows).toEqual([])
    const all = rankActions(full, '>')
    expect(all.leading).toBe(true)
    expect(all.rows.length).toBe(MAX_ACTION_ROWS)
  })

  it('ranks label matches first and the board actions first on the board', () => {
    const r = rankActions(full, 'new')
    expect(r.leading).toBe(true)
    expect(r.rows[0].action.id).toBe('spec.new')
    expect(r.rows.map((x) => x.action.id)).toContain('spec.newExplore')
  })

  it('finds an action by an English keyword in any locale and trails for non-verbs', () => {
    const r = rankActions(full, 'dark')
    expect(r.leading).toBe(false)
    expect(r.rows.map((x) => x.action.id)).toContain('theme.switch')
  })

  it('caps a trailing group harder than a leading one', () => {
    const r = rankActions(full, 'e') // matches most labels, not an action-like query
    expect(r.leading).toBe(false)
    expect(r.rows.length).toBe(MAX_TRAILING_ACTION_ROWS)
  })

  it('names the focused spec in the label', () => {
    const r = rankActions(ctx({ focusedSpecId: 15, surfaces: { board: board() } }), 'launch')
    expect(r.rows[0].label).toBe('Launch #15 on rail')
  })

  it('prefers mission actions in Mission mode', () => {
    const c = ctx({ uiMode: 'agent', surfaces: { board: board() } })
    expect(rankActions(c, '>').rows[0].action.group).toBe('mission')
  })
})

describe('argument pages', () => {
  it('Launch: spec picker then rail picker; a blocker or running rail disables options', () => {
    const c = ctx({ surfaces: { board: board() } })
    const launch = PALETTE_ACTIONS.find((a) => a.id === 'spec.launch')!
    const specs = launch.page!(c)!
    expect(specs.options!.map((o) => o.id)).toEqual(['spec-15']) // #14 is blocked: not offered
    const rails = specs.options![0].next!
    expect(rails.options!.map((o) => [o.id, o.disabled])).toEqual([['rail-r1', false], ['rail-r2', true]])
    expect(rails.options![0].arg).toEqual({ ticketId: 15, railId: 'r1' })
  })

  it('Launch with a focused spec goes straight to the rails', () => {
    const c = ctx({ focusedSpecId: 15, surfaces: { board: board() } })
    const page = PALETTE_ACTIONS.find((a) => a.id === 'spec.launch')!.page!(c)!
    expect(page.options!.map((o) => o.id)).toEqual(['rail-r1', 'rail-r2'])
  })

  it('Move loads the status options and disables the current one', async () => {
    const c = ctx({ focusedSpecId: 15, surfaces: { board: board() } })
    const page = PALETTE_ACTIONS.find((a) => a.id === 'spec.move')!.page!(c)!
    const options = await page.load!()
    expect(options.map((o) => [o.id, o.disabled])).toEqual([['status-todo', true], ['status-done', false]])
    expect(options[1].arg).toEqual({ ticketId: 15, optionId: 'done' })
  })

  it('Review: no page when a spec is focused, a picker of reviewable specs otherwise', () => {
    const review = PALETTE_ACTIONS.find((a) => a.id === 'spec.review')!
    expect(review.page!(ctx({ focusedSpecId: 14, surfaces: { board: board() } }))).toBeNull()
    expect(review.page!(ctx({ surfaces: { board: board() } }))!.options!.map((o) => o.id)).toEqual(['spec-14'])
  })

  it('Theme, settings and project pages list their targets', () => {
    const c = ctx()
    const theme = PALETTE_ACTIONS.find((a) => a.id === 'theme.switch')!.page!(c)!
    expect(theme.options!.length).toBeGreaterThanOrEqual(5)
    expect(theme.options!.find((o) => o.arg === 'specrails')!.disabled).toBe(true)
    const app = PALETTE_ACTIONS.find((a) => a.id === 'settings.app')!.page!(c)!
    expect(app.options!.map((o) => o.arg)).toContain('appearance')
    const proj = PALETTE_ACTIONS.find((a) => a.id === 'settings.project')!.page!(c)!
    expect(proj.options!.map((o) => o.arg)).toEqual([...PROJECT_SETTINGS_SECTION_IDS])
    const switchProject = PALETTE_ACTIONS.find((a) => a.id === 'project.switch')!.page!(c)!
    expect(switchProject.options!.map((o) => [o.arg, o.disabled])).toEqual([['p1', true], ['p2', false]])
  })

  it('filters options by the typed text', () => {
    const opts = [{ id: 'a', label: 'Rail 1' }, { id: 'b', label: 'Rail 2', hint: 'running' }]
    expect(filterArgOptions(opts, '2').map((o) => o.id)).toEqual(['b'])
    expect(filterArgOptions(opts, 'running').map((o) => o.id)).toEqual(['b'])
  })
})

describe('actions run the real handlers', () => {
  it('New spec / Explore open the modal in the right mode', () => {
    const openNewSpec = vi.fn()
    const c = ctx({ surfaces: { specs: { openNewSpec } } })
    PALETTE_ACTIONS.find((a) => a.id === 'spec.new')!.run(c)
    PALETTE_ACTIONS.find((a) => a.id === 'spec.newExplore')!.run(c)
    expect(openNewSpec.mock.calls).toEqual([['quick'], ['explore']])
  })

  it('Launch / Move / Review delegate to the board surface', () => {
    const b = board()
    const c = ctx({ surfaces: { board: b } })
    PALETTE_ACTIONS.find((a) => a.id === 'spec.launch')!.run(c, { ticketId: 15, railId: 'r1' })
    expect(b.launchOnRail).toHaveBeenCalledWith(15, 'r1')
    PALETTE_ACTIONS.find((a) => a.id === 'spec.move')!.run(c, { ticketId: 15, optionId: 'done' })
    expect(b.moveStatus).toHaveBeenCalledWith(15, 'done')
    PALETTE_ACTIONS.find((a) => a.id === 'spec.review')!.run(c, 14)
    expect(c.go.navigate).toHaveBeenCalledWith('/review/pr-1')
  })

  it('Flow actions run the strip control, theme/mode/settings call the app callbacks', () => {
    const run = vi.fn()
    const c = ctx({ uiMode: 'agent', surfaces: { flow: { controls: () => [{ id: 'pause', label: 'Pause', disabled: false, run }] } } })
    PALETTE_ACTIONS.find((a) => a.id === 'flow.pause')!.run(c)
    expect(run).toHaveBeenCalled()
    PALETTE_ACTIONS.find((a) => a.id === 'theme.switch')!.run(c, 'galaxy')
    expect(c.theme!.set).toHaveBeenCalledWith('galaxy')
    PALETTE_ACTIONS.find((a) => a.id === 'mode.board')!.run(c)
    expect(c.go.setUiMode).toHaveBeenCalledWith('kanban')
    PALETTE_ACTIONS.find((a) => a.id === 'settings.app')!.run(c, 'mobile')
    expect(c.go.openAppSettings).toHaveBeenCalledWith('mobile')
    PALETTE_ACTIONS.find((a) => a.id === 'trash.open')!.run(c)
    expect(c.go.openProjectSettings).toHaveBeenCalledWith('recentlyDeleted')
  })
})

describe('recent actions', () => {
  beforeEach(() => window.localStorage.clear())

  it('keeps the latest first, without repeats, capped', () => {
    for (const id of ['a', 'b', 'c', 'a', 'd', 'e', 'f']) recordRecentAction(id)
    expect(readRecentActionIds()).toEqual(['f', 'e', 'd', 'a', 'c'])
    expect(readRecentActionIds().length).toBe(MAX_RECENT_ACTIONS)
  })

  it('survives corrupt or unavailable storage', () => {
    window.localStorage.setItem(RECENT_ACTIONS_KEY, '{nope')
    expect(readRecentActionIds()).toEqual([])
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(() => recordRecentAction('x')).not.toThrow()
    spy.mockRestore()
  })

  it('lists only the recents that are still available', () => {
    const c = ctx()
    const rows = recentActionRows(c, ['spec.new', 'theme.switch'])
    expect(rows.map((r) => r.action.id)).toEqual(['theme.switch'])
  })
})

describe('locales', () => {
  const root = resolve(__dirname, '../../../locales')
  const flatten = (o: unknown, prefix = ''): string[] =>
    o && typeof o === 'object' ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => flatten(v, `${prefix}${k}.`)) : [prefix.slice(0, -1)]

  it('ships every palette action key and verb list in all 8 locales', () => {
    const base = flatten((enCommands as { palette: unknown }).palette)
    for (const loc of ['en', 'es', 'fr', 'de', 'pt', 'it', 'zh', 'ja']) {
      const json = JSON.parse(readFileSync(resolve(root, loc, 'commands.json'), 'utf8')) as { palette: { actions: { verbs: string } } }
      const keys = new Set(flatten(json.palette))
      for (const k of base.filter((x) => x.startsWith('actions.') || x.startsWith('groups.') || x.startsWith('footer.'))) {
        expect(keys.has(k), `${loc}: ${k}`).toBe(true)
      }
      expect(json.palette.actions.verbs.split(',').length).toBeGreaterThan(8)
    }
  })
})


describe('board selection and saved views (CD4)', () => {
  function selection(count: number, overrides: Partial<PaletteSelectionSurface> = {}): PaletteSelectionSurface {
    return {
      count: () => count,
      selectAllInColumn: vi.fn(),
      clear: vi.fn(),
      statusOptions: async () => [{ id: 'local:done', label: 'Done', current: false }],
      moveStatus: vi.fn(),
      priorityOptions: () => [{ id: 'high', label: 'high' }],
      setPriority: vi.fn(),
      labelOptions: () => ['bug'],
      addLabel: vi.fn(),
      railOptions: () => [{ id: 'r1', label: 'Rail 1', running: false }, { id: 'r2', label: 'Rail 2', running: true }],
      addToRail: vi.fn(),
      launch: vi.fn(),
      remove: vi.fn(),
      views: () => [{ id: 'v1', name: 'Ready to launch' }],
      switchView: vi.fn(),
      saveCurrentView: vi.fn(),
      ...overrides,
    }
  }
  const BULK = ['selection.move', 'selection.label', 'selection.priority', 'selection.rail', 'selection.launch', 'selection.delete', 'selection.clear']
  const action = (id: string) => PALETTE_ACTIONS.find((a) => a.id === id)!

  it('lists what can be done to the selection first when specs are selected (and not otherwise)', () => {
    const withSelection = ctx({ surfaces: { board: board(), selection: selection(2), specs: { openNewSpec: vi.fn() } } })
    const leading = rankActions(withSelection, '>').rows.map((r) => r.action.id)
    expect(leading.every((id) => id.startsWith('selection.'))).toBe(true)
    expect(leading).toEqual(expect.arrayContaining(BULK))
    // A typed query still ranks by match quality first: "new" leads with the new-spec action.
    expect(rankActions(withSelection, 'new').rows[0].action.id).toBe('spec.new')
    // No selection: the board's own actions lead as before.
    const none = rankActions(ctx({ surfaces: { board: board(), selection: selection(0), specs: { openNewSpec: vi.fn() } } }), '>').rows.map((r) => r.action.id)
    expect(none[0]).toBe('spec.new')
  })

  it('offers one action that opens the Budget panel, only with a project', () => {
    expect(ids(ctx())).toContain('budget.open')
    expect(ids(ctx({ projectId: null }))).not.toContain('budget.open')
    const opened = vi.fn()
    window.addEventListener('specrails:open-budget-panel', opened)
    try {
      PALETTE_ACTIONS.find((a) => a.id === 'budget.open')!.run(ctx())
      expect(opened).toHaveBeenCalledTimes(1)
    } finally { window.removeEventListener('specrails:open-budget-panel', opened) }
    expect(rankActions(ctx(), 'weekly').rows.map((r) => r.action.id)).toContain('budget.open')
  })

  it('offers select-all, save view and switch view with the board mounted, and no bulk action without a selection', () => {
    const got = ids(ctx({ surfaces: { board: board(), selection: selection(0) } }))
    expect(got).toEqual(expect.arrayContaining(['selection.selectAll', 'view.save', 'view.switch']))
    for (const id of BULK) expect(got).not.toContain(id)
  })

  it('offers every bulk action while specs are selected, and nothing without the surface', () => {
    const got = ids(ctx({ surfaces: { board: board(), selection: selection(3) } }))
    expect(got).toEqual(expect.arrayContaining(BULK))
    const none = ids(ctx({ surfaces: { board: board() } }))
    for (const id of [...BULK, 'selection.selectAll', 'view.save', 'view.switch']) expect(none).not.toContain(id)
  })

  it('hides Switch view without saved views and Add label without labels to add', () => {
    const got = ids(ctx({ surfaces: { selection: selection(2, { views: () => [], labelOptions: () => [] }) } }))
    expect(got).not.toContain('view.switch')
    expect(got).not.toContain('selection.label')
  })

  it('runs the surface handlers: select all, clear, launch, delete, save view', () => {
    const sel = selection(2)
    const c = ctx({ surfaces: { selection: sel } })
    action('selection.selectAll').run(c)
    action('selection.clear').run(c)
    action('selection.launch').run(c)
    action('selection.delete').run(c)
    action('view.save').run(c)
    expect(sel.selectAllInColumn).toHaveBeenCalled()
    expect(sel.clear).toHaveBeenCalled()
    expect(sel.launch).toHaveBeenCalled()
    expect(sel.remove).toHaveBeenCalled()
    expect(sel.saveCurrentView).toHaveBeenCalled()
  })

  it('argument pages hand the picked option to the surface', async () => {
    const sel = selection(2)
    const c = ctx({ surfaces: { selection: sel } })
    const status = await action('selection.move').page!(c)!.load!()
    expect(status).toEqual([expect.objectContaining({ label: 'Done', arg: 'local:done' })])
    action('selection.move').run(c, status[0].arg)
    expect(sel.moveStatus).toHaveBeenCalledWith('local:done')
    action('selection.priority').run(c, action('selection.priority').page!(c)!.options![0].arg)
    expect(sel.setPriority).toHaveBeenCalledWith('high')
    action('selection.label').run(c, 'bug')
    expect(sel.addLabel).toHaveBeenCalledWith('bug')
    const rails = action('selection.rail').page!(c)!.options!
    expect(rails.map((r) => r.disabled)).toEqual([false, true])
    action('selection.rail').run(c, 'r1')
    expect(sel.addToRail).toHaveBeenCalledWith('r1')
    const views = action('view.switch').page!(c)!.options!
    action('view.switch').run(c, views[0].arg)
    expect(sel.switchView).toHaveBeenCalledWith('v1')
  })
})
