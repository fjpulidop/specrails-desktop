import { describe, it, expect, beforeEach } from 'vitest'
import {
  ACTIVE_STATUSES,
  SPEC_STATUS_FILTER_VALUES,
  TICKET_STATUS_ORDER,
  isSpecStatusFilterValue,
  loadSpecStatusFilter,
  saveSpecStatusFilter,
  statusMatchesFilter,
} from '../spec-status-filter'
import type { TicketStatus } from '../../types'

const KEY = (p: string) => `specrails-desktop:spec-status-filter:${p}`
const LEGACY_KEY = (p: string) => `specrails-desktop:spec-status-tab:${p}`

describe('spec-status-filter', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('covers every TicketStatus exactly once in the canonical order', () => {
    expect(TICKET_STATUS_ORDER).toEqual(['draft', 'todo', 'in_progress', 'on_review', 'done', 'cancelled'])
    expect(SPEC_STATUS_FILTER_VALUES).toEqual(['active', 'all', ...TICKET_STATUS_ORDER])
  })

  it('the Active bucket holds the moving statuses — never done/cancelled', () => {
    expect([...ACTIVE_STATUSES].sort()).toEqual(['draft', 'in_progress', 'on_review', 'todo'])
  })

  describe('statusMatchesFilter', () => {
    it("'all' matches every status", () => {
      for (const s of TICKET_STATUS_ORDER) expect(statusMatchesFilter(s, 'all')).toBe(true)
    })

    it("'active' matches draft/todo/in_progress/on_review and rejects done/cancelled", () => {
      expect(statusMatchesFilter('draft', 'active')).toBe(true)
      expect(statusMatchesFilter('todo', 'active')).toBe(true)
      expect(statusMatchesFilter('in_progress', 'active')).toBe(true)
      expect(statusMatchesFilter('on_review', 'active')).toBe(true)
      expect(statusMatchesFilter('done', 'active')).toBe(false)
      expect(statusMatchesFilter('cancelled', 'active')).toBe(false)
    })

    it('an exact status only matches itself', () => {
      for (const filter of TICKET_STATUS_ORDER) {
        for (const s of TICKET_STATUS_ORDER) {
          expect(statusMatchesFilter(s as TicketStatus, filter)).toBe(s === filter)
        }
      }
    })
  })

  describe('isSpecStatusFilterValue', () => {
    it('accepts every canonical value', () => {
      for (const v of SPEC_STATUS_FILTER_VALUES) expect(isSpecStatusFilterValue(v)).toBe(true)
    })
    it('rejects junk', () => {
      expect(isSpecStatusFilterValue('bogus')).toBe(false)
      expect(isSpecStatusFilterValue(null)).toBe(false)
      expect(isSpecStatusFilterValue(undefined)).toBe(false)
      expect(isSpecStatusFilterValue(3)).toBe(false)
      expect(isSpecStatusFilterValue('todo ')).toBe(false)
    })
  })

  describe('persistence', () => {
    it('defaults to active with no projectId or nothing stored', () => {
      expect(loadSpecStatusFilter(null)).toBe('active')
      expect(loadSpecStatusFilter('p1')).toBe('active')
    })

    it('round-trips every value', () => {
      for (const v of SPEC_STATUS_FILTER_VALUES) {
        saveSpecStatusFilter('p1', v)
        expect(loadSpecStatusFilter('p1')).toBe(v)
      }
    })

    it('scopes per project', () => {
      saveSpecStatusFilter('p1', 'done')
      saveSpecStatusFilter('p2', 'cancelled')
      expect(loadSpecStatusFilter('p1')).toBe('done')
      expect(loadSpecStatusFilter('p2')).toBe('cancelled')
    })

    it("migrates the legacy ToDo/Done tab: 'done' → done, 'todo' → active", () => {
      localStorage.setItem(LEGACY_KEY('p1'), 'done')
      expect(loadSpecStatusFilter('p1')).toBe('done')
      localStorage.setItem(LEGACY_KEY('p2'), 'todo')
      expect(loadSpecStatusFilter('p2')).toBe('active')
    })

    it('a saved new-key value wins over the legacy key', () => {
      localStorage.setItem(LEGACY_KEY('p1'), 'done')
      saveSpecStatusFilter('p1', 'todo') // the EXACT To Do chip, not the legacy tab
      expect(loadSpecStatusFilter('p1')).toBe('todo')
      expect(localStorage.getItem(KEY('p1'))).toBe('todo')
    })

    it('ignores a corrupt stored value', () => {
      localStorage.setItem(KEY('p1'), 'bogus')
      expect(loadSpecStatusFilter('p1')).toBe('active')
    })

    it('survives localStorage throwing', () => {
      const origGet = Storage.prototype.getItem
      const origSet = Storage.prototype.setItem
      Storage.prototype.getItem = () => { throw new Error('denied') }
      Storage.prototype.setItem = () => { throw new Error('quota') }
      try {
        expect(loadSpecStatusFilter('p1')).toBe('active')
        expect(() => saveSpecStatusFilter('p1', 'done')).not.toThrow()
      } finally {
        Storage.prototype.getItem = origGet
        Storage.prototype.setItem = origSet
      }
    })

    it('save no-ops when projectId is null', () => {
      saveSpecStatusFilter(null, 'done')
      expect(localStorage.length).toBe(0)
    })
  })
})
