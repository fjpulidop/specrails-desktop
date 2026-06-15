import { describe, it, expect, afterEach } from 'vitest'
import { isCodeExplorerEnabled, isBrowserCaptureEnabled, isInteractiveJobsEnabled } from './feature-flags'

describe('feature-flags', () => {
  const savedCode = process.env.SPECRAILS_CODE_EXPLORER
  const savedBrowser = process.env.SPECRAILS_BROWSER_CAPTURE
  const savedInteractive = process.env.SPECRAILS_INTERACTIVE_JOBS

  afterEach(() => {
    if (savedInteractive === undefined) delete process.env.SPECRAILS_INTERACTIVE_JOBS
    else process.env.SPECRAILS_INTERACTIVE_JOBS = savedInteractive
    if (savedCode === undefined) delete process.env.SPECRAILS_CODE_EXPLORER
    else process.env.SPECRAILS_CODE_EXPLORER = savedCode
    if (savedBrowser === undefined) delete process.env.SPECRAILS_BROWSER_CAPTURE
    else process.env.SPECRAILS_BROWSER_CAPTURE = savedBrowser
  })

  it('isCodeExplorerEnabled defaults ON and opts out on "false"', () => {
    delete process.env.SPECRAILS_CODE_EXPLORER
    expect(isCodeExplorerEnabled()).toBe(true)
    process.env.SPECRAILS_CODE_EXPLORER = 'false'
    expect(isCodeExplorerEnabled()).toBe(false)
    process.env.SPECRAILS_CODE_EXPLORER = 'true'
    expect(isCodeExplorerEnabled()).toBe(true)
  })

  it('isBrowserCaptureEnabled defaults ON and opts out on "false"', () => {
    delete process.env.SPECRAILS_BROWSER_CAPTURE
    expect(isBrowserCaptureEnabled()).toBe(true)
    process.env.SPECRAILS_BROWSER_CAPTURE = 'false'
    expect(isBrowserCaptureEnabled()).toBe(false)
    process.env.SPECRAILS_BROWSER_CAPTURE = '1'
    expect(isBrowserCaptureEnabled()).toBe(true)
  })

  it('isInteractiveJobsEnabled defaults ON and opts out on "false"', () => {
    delete process.env.SPECRAILS_INTERACTIVE_JOBS
    expect(isInteractiveJobsEnabled()).toBe(true)
    process.env.SPECRAILS_INTERACTIVE_JOBS = 'false'
    expect(isInteractiveJobsEnabled()).toBe(false)
    process.env.SPECRAILS_INTERACTIVE_JOBS = '1'
    expect(isInteractiveJobsEnabled()).toBe(true)
  })
})
