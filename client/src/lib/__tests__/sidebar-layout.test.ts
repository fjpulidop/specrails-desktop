import { describe, expect, it } from 'vitest'
import { hasRightSidebar, isGlobalRoute } from '../sidebar-layout'

describe('sidebar-layout', () => {
  it('treats Docs as global in both modes, Loops/Plugins only on the board', () => {
    expect(isGlobalRoute('/docs/guide/x', 'agent')).toBe(true)
    expect(isGlobalRoute('/loops', 'kanban')).toBe(true)
    expect(isGlobalRoute('/plugins', 'kanban')).toBe(true)
    expect(isGlobalRoute('/loops', 'agent')).toBe(false)
    expect(isGlobalRoute('/', 'kanban')).toBe(false)
  })

  it('mounts a right sidebar in Agent Mode, or on the board with an active project, never on a global route', () => {
    expect(hasRightSidebar({ uiMode: 'agent', pathname: '/', hasActiveProject: false })).toBe(true)
    expect(hasRightSidebar({ uiMode: 'agent', pathname: '/plugins', hasActiveProject: false })).toBe(true)
    expect(hasRightSidebar({ uiMode: 'agent', pathname: '/docs', hasActiveProject: true })).toBe(false)
    expect(hasRightSidebar({ uiMode: 'kanban', pathname: '/', hasActiveProject: false })).toBe(false)
    expect(hasRightSidebar({ uiMode: 'kanban', pathname: '/jobs', hasActiveProject: true })).toBe(true)
    expect(hasRightSidebar({ uiMode: 'kanban', pathname: '/loops', hasActiveProject: true })).toBe(false)
  })
})
