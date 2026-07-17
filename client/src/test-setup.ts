import '@testing-library/jest-dom/vitest'
import { vi, afterEach, beforeEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { setActiveProjectId } from './lib/api'
// Initialize the i18next singleton (English, synchronous in-memory init) so
// `useTranslation` consumers render real strings without provider wrapping.
import './lib/i18n'

// Cleanup after each test
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// Reset fetch mock and seed an active project before each test so that
// `getApiBase()` (which throws when no project is active) works in component
// tests that don't set up a DesktopProvider.
beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({}),
  })
  setActiveProjectId('test-project')
})

// Mock window.matchMedia (required by some Radix components and by
// motion's useReducedMotion). A PLAIN function, not vi.fn(): a suite calling
// vi.restoreAllMocks() would clear a vi.fn implementation and make
// matchMedia(...) return undefined mid-run (motion's initPrefersReducedMotion
// then crashes on `.addEventListener` of undefined) — same reasoning as the
// class-based ResizeObserver mock below.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
})

// Mock ResizeObserver (required by Radix and @dnd-kit)
// Use a class so vi.restoreAllMocks() cannot clear the implementation
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver

// Pointer capture mocks required by Radix UI Select/Popover in JSDOM.
// Without these, Radix pointer-down handlers throw and the dropdown never opens.
HTMLElement.prototype.setPointerCapture = vi.fn()
HTMLElement.prototype.releasePointerCapture = vi.fn()
HTMLElement.prototype.hasPointerCapture = vi.fn(() => false)

// Mock IntersectionObserver
global.IntersectionObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}))

// Mock scrollIntoView (not available in jsdom)
window.HTMLElement.prototype.scrollIntoView = vi.fn()
Element.prototype.scrollIntoView = vi.fn()

// localStorage mock (jsdom v25+ does not expose Storage methods by default)
const _localStorageStore: Record<string, string> = {}
const localStorageMock = {
  getItem: (key: string) => _localStorageStore[key] ?? null,
  setItem: (key: string, value: string) => { _localStorageStore[key] = String(value) },
  removeItem: (key: string) => { delete _localStorageStore[key] },
  clear: () => { Object.keys(_localStorageStore).forEach((k) => delete _localStorageStore[k]) },
  get length() { return Object.keys(_localStorageStore).length },
  key: (index: number) => Object.keys(_localStorageStore)[index] ?? null,
}
Object.defineProperty(window, 'localStorage', { value: localStorageMock, writable: false })

afterEach(() => {
  localStorageMock.clear()
})
