import { afterEach, describe, it, expect } from 'vitest'
import {
  defaultMachineProvider,
  isProviderEnabled,
  isMultiProvider,
  resolveProvider,
  setDetectedProvidersSupplier,
  validateRequestedProvider,
} from './provider-selection'
import type { CliProvider } from './desktop-db'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function singleProviderProject(provider: CliProvider = 'claude') {
  return { provider, providers: [provider] as CliProvider[] }
}

function multiProviderProject() {
  return { provider: 'claude' as CliProvider, providers: ['claude', 'codex'] as CliProvider[] }
}

function missingProvidersProject(provider: CliProvider = 'claude') {
  return { provider }
}

function emptyProvidersProject(provider: CliProvider = 'claude') {
  return { provider, providers: [] as CliProvider[] }
}

// ─── isProviderEnabled ────────────────────────────────────────────────────────

describe('isProviderEnabled', () => {
  it('returns true for the only provider on a single-provider project', () => {
    const project = singleProviderProject('claude')
    expect(isProviderEnabled(project, 'claude')).toBe(true)
  })

  it('returns false for a provider not installed on a single-provider project', () => {
    const project = singleProviderProject('claude')
    expect(isProviderEnabled(project, 'codex')).toBe(false)
  })

  it('returns true for each provider on a multi-provider project', () => {
    const project = multiProviderProject()
    expect(isProviderEnabled(project, 'claude')).toBe(true)
    expect(isProviderEnabled(project, 'codex')).toBe(true)
  })

  it('returns false for an unknown provider on a multi-provider project', () => {
    const project = multiProviderProject()
    expect(isProviderEnabled(project, 'gpt4')).toBe(false)
  })

  it('returns false for null id', () => {
    const project = singleProviderProject()
    expect(isProviderEnabled(project, null)).toBe(false)
  })

  it('returns false for undefined id', () => {
    const project = singleProviderProject()
    expect(isProviderEnabled(project, undefined)).toBe(false)
  })

  it('returns false for empty string id', () => {
    const project = singleProviderProject()
    expect(isProviderEnabled(project, '')).toBe(false)
  })

  it('falls back to primary provider when providers array is missing', () => {
    const project = missingProvidersProject('claude')
    expect(isProviderEnabled(project, 'claude')).toBe(true)
    expect(isProviderEnabled(project, 'codex')).toBe(false)
  })

  it('falls back to primary provider when providers array is empty', () => {
    const project = emptyProvidersProject('codex')
    expect(isProviderEnabled(project, 'codex')).toBe(true)
    expect(isProviderEnabled(project, 'claude')).toBe(false)
  })

  it('falls back to claude when both provider and providers are missing', () => {
    expect(isProviderEnabled({}, 'claude')).toBe(true)
    expect(isProviderEnabled({}, 'codex')).toBe(false)
  })
})

// ─── isMultiProvider ──────────────────────────────────────────────────────────

describe('isMultiProvider', () => {
  it('returns false for a single-provider project', () => {
    expect(isMultiProvider(singleProviderProject('claude'))).toBe(false)
  })

  it('returns true for a multi-provider project', () => {
    expect(isMultiProvider(multiProviderProject())).toBe(true)
  })

  it('returns false when providers array is missing (falls back to single)', () => {
    expect(isMultiProvider(missingProvidersProject())).toBe(false)
  })

  it('returns false when providers array is empty (falls back to single)', () => {
    expect(isMultiProvider(emptyProvidersProject())).toBe(false)
  })

  it('returns false when project is completely empty', () => {
    expect(isMultiProvider({})).toBe(false)
  })
})

// ─── resolveProvider ─────────────────────────────────────────────────────────

describe('resolveProvider', () => {
  it('returns the requested provider when installed on a single-provider project', () => {
    const project = singleProviderProject('claude')
    expect(resolveProvider(project, 'claude')).toBe('claude')
  })

  it('falls back to primary when requested provider is not installed', () => {
    const project = singleProviderProject('claude')
    expect(resolveProvider(project, 'codex')).toBe('claude')
  })

  it('returns the requested provider when installed on a multi-provider project', () => {
    const project = multiProviderProject()
    expect(resolveProvider(project, 'codex')).toBe('codex')
    expect(resolveProvider(project, 'claude')).toBe('claude')
  })

  it('falls back to primary when requested provider is not in multi-provider list', () => {
    const project = multiProviderProject()
    expect(resolveProvider(project, 'gpt4')).toBe('claude')
  })

  it('returns primary when requested is undefined', () => {
    const project = singleProviderProject('claude')
    expect(resolveProvider(project, undefined)).toBe('claude')
  })

  it('returns primary when requested is null', () => {
    const project = singleProviderProject('codex')
    expect(resolveProvider(project, null)).toBe('codex')
  })

  it('returns primary when requested is empty string', () => {
    const project = singleProviderProject('claude')
    expect(resolveProvider(project, '')).toBe('claude')
  })

  it('falls back to primary provider when providers is missing', () => {
    const project = missingProvidersProject('codex')
    expect(resolveProvider(project, undefined)).toBe('codex')
    expect(resolveProvider(project, 'claude')).toBe('codex')
  })

  it('falls back to primary provider when providers is empty', () => {
    const project = emptyProvidersProject('claude')
    expect(resolveProvider(project, undefined)).toBe('claude')
  })

  it('falls back to claude when project has no fields', () => {
    expect(resolveProvider({}, undefined)).toBe('claude')
  })
})

