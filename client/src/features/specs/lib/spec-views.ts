// Saved views of the specs board (CD4): a named snapshot of the status
// selector, the filters, the sort and the density. Per project, in
// localStorage like every other board filter (spec-filters, spec-sort,
// specs-view-tier) so a project switch and an app restart restore them the
// same way. Search text is deliberately not part of a view (it is ephemeral).

import { isSpecStatusFilterValue, type SpecStatusFilterValue } from './spec-status-filter'
import { isSpecsViewTier, type SpecsViewTier } from './specs-view-tier'
import type { SpecSortMode, SpecSortDir } from '../types/spec-sort'

/** URL param of a copied view link (`?view=<id>`). Not a place: selecting a view replaces, never pushes. */
export { VIEW_PARAM } from '../../../lib/places'

export const MAX_SPEC_VIEWS = 30
export const MAX_VIEW_NAME = 60

export interface SpecViewState {
  status: SpecStatusFilterValue
  labels: string[]
  epic: string | null
  sprint: string | null
  jiraStatus: string | null
  sortMode: SpecSortMode
  sortDir: SpecSortDir
  /** Density: compact rows or post-it cards. */
  viewTier: SpecsViewTier
}

export interface SpecView extends SpecViewState {
  id: string
  name: string
}

const KEY = (projectId: string) => `specrails-desktop:spec-views:${projectId}`

const SORT_MODES: readonly SpecSortMode[] = ['default', 'ticket-id', 'priority', 'jira-key']

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function parseView(raw: unknown): SpecView | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id || typeof o.name !== 'string' || !o.name.trim()) return null
  return {
    id: o.id,
    name: o.name.slice(0, MAX_VIEW_NAME),
    status: isSpecStatusFilterValue(o.status) ? o.status : 'active',
    labels: Array.isArray(o.labels) ? o.labels.filter((l): l is string => typeof l === 'string') : [],
    epic: strOrNull(o.epic),
    sprint: strOrNull(o.sprint),
    jiraStatus: strOrNull(o.jiraStatus),
    sortMode: SORT_MODES.includes(o.sortMode as SpecSortMode) ? (o.sortMode as SpecSortMode) : 'default',
    sortDir: o.sortDir === 'asc' ? 'asc' : 'desc',
    viewTier: isSpecsViewTier(o.viewTier) ? o.viewTier : 'postit',
  }
}

export function loadSpecViews(projectId: string | null): SpecView[] {
  if (!projectId) return []
  try {
    const raw = localStorage.getItem(KEY(projectId))
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.map(parseView).filter((v): v is SpecView => v !== null).slice(0, MAX_SPEC_VIEWS)
  } catch {
    return []
  }
}

export function saveSpecViews(projectId: string | null, views: readonly SpecView[]): void {
  if (!projectId) return
  try {
    if (views.length === 0) localStorage.removeItem(KEY(projectId))
    else localStorage.setItem(KEY(projectId), JSON.stringify(views))
  } catch {
    /* private mode / quota — best-effort */
  }
}

function newViewId(existing: readonly SpecView[]): string {
  const taken = new Set(existing.map((v) => v.id))
  for (let i = 0; i < 20; i += 1) {
    const id = Math.random().toString(36).slice(2, 10)
    if (id && !taken.has(id)) return id
  }
  return `v${Date.now().toString(36)}`
}

export function cleanViewName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, MAX_VIEW_NAME)
}

/** Adds a view; returns the new list and the created view (null when the name is empty or the list is full). */
export function addSpecView(views: readonly SpecView[], name: string, state: SpecViewState): { views: SpecView[]; created: SpecView | null } {
  const clean = cleanViewName(name)
  if (!clean || views.length >= MAX_SPEC_VIEWS) return { views: [...views], created: null }
  const created: SpecView = { ...cloneState(state), id: newViewId(views), name: clean }
  return { views: [...views, created], created }
}

export function renameSpecView(views: readonly SpecView[], id: string, name: string): SpecView[] {
  const clean = cleanViewName(name)
  if (!clean) return [...views]
  return views.map((v) => (v.id === id ? { ...v, name: clean } : v))
}

export function deleteSpecView(views: readonly SpecView[], id: string): SpecView[] {
  return views.filter((v) => v.id !== id)
}

/** "Update from current": overwrite a view's snapshot, keeping id and name. */
export function updateSpecView(views: readonly SpecView[], id: string, state: SpecViewState): SpecView[] {
  return views.map((v) => (v.id === id ? { ...cloneState(state), id: v.id, name: v.name } : v))
}

function cloneState(s: SpecViewState): SpecViewState {
  return {
    status: s.status,
    labels: [...s.labels].sort(),
    epic: s.epic,
    sprint: s.sprint,
    jiraStatus: s.jiraStatus,
    sortMode: s.sortMode,
    sortDir: s.sortDir,
    viewTier: s.viewTier,
  }
}

/** True when the board is exactly at this view (label order ignored; sort direction only matters off `default`). */
export function viewMatchesState(view: SpecViewState, current: SpecViewState): boolean {
  const a = cloneState(view)
  const b = cloneState(current)
  return a.status === b.status
    && a.epic === b.epic
    && a.sprint === b.sprint
    && a.jiraStatus === b.jiraStatus
    && a.sortMode === b.sortMode
    && (a.sortMode === 'default' || a.sortDir === b.sortDir)
    && a.viewTier === b.viewTier
    && a.labels.length === b.labels.length
    && a.labels.every((l, i) => l === b.labels[i])
}

/** The link a copied view resolves to: the current location with `?p=<project>&view=<id>`. */
export function buildViewLink(projectId: string, viewId: string, base: { origin: string; pathname: string } = window.location): string {
  const params = new URLSearchParams({ p: projectId, view: viewId })
  return `${base.origin}${base.pathname}?${params.toString()}`
}
