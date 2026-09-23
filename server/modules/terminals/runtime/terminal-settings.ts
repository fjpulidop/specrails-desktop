import os from 'os'
import type { DbInstance } from '../../../db'

function defaultUsername(): string {
  try { return os.userInfo().username || 'friend' } catch { return 'friend' }
}

export function defaultQuickScript(): string {
  return `echo "Wake up, ${defaultUsername()} (edit this snippet in settings to help your local development)"`
}

export type TerminalRenderMode = 'auto' | 'canvas' | 'webgl'

export interface TerminalSettings {
  fontFamily: string
  fontSize: number
  renderMode: TerminalRenderMode
  copyOnSelect: boolean
  shellIntegrationEnabled: boolean
  notifyOnCompletion: boolean
  imageRendering: boolean
  longCommandThresholdMs: number
  /** URL opened by the panel's Browser shortcut button. */
  browserShortcutUrl: string
  /** Script pasted (NOT auto-executed) into the active terminal by the
   *  Quick Script shortcut button. */
  quickScript: string
}

export type PartialTerminalSettings = Partial<TerminalSettings>

export const TERMINAL_SETTINGS_KEYS: ReadonlyArray<keyof TerminalSettings> = [
  'fontFamily',
  'fontSize',
  'renderMode',
  'copyOnSelect',
  'shellIntegrationEnabled',
  'notifyOnCompletion',
  'imageRendering',
  'longCommandThresholdMs',
  'browserShortcutUrl',
  'quickScript',
]

export const TERMINAL_DEFAULTS: TerminalSettings = {
  fontFamily: "'DM Mono', 'JetBrains Mono', ui-monospace, Menlo, monospace",
  fontSize: 12,
  renderMode: 'auto',
  copyOnSelect: false,
  shellIntegrationEnabled: true,
  notifyOnCompletion: true,
  imageRendering: true,
  longCommandThresholdMs: 60_000,
  browserShortcutUrl: 'https://specrails.dev',
  quickScript: defaultQuickScript(),
}

const FONT_SIZE_MIN = 8
const FONT_SIZE_MAX = 32
const LONG_COMMAND_THRESHOLD_MIN_MS = 1_000

export class TerminalSettingsValidationError extends Error {
  constructor(public readonly field: string, message: string) {
    super(message)
    this.name = 'TerminalSettingsValidationError'
  }
}

// ─── Codec: TEXT row value ⇄ typed field ──────────────────────────────────────

function encode(field: keyof TerminalSettings, value: unknown): string {
  switch (field) {
    case 'fontFamily':
    case 'renderMode':
    case 'browserShortcutUrl':
    case 'quickScript':
      if (typeof value !== 'string') throw new TerminalSettingsValidationError(field, `${field} must be a string`)
      return value
    case 'fontSize':
    case 'longCommandThresholdMs':
      if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
        throw new TerminalSettingsValidationError(field, `${field} must be an integer`)
      }
      return String(value)
    case 'copyOnSelect':
    case 'shellIntegrationEnabled':
    case 'notifyOnCompletion':
    case 'imageRendering':
      if (typeof value !== 'boolean') throw new TerminalSettingsValidationError(field, `${field} must be a boolean`)
      return value ? 'true' : 'false'
  }
}

function decode<K extends keyof TerminalSettings>(field: K, raw: string): TerminalSettings[K] {
  switch (field) {
    case 'fontFamily':
    case 'browserShortcutUrl':
    case 'quickScript':
      return raw as TerminalSettings[K]
    case 'renderMode': {
      if (raw !== 'auto' && raw !== 'canvas' && raw !== 'webgl') {
        return TERMINAL_DEFAULTS.renderMode as TerminalSettings[K]
      }
      return raw as TerminalSettings[K]
    }
    case 'fontSize':
    case 'longCommandThresholdMs': {
      const n = Number(raw)
      return (Number.isFinite(n) && Number.isInteger(n)
        ? n
        : (TERMINAL_DEFAULTS[field] as number)) as TerminalSettings[K]
    }
    case 'copyOnSelect':
    case 'shellIntegrationEnabled':
    case 'notifyOnCompletion':
    case 'imageRendering':
      return (raw === 'true') as TerminalSettings[K]
  }
  // Unreachable; satisfies TS.
  return TERMINAL_DEFAULTS[field]
}

