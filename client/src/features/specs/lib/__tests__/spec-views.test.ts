import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  addSpecView,
  buildViewLink,
  decodeViewState,
  encodeViewState,
  deleteSpecView,
  loadSpecViews,
  renameSpecView,
  saveSpecViews,
  updateSpecView,
  viewMatchesState,
  MAX_SPEC_VIEWS,
  type SpecViewState,
} from '../spec-views'

const base: SpecViewState = {
  status: 'todo',
  labels: ['b', 'a'],
  epic: null,
  sprint: 'S42',
  jiraStatus: null,
  sortMode: 'priority',
  sortDir: 'asc',
  viewTier: 'row',
}

describe('spec-views', () => {
  beforeEach(() => localStorage.clear())

  it('creates, renames, updates and deletes views', () => {
    let { views, created } = addSpecView([], '  Ready   to launch ', base)
    expect(created?.name).toBe('Ready to launch')
    expect(created?.labels).toEqual(['a', 'b'])
    views = renameSpecView(views, created!.id, 'Sprint 42')
    expect(views[0].name).toBe('Sprint 42')
    views = renameSpecView(views, created!.id, '   ')
    expect(views[0].name).toBe('Sprint 42')
    views = updateSpecView(views, created!.id, { ...base, status: 'done', labels: [] })
    expect(views[0]).toMatchObject({ id: created!.id, name: 'Sprint 42', status: 'done', labels: [] })
    expect(deleteSpecView(views, created!.id)).toEqual([])
  })

  it('refuses an empty name and a full list', () => {
    expect(addSpecView([], '   ', base).created).toBeNull()
    let views: ReturnType<typeof addSpecView>['views'] = []
    for (let i = 0; i < MAX_SPEC_VIEWS; i += 1) views = addSpecView(views, `v${i}`, base).views
    expect(views).toHaveLength(MAX_SPEC_VIEWS)
    expect(addSpecView(views, 'one more', base).created).toBeNull()
  })

  it('persists per project and tolerates garbage', () => {
    const { views } = addSpecView([], 'A', base)
    saveSpecViews('p1', views)
    expect(loadSpecViews('p1')).toEqual(views)
    expect(loadSpecViews('p2')).toEqual([])
    expect(loadSpecViews(null)).toEqual([])
    localStorage.setItem('specrails-desktop:spec-views:p3', '{nope')
    expect(loadSpecViews('p3')).toEqual([])
    localStorage.setItem('specrails-desktop:spec-views:p3', JSON.stringify([{ id: 'x', name: 'ok', status: 'bogus', sortMode: 'zzz' }, { nope: 1 }]))
    expect(loadSpecViews('p3')).toEqual([expect.objectContaining({ id: 'x', status: 'active', sortMode: 'default', viewTier: 'postit' })])
    saveSpecViews('p1', [])
    expect(localStorage.getItem('specrails-desktop:spec-views:p1')).toBeNull()
  })

  it('never throws when storage is unavailable', () => {
    const spy = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('quota') })
    expect(() => saveSpecViews('p1', addSpecView([], 'A', base).views)).not.toThrow()
    spy.mockRestore()
    const get = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => { throw new Error('denied') })
    expect(loadSpecViews('p1')).toEqual([])
    get.mockRestore()
  })

  it('matches the current state ignoring label order', () => {
    expect(viewMatchesState(base, { ...base, labels: ['a', 'b'] })).toBe(true)
    expect(viewMatchesState(base, { ...base, status: 'all' })).toBe(false)
    expect(viewMatchesState(base, { ...base, viewTier: 'postit' })).toBe(false)
    expect(viewMatchesState({ ...base, sortMode: 'default' }, { ...base, sortMode: 'default', sortDir: 'desc' })).toBe(true)
  })

  it('builds a link carrying project and view', () => {
    expect(buildViewLink('p 1', 'abc', { origin: 'http://localhost:5173', pathname: '/' })).toBe('http://localhost:5173/?p=p+1&view=abc')
  })

  it('round-trips a view state through the link token (any script, URL-safe)', () => {
    const state: SpecViewState = { ...base, labels: ['a', 'día', '日本語'], epic: 'Épica ✓' }
    const token = encodeViewState(state)
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeViewState(token)).toEqual({ ...state, labels: ['a', 'día', '日本語'].sort() })
    const link = buildViewLink('p1', state, { origin: 'http://x', pathname: '/' })
    expect(new URL(link).searchParams.get('view')).toBe(token)
  })

  it('refuses a token that is not a view state and normalises a partial one', () => {
    expect(decodeViewState('not base64 !!')).toBeNull()
    expect(decodeViewState('e30')).toMatchObject({ status: 'active', labels: [], sortMode: 'default' }) // {}
    expect(decodeViewState(btoa('[1,2]').replace(/=+$/, ''))).toMatchObject({ status: 'active' })
  })
})
