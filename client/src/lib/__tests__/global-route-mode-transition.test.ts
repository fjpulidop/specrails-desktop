import { describe, expect, it } from 'vitest'
import { getGlobalRouteModeTransition, modalSurfaceForPath } from '../global-route-mode-transition'

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
