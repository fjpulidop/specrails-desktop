import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { ThemeEffectLayer } from '../ThemeEffectLayer'
import { THEMES, type ThemeId } from '../../../lib/themes'

const mockUseActiveTheme = vi.fn()

vi.mock('../../../context/ThemeContext', () => ({
  useActiveTheme: () => mockUseActiveTheme(),
}))

vi.mock('../CodeRainEffect', () => ({
  CodeRainEffect: () => <div data-testid="code-rain-effect" />,
}))

vi.mock('../BladeTrail', () => ({
  BladeTrail: () => <div data-testid="blade-trail" />,
}))

describe('ThemeEffectLayer', () => {
  it.each(Object.keys(THEMES) as ThemeId[])('dispatches the correct effect for %s', (id) => {
    mockUseActiveTheme.mockReturnValue(THEMES[id])
    const { container, queryByTestId } = render(<ThemeEffectLayer />)

    if (id === 'code-rain') {
      expect(queryByTestId('code-rain-effect')).not.toBeNull()
      expect(queryByTestId('blade-trail')).toBeNull()
    } else if (id === 'galaxy') {
      expect(queryByTestId('blade-trail')).not.toBeNull()
      expect(queryByTestId('code-rain-effect')).toBeNull()
    } else {
      expect(container.firstChild).toBeNull()
    }
  })
})
