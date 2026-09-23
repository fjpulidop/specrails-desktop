/** CSS layout stays independent from the bounded physical capture raster. */
export const MAX_BROWSER_RASTER = { width: 3840, height: 2400 }

export function normalizeBrowserDeviceScaleFactor(value: number) {
  return Number.isFinite(value) ? Math.min(2, Math.max(1, value)) : 1
}

export function normalizeBrowserViewport(width: number, height: number, deviceScaleFactor = 1) {
  const dimension = (value: number, fallback: number, max: number) => Number.isFinite(value)
    ? Math.min(max, Math.max(1, Math.round(value)))
    : fallback
  const cssWidth = dimension(width, 1280, MAX_BROWSER_RASTER.width)
  const cssHeight = dimension(height, 800, MAX_BROWSER_RASTER.height)
  const requestedScale = normalizeBrowserDeviceScaleFactor(deviceScaleFactor)
  const scale = Math.min(requestedScale, MAX_BROWSER_RASTER.width / cssWidth, MAX_BROWSER_RASTER.height / cssHeight)
  return {
    width: cssWidth,
    height: cssHeight,
    deviceScaleFactor: scale,
    rasterWidth: Math.round(cssWidth * scale),
    rasterHeight: Math.round(cssHeight * scale),
  }
}
