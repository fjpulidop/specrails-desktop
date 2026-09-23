import { describe, it, expect, beforeEach } from 'vitest'
import {
  DEFAULT_SPECS_VIEW_TIER,
  loadSpecsViewTier,
  saveSpecsViewTier,
} from '../specs-view-tier'

describe('specs-view-tier', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns default when projectId is null', () => {
    expect(loadSpecsViewTier(null)).toBe(DEFAULT_SPECS_VIEW_TIER)
  })

  it('returns default when nothing stored for project', () => {
    expect(loadSpecsViewTier('p1')).toBe(DEFAULT_SPECS_VIEW_TIER)
  })

  it('returns default when stored value is invalid', () => {
    localStorage.setItem('specrails-desktop:specs-view-tier:p1', 'garbage')
    expect(loadSpecsViewTier('p1')).toBe(DEFAULT_SPECS_VIEW_TIER)
  })

  it('round-trips row tier', () => {
    saveSpecsViewTier('p1', 'row')
    expect(loadSpecsViewTier('p1')).toBe('row')
  })

  it('round-trips postit tier', () => {
    saveSpecsViewTier('p2', 'postit')
    expect(loadSpecsViewTier('p2')).toBe('postit')
  })

  it('scopes storage per projectId', () => {
    saveSpecsViewTier('p1', 'row')
    saveSpecsViewTier('p2', 'postit')
    expect(loadSpecsViewTier('p1')).toBe('row')
    expect(loadSpecsViewTier('p2')).toBe('postit')
  })

  it('save no-ops when projectId is null', () => {
    saveSpecsViewTier(null, 'row')
    expect(localStorage.length).toBe(0)
  })

  it('survives localStorage throwing on read', () => {
    const orig = Storage.prototype.getItem
    Storage.prototype.getItem = () => {
      throw new Error('denied')
    }
    try {
      expect(loadSpecsViewTier('p1')).toBe(DEFAULT_SPECS_VIEW_TIER)
    } finally {
      Storage.prototype.getItem = orig
    }
  })

  it('survives localStorage throwing on write', () => {
    const orig = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new Error('quota')
    }
    try {
      expect(() => saveSpecsViewTier('p1', 'row')).not.toThrow()
    } finally {
      Storage.prototype.setItem = orig
    }
  })
})
