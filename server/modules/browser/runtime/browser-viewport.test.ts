import { describe, expect, it } from 'vitest'
import { normalizeBrowserViewport } from './browser-viewport'

describe('normalizeBrowserViewport', () => {
  it('keeps CSS layout unchanged while allocating Retina pixels', () => {
    expect(normalizeBrowserViewport(1280, 800, 2)).toEqual({ width: 1280, height: 800, deviceScaleFactor: 2, rasterWidth: 2560, rasterHeight: 1600 })
  })
  it('bounds raster size without applying page zoom or changing the requested CSS layout', () => {
    expect(normalizeBrowserViewport(3000, 2000, 2)).toEqual({ width: 3000, height: 2000, deviceScaleFactor: 1.2, rasterWidth: 3600, rasterHeight: 2400 })
  })
  it('normalizes invalid dimensions and excessive or non-finite DPR', () => {
    expect(normalizeBrowserViewport(NaN, Infinity, NaN)).toMatchObject({ width: 1280, height: 800, deviceScaleFactor: 1 })
    expect(normalizeBrowserViewport(-10, 0, -3)).toMatchObject({ width: 1, height: 1, deviceScaleFactor: 1 })
    expect(normalizeBrowserViewport(100, 100, 5).deviceScaleFactor).toBe(2)
    expect(normalizeBrowserViewport(10000, 10000, 2)).toMatchObject({ width: 3840, height: 2400, deviceScaleFactor: 1 })
  })
})
