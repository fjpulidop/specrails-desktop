import { describe, expect, it } from 'vitest'
import { getGlobalRouteModeTransition, loopBuilderIdForPath, modalSurfaceForPath, reviewDeliveryIdForPath } from '../global-route-mode-transition'

describe('global route mode transitions', () => {
  it('maps Loops and Plugins routes to mission modal surfaces', () => {
    expect(modalSurfaceForPath('/loops')).toBe('loops')
    expect(modalSurfaceForPath('/loops/factory-1/edit')).toBe('loops')
    expect(modalSurfaceForPath('/plugins')).toBe('plugins')
    expect(modalSurfaceForPath('/docs')).toBeNull()
    expect(modalSurfaceForPath('/')).toBeNull()
  })

  it('modalizes Loops and sends the background to New Mission when entering Mission mode from Board', () => {
    expect(getGlobalRouteModeTransition({
      uiMode: 'agent',
      pathname: '/loops',
      loopsOpen: false,
      pluginsOpen: false,
    })).toEqual({ kind: 'modalize', surface: 'loops', backgroundPath: '/' })
  })

  it('modalizes Plugins and sends the background to New Mission when entering Mission mode from Board', () => {
    expect(getGlobalRouteModeTransition({
      uiMode: 'agent',
      pathname: '/plugins',
      loopsOpen: false,
      pluginsOpen: false,
    })).toEqual({ kind: 'modalize', surface: 'plugins', backgroundPath: '/' })
  })

  it('routes mission modals back into Board pages when returning to Board mode', () => {
    expect(getGlobalRouteModeTransition({
      uiMode: 'kanban',
      pathname: '/',
      loopsOpen: true,
      pluginsOpen: false,
    })).toEqual({ kind: 'route', surface: 'loops', path: '/loops' })

    expect(getGlobalRouteModeTransition({
      uiMode: 'kanban',
      pathname: '/',
      loopsOpen: false,
      pluginsOpen: true,
    })).toEqual({ kind: 'route', surface: 'plugins', path: '/plugins' })
  })

  it('extracts the loop id from the builder route only', () => {
    expect(loopBuilderIdForPath('/loops/abc-123/edit')).toBe('abc-123')
    expect(loopBuilderIdForPath('/loops/abc-123/edit/')).toBe('abc-123')
    expect(loopBuilderIdForPath('/loops')).toBeNull()
    expect(loopBuilderIdForPath('/loops/abc-123')).toBeNull()
    expect(loopBuilderIdForPath('/plugins')).toBeNull()
  })

  it('mission mode modalizes the builder route carrying the loop id', () => {
    expect(getGlobalRouteModeTransition({
      uiMode: 'agent',
      pathname: '/loops/loop-9/edit',
      loopsOpen: false,
      pluginsOpen: false,
    })).toEqual({ kind: 'modalize', surface: 'loops', backgroundPath: '/', loopBuilderId: 'loop-9' })

    expect(getGlobalRouteModeTransition({
      uiMode: 'agent',
      pathname: '/loops',
      loopsOpen: false,
      pluginsOpen: false,
    })).toEqual({ kind: 'modalize', surface: 'loops', backgroundPath: '/' })
  })

  it('mission mode modalizes the review packet route with its delivery id and never resets the mission', () => {
    expect(modalSurfaceForPath('/review/abc-123')).toBe('review')
    expect(reviewDeliveryIdForPath('/review/abc-123')).toBe('abc-123')
    expect(reviewDeliveryIdForPath('/review')).toBeNull()
    expect(getGlobalRouteModeTransition({ uiMode: 'agent', pathname: '/review/abc-123', loopsOpen: false, pluginsOpen: false })).toEqual({
      kind: 'modalize', surface: 'review', backgroundPath: '/', reviewDeliveryId: 'abc-123',
    })
    // Back to Board mode with the review modal open → the routed page.
    expect(getGlobalRouteModeTransition({ uiMode: 'kanban', pathname: '/', loopsOpen: false, pluginsOpen: false, reviewOpen: 'abc-123' })).toEqual({
      kind: 'route', surface: 'review', path: '/review/abc-123',
    })
    expect(getGlobalRouteModeTransition({ uiMode: 'kanban', pathname: '/review/abc-123', loopsOpen: false, pluginsOpen: false })).toBeNull()
  })

  it('does not transform unrelated routes or normal Board global pages', () => {
    expect(getGlobalRouteModeTransition({
      uiMode: 'agent',
      pathname: '/',
      loopsOpen: false,
      pluginsOpen: false,
    })).toBeNull()

    expect(getGlobalRouteModeTransition({
      uiMode: 'kanban',
      pathname: '/plugins',
      loopsOpen: false,
      pluginsOpen: false,
    })).toBeNull()
  })
})
