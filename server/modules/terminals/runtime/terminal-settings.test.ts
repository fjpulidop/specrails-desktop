import { describe, it, expect, beforeEach } from 'vitest'
import { initDb } from '../../../db'
import { initDesktopDb } from '../../../desktop-db'
import {
  TERMINAL_DEFAULTS,
  TerminalSettingsValidationError,
  getDesktopTerminalSettings,
  patchDesktopTerminalSettings,
  getProjectOverride,
  patchProjectOverride,
  resolveTerminalSettings,
} from './terminal-settings'
import type { DbInstance } from '../../../db'

describe('terminal-settings: desktop layer', () => {
  let desktopDb: DbInstance

  beforeEach(() => {
    desktopDb = initDesktopDb(':memory:')
  })

  it('seeds documented defaults on first migration', () => {
    const settings = getDesktopTerminalSettings(desktopDb)
    expect(settings).toEqual(TERMINAL_DEFAULTS)
  })

  it('PATCH upserts desktop values and round-trips through the typed decoder', () => {
    const updated = patchDesktopTerminalSettings(desktopDb, {
      fontSize: 14,
      renderMode: 'canvas',
      copyOnSelect: true,
      shellIntegrationEnabled: false,
      longCommandThresholdMs: 30_000,
    })
    expect(updated.fontSize).toBe(14)
    expect(updated.renderMode).toBe('canvas')
    expect(updated.copyOnSelect).toBe(true)
    expect(updated.shellIntegrationEnabled).toBe(false)
    expect(updated.longCommandThresholdMs).toBe(30_000)
    // Untouched fields remain at defaults.
    expect(updated.fontFamily).toBe(TERMINAL_DEFAULTS.fontFamily)
  })

  it('rejects out-of-range fontSize', () => {
    expect(() => patchDesktopTerminalSettings(desktopDb, { fontSize: 4 })).toThrow(TerminalSettingsValidationError)
    expect(() => patchDesktopTerminalSettings(desktopDb, { fontSize: 64 })).toThrow(TerminalSettingsValidationError)
    expect(() => patchDesktopTerminalSettings(desktopDb, { fontSize: 14.5 })).toThrow(TerminalSettingsValidationError)
  })

  it('rejects unknown render mode', () => {
    expect(() => patchDesktopTerminalSettings(desktopDb, { renderMode: 'metal' })).toThrow(TerminalSettingsValidationError)
  })

  it('rejects unknown setting key', () => {
    expect(() => patchDesktopTerminalSettings(desktopDb, { fontWeight: 700 })).toThrow(TerminalSettingsValidationError)
  })

  it('rejects long-command threshold below 1000ms', () => {
    expect(() => patchDesktopTerminalSettings(desktopDb, { longCommandThresholdMs: 500 })).toThrow(TerminalSettingsValidationError)
  })

  it('rejects boolean fields with non-boolean values', () => {
    expect(() => patchDesktopTerminalSettings(desktopDb, { copyOnSelect: 'yes' })).toThrow(TerminalSettingsValidationError)
  })
})

describe('terminal-settings: project override layer', () => {
  let desktopDb: DbInstance
  let projectDb: DbInstance

  beforeEach(() => {
    desktopDb = initDesktopDb(':memory:')
    projectDb = initDb(':memory:')
  })

  it('returns empty override before any patch', () => {
    expect(getProjectOverride(projectDb)).toEqual({})
  })

  it('PATCH stores override and is observable via getProjectOverride', () => {
    patchProjectOverride(projectDb, { fontSize: 16, renderMode: 'webgl' })
    expect(getProjectOverride(projectDb)).toEqual({ fontSize: 16, renderMode: 'webgl' })
  })

  it('PATCH null clears that override key', () => {
    patchProjectOverride(projectDb, { fontSize: 16 })
    expect(getProjectOverride(projectDb)).toEqual({ fontSize: 16 })
    patchProjectOverride(projectDb, { fontSize: null })
    expect(getProjectOverride(projectDb)).toEqual({})
  })

  it('PATCH null does not require a value to currently exist', () => {
    expect(() => patchProjectOverride(projectDb, { fontSize: null })).not.toThrow()
    expect(getProjectOverride(projectDb)).toEqual({})
  })

  it('rejects out-of-range values in override layer too', () => {
    expect(() => patchProjectOverride(projectDb, { fontSize: 4 })).toThrow(TerminalSettingsValidationError)
  })
})

describe('terminal-settings: resolution', () => {
  let desktopDb: DbInstance
  let projectDb: DbInstance

  beforeEach(() => {
    desktopDb = initDesktopDb(':memory:')
    projectDb = initDb(':memory:')
  })

  it('returns app defaults when no override exists', () => {
    expect(resolveTerminalSettings(desktopDb, projectDb)).toEqual(TERMINAL_DEFAULTS)
  })

  it('project override wins per-field; absent fields fall back to the desktop layer', () => {
    patchDesktopTerminalSettings(desktopDb, { fontSize: 14 })
    patchProjectOverride(projectDb, { renderMode: 'canvas' })
    const resolved = resolveTerminalSettings(desktopDb, projectDb)
    expect(resolved.fontSize).toBe(14) // from the desktop layer
    expect(resolved.renderMode).toBe('canvas') // from override
    expect(resolved.fontFamily).toBe(TERMINAL_DEFAULTS.fontFamily) // built-in via desktop seed
  })

  it('clearing an override falls back to the desktop layer for that field', () => {
    patchDesktopTerminalSettings(desktopDb, { fontSize: 14 })
    patchProjectOverride(projectDb, { fontSize: 18 })
    expect(resolveTerminalSettings(desktopDb, projectDb).fontSize).toBe(18)
    patchProjectOverride(projectDb, { fontSize: null })
    expect(resolveTerminalSettings(desktopDb, projectDb).fontSize).toBe(14)
  })

  it('null projectDb returns desktop layer only', () => {
    patchDesktopTerminalSettings(desktopDb, { renderMode: 'webgl' })
    const resolved = resolveTerminalSettings(desktopDb, null)
    expect(resolved.renderMode).toBe('webgl')
  })
})
