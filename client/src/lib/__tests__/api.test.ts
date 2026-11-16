import { describe, it, expect, beforeEach } from 'vitest'
import { setActiveProjectId, getApiBase } from '../api'

describe('api', () => {
  beforeEach(() => {
    setActiveProjectId(null)
  })

  describe('getApiBase', () => {
    it('targets a newly created project before it becomes active without changing the active project', () => {
      expect(getApiBase('new-project')).toBe('/api/projects/new-project')
      expect(() => getApiBase()).toThrow(/no active project/i)
      setActiveProjectId('current')
      expect(getApiBase('new-project')).toBe('/api/projects/new-project')
      expect(getApiBase()).toBe('/api/projects/current')
    })
    it('returns /api/projects/<id> when an active project is set', () => {
      setActiveProjectId('proj-123')
      expect(getApiBase()).toBe('/api/projects/proj-123')
    })

    it('updates when the active project changes', () => {
      setActiveProjectId('proj-aaa')
      expect(getApiBase()).toBe('/api/projects/proj-aaa')

      setActiveProjectId('proj-bbb')
      expect(getApiBase()).toBe('/api/projects/proj-bbb')
    })

    it('throws when no active project is set', () => {
      expect(() => getApiBase()).toThrow(/no active project/i)
    })

    it('throws after the active project is cleared', () => {
      setActiveProjectId('proj-xyz')
      expect(getApiBase()).toBe('/api/projects/proj-xyz')

      setActiveProjectId(null)
      expect(() => getApiBase()).toThrow(/no active project/i)
    })
  })

  describe('setActiveProjectId', () => {
    it('accepts project IDs with URL-safe special chars', () => {
      setActiveProjectId('my-project_001')
      expect(getApiBase()).toBe('/api/projects/my-project_001')
    })
  })
})