// ─── validateRequestedProvider ────────────────────────────────────────────────

describe('validateRequestedProvider', () => {
  // Happy path: omitted / empty / null

  it('returns ok with primary when requested is undefined', () => {
    const project = singleProviderProject('claude')
    const result = validateRequestedProvider(project, undefined)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.provider).toBe('claude')
  })

  it('returns ok with primary when requested is null', () => {
    const project = singleProviderProject('codex')
    const result = validateRequestedProvider(project, null)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.provider).toBe('codex')
  })

  it('returns ok with primary when requested is empty string', () => {
    const project = singleProviderProject('claude')
    const result = validateRequestedProvider(project, '')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.provider).toBe('claude')
  })

  // Happy path: valid string

  it('returns ok with the requested provider when installed (single-provider project)', () => {
    const project = singleProviderProject('claude')
    const result = validateRequestedProvider(project, 'claude')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.provider).toBe('claude')
  })

  it('returns ok with the requested provider when installed (multi-provider project)', () => {
    const project = multiProviderProject()
    const result = validateRequestedProvider(project, 'codex')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.provider).toBe('codex')
  })

  // Error path: not-installed string

  it('returns error when requested provider is not installed on single-provider project', () => {
    const project = singleProviderProject('claude')
    const result = validateRequestedProvider(project, 'codex')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("'codex'")
      expect(result.error).toContain('claude')
    }
  })

  it('returns error when requested provider is unknown on multi-provider project', () => {
    const project = multiProviderProject()
    const result = validateRequestedProvider(project, 'gpt4')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("'gpt4'")
      expect(result.error).toContain('claude')
      expect(result.error).toContain('codex')
    }
  })

  // Error path: non-string requested

  it('returns error when requested is a number', () => {
    const project = singleProviderProject()
    const result = validateRequestedProvider(project, 42)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('provider must be a string')
  })

  it('returns error when requested is a boolean', () => {
    const project = singleProviderProject()
    const result = validateRequestedProvider(project, true)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('provider must be a string')
  })

  it('returns error when requested is an object', () => {
    const project = singleProviderProject()
    const result = validateRequestedProvider(project, { provider: 'claude' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('provider must be a string')
  })

  it('returns error when requested is an array', () => {
    const project = singleProviderProject()
    const result = validateRequestedProvider(project, ['claude'])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('provider must be a string')
  })

  // Fallback: missing / empty providers on project

  it('falls back to primary when providers missing and requested is omitted', () => {
    const project = missingProvidersProject('codex')
    const result = validateRequestedProvider(project, undefined)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.provider).toBe('codex')
  })

  it('falls back to primary when providers is empty and requested is omitted', () => {
    const project = emptyProvidersProject('claude')
    const result = validateRequestedProvider(project, undefined)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.provider).toBe('claude')
  })

  it('errors with informative message when requested not installed and providers missing', () => {
    const project = missingProvidersProject('claude')
    const result = validateRequestedProvider(project, 'codex')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("'codex'")
      expect(result.error).toContain('claude')
    }
  })

  it('falls back to claude when project is completely empty and requested is omitted', () => {
    const result = validateRequestedProvider({}, undefined)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.provider).toBe('claude')
  })
})

// ─── defaultMachineProvider ───────────────────────────────────────────────────

describe('defaultMachineProvider', () => {
  afterEach(() => setDetectedProvidersSupplier(null))

  it('is claude while no detection snapshot exists (startup / legacy)', () => {
    expect(defaultMachineProvider()).toBe('claude')
  })

  it('follows the CLI preference order over the detected set', () => {
    setDetectedProvidersSupplier(() => ['kimi', 'codex'])
    expect(defaultMachineProvider()).toBe('codex')
    setDetectedProvidersSupplier(() => ['gemini', 'claude'])
    expect(defaultMachineProvider()).toBe('claude')
  })

  it('lands on the local engine on a local-only machine instead of an uninstalled claude', () => {
    setDetectedProvidersSupplier(() => ['lmstudio'])
    expect(defaultMachineProvider()).toBe('lmstudio')
  })

  it('never prefers a local engine over a detected CLI', () => {
    setDetectedProvidersSupplier(() => ['lmstudio', 'gemini'])
    expect(defaultMachineProvider()).toBe('gemini')
  })
})