// ─── Validation (apply BEFORE encode) ─────────────────────────────────────────

export function validateField<K extends keyof TerminalSettings>(field: K, value: TerminalSettings[K]): void {
  switch (field) {
    case 'fontFamily': {
      const v = value as string
      if (typeof v !== 'string' || v.trim().length === 0) {
        throw new TerminalSettingsValidationError(field, 'fontFamily must be a non-empty string')
      }
      return
    }
    case 'fontSize': {
      const n = value as number
      if (typeof n !== 'number' || !Number.isInteger(n) || n < FONT_SIZE_MIN || n > FONT_SIZE_MAX) {
        throw new TerminalSettingsValidationError(field, `fontSize must be an integer in [${FONT_SIZE_MIN}, ${FONT_SIZE_MAX}]`)
      }
      return
    }
    case 'renderMode': {
      const v = value as string
      if (v !== 'auto' && v !== 'canvas' && v !== 'webgl') {
        throw new TerminalSettingsValidationError(field, 'renderMode must be one of "auto", "canvas", "webgl"')
      }
      return
    }
    case 'copyOnSelect':
    case 'shellIntegrationEnabled':
    case 'notifyOnCompletion':
    case 'imageRendering': {
      if (typeof value !== 'boolean') {
        throw new TerminalSettingsValidationError(field, `${field} must be a boolean`)
      }
      return
    }
    case 'longCommandThresholdMs': {
      const n = value as number
      if (typeof n !== 'number' || !Number.isInteger(n) || n < LONG_COMMAND_THRESHOLD_MIN_MS) {
        throw new TerminalSettingsValidationError(field, `longCommandThresholdMs must be an integer ≥ ${LONG_COMMAND_THRESHOLD_MIN_MS}`)
      }
      return
    }
    case 'browserShortcutUrl': {
      const v = value as string
      if (typeof v !== 'string' || v.trim().length === 0) {
        throw new TerminalSettingsValidationError(field, 'browserShortcutUrl must be a non-empty string')
      }
      // Allow http(s) URLs only — no file://, no javascript:, etc.
      if (!/^https?:\/\//i.test(v.trim())) {
        throw new TerminalSettingsValidationError(field, 'browserShortcutUrl must start with http:// or https://')
      }
      return
    }
    case 'quickScript': {
      const v = value as string
      if (typeof v !== 'string') {
        throw new TerminalSettingsValidationError(field, 'quickScript must be a string')
      }
      // Empty strings allowed (user disabling the shortcut). Cap to avoid abuse.
      if (v.length > 8192) {
        throw new TerminalSettingsValidationError(field, 'quickScript exceeds 8KB cap')
      }
      return
    }
  }
}

export function validatePartial(patch: Record<string, unknown>): PartialTerminalSettings {
  const out: PartialTerminalSettings = {}
  for (const key of Object.keys(patch)) {
    if (!(TERMINAL_SETTINGS_KEYS as readonly string[]).includes(key)) {
      throw new TerminalSettingsValidationError(key, `unknown setting: ${key}`)
    }
    const field = key as keyof TerminalSettings
    const value = patch[key]
    if (value === null) continue // null = clear (override layer); not validated here
    validateField(field, value as TerminalSettings[typeof field])
    ;(out as Record<string, unknown>)[field] = value
  }
  return out
}

// ─── App-level access (desktop.sqlite, table: desktop_settings) ───────────────────────

const DESKTOP_KEY_PREFIX = 'terminal.'

function desktopKey(field: keyof TerminalSettings): string {
  return `${DESKTOP_KEY_PREFIX}${field}`
}

