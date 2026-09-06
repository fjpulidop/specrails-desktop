import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { createPlaywrightLauncher } from './browser-playwright'

// The production launcher deliberately uses require for the packaged sidecar.
// Spy on that same cached module instead of launching a real browser or profile.
const { chromium } = createRequire(import.meta.url)('playwright') as typeof import('playwright')
const originalPlatform = process.platform

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  vi.restoreAllMocks()
})

describe('Playwright persistent launcher sandbox', () => {
  it.each(['darwin', 'win32', 'linux'] as const)('sets the actual sandbox option on %s', async (platform) => {
    Object.defineProperty(process, 'platform', { value: platform })
    const close = vi.fn().mockResolvedValue(undefined)
    const launch = vi.spyOn(chromium, 'launchPersistentContext').mockResolvedValue({ on: vi.fn(), browser: () => null, close } as never)
    const context = await createPlaywrightLauncher()({
      userDataDir: '/fixture/not-created/profile',
      executablePath: '/fixture/not-launched/browser',
      viewport: { width: 900, height: 700 },
    })
    expect(launch).toHaveBeenCalledWith('/fixture/not-created/profile', expect.objectContaining({
      headless: true,
      executablePath: '/fixture/not-launched/browser',
      chromiumSandbox: platform !== 'linux',
      viewport: { width: 900, height: 700 },
    }))
    const options = launch.mock.calls[0][1]!
    if (platform === 'linux') expect(options.args).toContain('--no-sandbox')
    else expect(options.args).not.toContain('--no-sandbox')
    await context.close()
    expect(close).toHaveBeenCalledOnce()
  })
})
