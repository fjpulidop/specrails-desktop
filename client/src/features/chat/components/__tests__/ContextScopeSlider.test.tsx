import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { ContextScopeSlider, PRESETS, presetIndexFor } from '../ContextScopeSlider'
import type { ContextScope } from '../../types/context-scope'

const MINIMAL: ContextScope = PRESETS[0].scope
const STANDARD: ContextScope = PRESETS[2].scope
const RICH: ContextScope = PRESETS[3].scope
const MAX_SCOPE: ContextScope = PRESETS[4].scope
const DESKTOP: ContextScope = PRESETS[5].scope

describe('presetIndexFor', () => {
  it('returns the matching preset index', () => {
    expect(presetIndexFor(MINIMAL)).toBe(0)
    expect(presetIndexFor(STANDARD)).toBe(2)
    expect(presetIndexFor(DESKTOP)).toBe(5)
  })

  it('returns -1 for off-preset combinations (Custom)', () => {
    // Off-preset: specrails false, openspec true is not a defined preset.
    const custom: ContextScope = { specrails: false, openspec: true, full: false, mcp: false, contractRefine: false }
    expect(presetIndexFor(custom)).toBe(-1)
  })
})

describe('ContextScopeSlider', () => {
  it('renders all six stop labels', () => {
    render(<ContextScopeSlider value={STANDARD} onChange={() => {}} />)
    for (const p of PRESETS) {
      expect(screen.getByTestId(`scope-stop-${p.id}`)).toBeInTheDocument()
    }
  })

  it('highlights the active stop', () => {
    render(<ContextScopeSlider value={RICH} onChange={() => {}} />)
    const richBtn = screen.getByTestId('scope-stop-rich')
    expect(richBtn.className).toMatch(/font-semibold/)
  })

  it('clicking a stop emits the matching scope', () => {
    const onChange = vi.fn()
    render(<ContextScopeSlider value={STANDARD} onChange={onChange} />)
    fireEvent.click(screen.getByTestId('scope-stop-max'))
    expect(onChange).toHaveBeenCalledWith(MAX_SCOPE)
  })

  it('ArrowRight advances one stop', () => {
    const onChange = vi.fn()
    render(<ContextScopeSlider value={STANDARD} onChange={onChange} />)
    const slider = screen.getByRole('slider')
    slider.focus()
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenCalledWith(RICH)
  })

  it('ArrowLeft retreats one stop', () => {
    const onChange = vi.fn()
    render(<ContextScopeSlider value={STANDARD} onChange={onChange} />)
    const slider = screen.getByRole('slider')
    slider.focus()
    fireEvent.keyDown(slider, { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenCalledWith(PRESETS[1].scope)
  })

  it('Home jumps to Minimal, End jumps to Desktop', () => {
    const onChange = vi.fn()
    render(<ContextScopeSlider value={STANDARD} onChange={onChange} />)
    const slider = screen.getByRole('slider')
    slider.focus()
    fireEvent.keyDown(slider, { key: 'End' })
    expect(onChange).toHaveBeenLastCalledWith(DESKTOP)
    fireEvent.keyDown(slider, { key: 'Home' })
    expect(onChange).toHaveBeenLastCalledWith(MINIMAL)
  })

  it('renders Custom pill when scope matches no preset', () => {
    const customScope: ContextScope = { specrails: false, openspec: true, full: false, mcp: false, contractRefine: true }
    render(<ContextScopeSlider value={customScope} onChange={() => {}} />)
    expect(screen.getByTestId('scope-custom-pill')).toBeInTheDocument()
    expect(screen.getByTestId('scope-cost-line').textContent).toMatch(/Custom mix/)
  })

  it('emits onPresetChange when active preset changes', () => {
    const onPresetChange = vi.fn()
    const { rerender } = render(
      <ContextScopeSlider value={STANDARD} onChange={() => {}} onPresetChange={onPresetChange} />,
    )
    expect(onPresetChange).toHaveBeenCalledWith('standard')
    rerender(
      <ContextScopeSlider value={DESKTOP} onChange={() => {}} onPresetChange={onPresetChange} />,
    )
    expect(onPresetChange).toHaveBeenLastCalledWith('desktop')
  })

  it('contractRefine is only true at Max and Desktop presets', () => {
    expect(PRESETS[0].scope.contractRefine).toBe(false)
    expect(PRESETS[1].scope.contractRefine).toBe(false)
    expect(PRESETS[2].scope.contractRefine).toBe(false)
    expect(PRESETS[3].scope.contractRefine).toBe(false)
    expect(PRESETS[4].scope.contractRefine).toBe(true)
    expect(PRESETS[5].scope.contractRefine).toBe(true)
  })

  it('userMcp is only enabled by the Desktop preset', () => {
    for (let i = 0; i < 5; i++) expect(PRESETS[i].scope.userMcp ?? false).toBe(false)
    expect(PRESETS[5].id).toBe('desktop')
    expect(PRESETS[5].scope.userMcp).toBe(true)
  })

  it('shows the SMASH-capable hint when contractRefine is on (Max preset)', () => {
    render(<ContextScopeSlider value={MAX_SCOPE} onChange={() => {}} />)
    const hint = screen.getByTestId('scope-smash-hint')
    expect(hint).toBeInTheDocument()
    expect(hint.textContent).toMatch(/SMASH-capable/)
  })

  it('shows the SMASH-capable hint for Desktop preset', () => {
    render(<ContextScopeSlider value={DESKTOP} onChange={() => {}} />)
    expect(screen.getByTestId('scope-smash-hint')).toBeInTheDocument()
  })

  it('hides the SMASH-capable hint when contractRefine is off (Standard / Rich)', () => {
    render(<ContextScopeSlider value={STANDARD} onChange={() => {}} />)
    expect(screen.queryByTestId('scope-smash-hint')).not.toBeInTheDocument()
  })

  it('shows the hint for a Custom scope with contractRefine: true', () => {
    const custom: ContextScope = { specrails: true, openspec: false, full: false, mcp: false, contractRefine: true }
    render(<ContextScopeSlider value={custom} onChange={() => {}} />)
    expect(screen.getByTestId('scope-smash-hint')).toBeInTheDocument()
  })

  it('hides the SMASH hint when smashCapable=false even if contractRefine is true', () => {
    render(<ContextScopeSlider value={MAX_SCOPE} onChange={() => {}} smashCapable={false} />)
    expect(screen.queryByTestId('scope-smash-hint')).not.toBeInTheDocument()
  })

  it('hides the SMASH hint when smashCapable=false with Desktop preset', () => {
    render(<ContextScopeSlider value={DESKTOP} onChange={() => {}} smashCapable={false} />)
    expect(screen.queryByTestId('scope-smash-hint')).not.toBeInTheDocument()
  })

  it('shows the SMASH hint when both contractRefine and smashCapable are true', () => {
    render(<ContextScopeSlider value={MAX_SCOPE} onChange={() => {}} smashCapable={true} />)
    expect(screen.getByTestId('scope-smash-hint')).toBeInTheDocument()
  })

  it('defaults smashCapable to true (backward-compatible with existing callers)', () => {
    // Omitting smashCapable must still show the hint when contractRefine is on
    render(<ContextScopeSlider value={DESKTOP} onChange={() => {}} />)
    expect(screen.getByTestId('scope-smash-hint')).toBeInTheDocument()
  })

  it('can cap the visible scale at Max', () => {
    const onChange = vi.fn()
    render(<ContextScopeSlider value={STANDARD} onChange={onChange} maxPresetId="max" />)
    expect(screen.getByTestId('scope-stop-max')).toBeInTheDocument()
    expect(screen.queryByTestId('scope-stop-desktop')).not.toBeInTheDocument()

    const slider = screen.getByRole('slider')
    expect(slider).toHaveAttribute('aria-valuemax', '4')
    slider.focus()
    fireEvent.keyDown(slider, { key: 'End' })
    expect(onChange).toHaveBeenLastCalledWith(MAX_SCOPE)
  })
})
