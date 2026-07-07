import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { ThemeEffectLayer } from '../ThemeEffectLayer'
import { THEMES, type ThemeId } from '../../../lib/themes'

const mockUseActiveTheme = vi.fn()

vi.mock('../../../context/ThemeContext', () => ({
  useActiveTheme: () => mockUseActiveTheme(),
}))

vi.mock('../MatrixRain', () => ({
  MatrixRain: () => <div data-testid="matrix-rain" />,
}))

vi.mock('../LightsaberTrail', () => ({
  LightsaberTrail: () => <div data-testid="lightsaber-trail" />,
}))

describe('ThemeEffectLayer', () => {
  it.each(Object.keys(THEMES) as ThemeId[])('dispatches the correct effect for %s', (id) => {
    mockUseActiveTheme.mockReturnValue(THEMES[id])
    const { container, queryByTestId } = render(<ThemeEffectLayer />)

    if (id === 'matrix') {
      expect(queryByTestId('matrix-rain')).not.toBeNull()
      expect(queryByTestId('lightsaber-trail')).toBeNull()
    } else if (id === 'star-wars') {
      expect(queryByTestId('lightsaber-trail')).not.toBeNull()
      expect(queryByTestId('matrix-rain')).toBeNull()
    } else {
      expect(container.firstChild).toBeNull()
    }
  })
})
