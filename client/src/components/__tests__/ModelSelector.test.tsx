import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import { render } from '../../test-utils'
import { getDefaultModel, ModelSelector } from '../ModelSelector'
import type { AgentDef } from '../AgentSelector'

const SAMPLE_AGENTS: AgentDef[] = [
  { id: 'sr-developer', name: 'Developer', description: 'Full-stack', category: 'Core' },
  { id: 'sr-architect', name: 'Architect', description: 'Architecture', category: 'Core' },
]

describe('getDefaultModel', () => {
  it('returns sonnet for non-special agents in balanced preset (claude)', () => {
    expect(getDefaultModel('sr-developer', 'balanced', 'claude')).toBe('sonnet')
  })

  it('returns sonnet for architect in balanced preset (claude)', () => {
    expect(getDefaultModel('sr-architect', 'balanced', 'claude')).toBe('sonnet')
  })

  it('returns sonnet for product-manager in balanced preset (claude)', () => {
    expect(getDefaultModel('sr-product-manager', 'balanced', 'claude')).toBe('sonnet')
  })

  it('returns haiku for budget preset (claude)', () => {
    expect(getDefaultModel('sr-developer', 'budget', 'claude')).toBe('haiku')
  })

  it('returns sonnet for non-special agents in max preset (claude)', () => {
    expect(getDefaultModel('sr-developer', 'max', 'claude')).toBe('sonnet')
  })

  it('returns opus for architect in max preset (claude)', () => {
    expect(getDefaultModel('sr-architect', 'max', 'claude')).toBe('opus')
  })

  it('returns gpt-5.4-mini for budget preset (codex)', () => {
    expect(getDefaultModel('sr-developer', 'budget', 'codex')).toBe('gpt-5.4-mini')
  })

  it('returns gpt-5.5 for architect in balanced preset (codex)', () => {
    expect(getDefaultModel('sr-architect', 'balanced', 'codex')).toBe('gpt-5.5')
  })

  it('returns o3 for sr-architect in max preset (codex)', () => {
    expect(getDefaultModel('sr-architect', 'max', 'codex')).toBe('gpt-5.3-codex')
  })

  it('returns o3 for sr-product-manager in max preset (codex)', () => {
    expect(getDefaultModel('sr-product-manager', 'max', 'codex')).toBe('gpt-5.3-codex')
  })

  it('returns gemini-3.5-flash for non-special agents in balanced preset (gemini)', () => {
    expect(getDefaultModel('sr-developer', 'balanced', 'gemini')).toBe('gemini-3.5-flash')
  })

  it('returns gemini-2.5-flash-lite for budget preset (gemini)', () => {
    expect(getDefaultModel('sr-developer', 'budget', 'gemini')).toBe('gemini-2.5-flash-lite')
  })

  it('returns gemini-3.1-pro-preview for architect in max preset (gemini)', () => {
    expect(getDefaultModel('sr-architect', 'max', 'gemini')).toBe('gemini-3.1-pro-preview')
  })

  it('falls back to claude models for an unknown provider', () => {
    expect(getDefaultModel('sr-developer', 'balanced', 'mystery')).toBe('sonnet')
  })

  it('returns gpt-5.5 for sr-developer in max preset (codex)', () => {
    expect(getDefaultModel('sr-developer', 'max', 'codex')).toBe('gpt-5.5')
  })

  it('returns gpt-5.4-mini for any agent in budget preset (codex)', () => {
    expect(getDefaultModel('sr-developer', 'budget', 'codex')).toBe('gpt-5.4-mini')
    expect(getDefaultModel('sr-architect', 'budget', 'codex')).toBe('gpt-5.4-mini')
  })
})

describe('ModelSelector', () => {
  it('renders preset buttons', () => {
    render(
      <ModelSelector
        agents={SAMPLE_AGENTS}
        provider="claude"
        preset="balanced"
        overrides={{}}
        onPresetChange={vi.fn()}
        onOverrideChange={vi.fn()}
      />
    )
    expect(screen.getByText('Balanced')).toBeInTheDocument()
    expect(screen.getByText('Budget')).toBeInTheDocument()
    expect(screen.getByText('Max')).toBeInTheDocument()
  })

  it('calls onPresetChange when preset button is clicked', () => {
    const onPresetChange = vi.fn()
    render(
      <ModelSelector
        agents={SAMPLE_AGENTS}
        provider="claude"
        preset="balanced"
        overrides={{}}
        onPresetChange={onPresetChange}
        onOverrideChange={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText('Budget'))
    expect(onPresetChange).toHaveBeenCalledWith('budget')
  })

  it('renders agent names in the override list', () => {
    render(
      <ModelSelector
        agents={SAMPLE_AGENTS}
        provider="claude"
        preset="balanced"
        overrides={{}}
        onPresetChange={vi.fn()}
        onOverrideChange={vi.fn()}
      />
    )
    expect(screen.getByText('Developer')).toBeInTheDocument()
    expect(screen.getByText('Architect')).toBeInTheDocument()
  })

  it('shows "custom" label for overridden agents', () => {
    render(
      <ModelSelector
        agents={SAMPLE_AGENTS}
        provider="claude"
        preset="balanced"
        overrides={{ 'sr-developer': 'opus' }}
        onPresetChange={vi.fn()}
        onOverrideChange={vi.fn()}
      />
    )
    expect(screen.getByText('custom')).toBeInTheDocument()
  })

  it('shows reset button for overridden agent and calls onOverrideChange with empty string', () => {
    const onOverrideChange = vi.fn()
    render(
      <ModelSelector
        agents={SAMPLE_AGENTS}
        provider="claude"
        preset="balanced"
        overrides={{ 'sr-developer': 'opus' }}
        onPresetChange={vi.fn()}
        onOverrideChange={onOverrideChange}
      />
    )
    const resetBtn = screen.getByTitle('Reset to preset default')
    fireEvent.click(resetBtn)
    expect(onOverrideChange).toHaveBeenCalledWith('sr-developer', '')
  })

  it('shows override count', () => {
    render(
      <ModelSelector
        agents={SAMPLE_AGENTS}
        provider="claude"
        preset="balanced"
        overrides={{ 'sr-developer': 'opus', 'sr-architect': 'haiku' }}
        onPresetChange={vi.fn()}
        onOverrideChange={vi.fn()}
      />
    )
    expect(screen.getByText('2 overridden')).toBeInTheDocument()
  })

  it('uses codex models when provider is codex', () => {
    render(
      <ModelSelector
        agents={SAMPLE_AGENTS}
        provider="codex"
        preset="balanced"
        overrides={{}}
        onPresetChange={vi.fn()}
        onOverrideChange={vi.fn()}
      />
    )
    // Codex model names should appear (GPT-5.x lineup)
    expect(screen.getAllByText(/GPT-5\.5/i).length).toBeGreaterThan(0)
  })
})