export function getDesktopTerminalSettings(desktopDb: DbInstance): TerminalSettings {
  const rows = desktopDb
    .prepare('SELECT key, value FROM desktop_settings WHERE key LIKE ?')
    .all(`${DESKTOP_KEY_PREFIX}%`) as Array<{ key: string; value: string }>
  const map = new Map(rows.map((r) => [r.key, r.value]))
  const out: Partial<TerminalSettings> = {}
  for (const field of TERMINAL_SETTINGS_KEYS) {
    const raw = map.get(desktopKey(field))
    out[field] = (raw !== undefined ? decode(field, raw) : TERMINAL_DEFAULTS[field]) as never
  }
  return out as TerminalSettings
}

export function patchDesktopTerminalSettings(desktopDb: DbInstance, patch: Record<string, unknown>): TerminalSettings {
  const valid = validatePartial(patch)
  const upsert = desktopDb.prepare('INSERT OR REPLACE INTO desktop_settings (key, value) VALUES (?, ?)')
  const tx = desktopDb.transaction((entries: Array<[string, string]>) => {
    for (const [k, v] of entries) upsert.run(k, v)
  })
  const entries: Array<[string, string]> = []
  for (const field of Object.keys(valid) as Array<keyof TerminalSettings>) {
    entries.push([desktopKey(field), encode(field, valid[field])])
  }
  if (entries.length > 0) tx(entries)
  return getDesktopTerminalSettings(desktopDb)
}

// ─── Per-project override (jobs.sqlite, table: terminal_settings_override) ────

export function getProjectOverride(projectDb: DbInstance): PartialTerminalSettings {
  const rows = projectDb
    .prepare('SELECT key, value FROM terminal_settings_override WHERE key LIKE ?')
    .all(`${DESKTOP_KEY_PREFIX}%`) as Array<{ key: string; value: string }>
  const out: PartialTerminalSettings = {}
  for (const r of rows) {
    const field = r.key.slice(DESKTOP_KEY_PREFIX.length) as keyof TerminalSettings
    if (!(TERMINAL_SETTINGS_KEYS as readonly string[]).includes(field)) continue
    ;(out as Record<string, unknown>)[field] = decode(field, r.value)
  }
  return out
}

export function patchProjectOverride(
  projectDb: DbInstance,
  patch: Record<string, unknown>,
): PartialTerminalSettings {
  // Validate non-null entries; null entries are deletes and don't go through validateField.
  const setEntries: Array<[string, string]> = []
  const deleteKeys: string[] = []
  for (const key of Object.keys(patch)) {
    if (!(TERMINAL_SETTINGS_KEYS as readonly string[]).includes(key)) {
      throw new TerminalSettingsValidationError(key, `unknown setting: ${key}`)
    }
    const field = key as keyof TerminalSettings
    const value = patch[key]
    if (value === null) {
      deleteKeys.push(desktopKey(field))
      continue
    }
    validateField(field, value as TerminalSettings[typeof field])
    setEntries.push([desktopKey(field), encode(field, value)])
  }
  const upsert = projectDb.prepare('INSERT OR REPLACE INTO terminal_settings_override (key, value) VALUES (?, ?)')
  const del = projectDb.prepare('DELETE FROM terminal_settings_override WHERE key = ?')
  const tx = projectDb.transaction(() => {
    for (const [k, v] of setEntries) upsert.run(k, v)
    for (const k of deleteKeys) del.run(k)
  })
  tx()
  return getProjectOverride(projectDb)
}

// ─── Resolution: project override → app default → built-in ────────────────────

export function resolveTerminalSettings(
  desktopDb: DbInstance,
  projectDb: DbInstance | null,
): TerminalSettings {
  const desktop = getDesktopTerminalSettings(desktopDb)
  if (!projectDb) return desktop
  const override = getProjectOverride(projectDb)
  const out = { ...desktop }
  for (const field of Object.keys(override) as Array<keyof TerminalSettings>) {
    const v = override[field]
    if (v !== undefined) (out as Record<string, unknown>)[field] = v
  }
  return out
}
