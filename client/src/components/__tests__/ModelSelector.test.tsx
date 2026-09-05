import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import { render } from '../../test-utils'
import { CODEX_MODELS, KIMI_MODELS, getDefaultModel, ModelSelector } from '../ModelSelector'
import type { AgentDef } from '../AgentSelector'

const SAMPLE_AGENTS: AgentDef[] = [
  { id: 'sr-developer', name: 'Developer', description: 'Full-stack', category: 'Core' },
  { id: 'sr-architect', name: 'Architect', description: 'Architecture', category: 'Core' },
]

describe('CODEX_MODELS catalog', () => {
  it('lists gpt-6-astra first, then the GPT-5.6 family (sol/terra/luna), ahead of gpt-5.5', () => {
    const values = CODEX_MODELS.map((m) => m.value)
    expect(values.slice(0, 4)).toEqual(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])
    expect(values).toContain('gpt-5.5')
  })
})

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

  it('returns gpt-6-astra for sr-architect in max preset (codex)', () => {
    expect(getDefaultModel('sr-architect', 'max', 'codex')).toBe('gpt-6-astra')
  })

  it('returns gpt-6-astra for sr-product-manager in max preset (codex)', () => {
    expect(getDefaultModel('sr-product-manager', 'max', 'codex')).toBe('gpt-6-astra')
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

  it('returns k3 for every Kimi preset', () => {
    expect(getDefaultModel('sr-developer', 'balanced', 'kimi')).toBe('k3')
    expect(getDefaultModel('sr-developer', 'budget', 'kimi')).toBe('k3')
    expect(getDefaultModel('sr-architect', 'max', 'kimi')).toBe('k3')
  })

  it('does not silently route an unknown provider through Claude', () => {
    expect(getDefaultModel('sr-developer', 'balanced', 'mystery')).toBe('')
  })

  it('returns gpt-6-astra for sr-developer in max preset (codex)', () => {
    expect(getDefaultModel('sr-developer', 'max', 'codex')).toBe('gpt-6-astra')
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

  it('uses the complete Kimi model catalog when provider is Kimi', () => {
    render(
      <ModelSelector
        agents={SAMPLE_AGENTS}
        provider="kimi"
        preset="balanced"
        overrides={{}}
        onPresetChange={vi.fn()}
        onOverrideChange={vi.fn()}
      />
    )
    const developerInput = screen.getByTestId('model-override-sr-developer') as HTMLInputElement
    expect(developerInput.value).toBe('k3')
    const datalist = document.getElementById(developerInput.getAttribute('list') ?? '')
    expect(Array.from(datalist?.querySelectorAll('option') ?? [], (option) => option.value))
      .toEqual(['k3', 'kimi-for-coding', 'kimi-for-coding-highspeed'])
    expect(KIMI_MODELS.map((model) => model.value)).toEqual([
      'k3',
      'kimi-for-coding',
      'kimi-for-coding-highspeed',
    ])
  })

  it('commits only a safe custom Kimi override byte-for-byte', () => {
    const onOverrideChange = vi.fn()
    render(
      <ModelSelector
        agents={SAMPLE_AGENTS}
        provider="kimi"
        preset="balanced"
        overrides={{ 'sr-developer': 'moonshot-team/private-coder:v1' }}
        onPresetChange={vi.fn()}
        onOverrideChange={onOverrideChange}
      />,
    )
    const input = screen.getByTestId('model-override-sr-developer')
    expect(input).toHaveValue('moonshot-team/private-coder:v1')
    fireEvent.change(input, { target: { value: 'Moonshot-Team/Private_Coder:v2' } })
    fireEvent.blur(input)
    expect(onOverrideChange).toHaveBeenCalledWith(
      'sr-developer',
      'Moonshot-Team/Private_Coder:v2',
    )

    fireEvent.change(input, { target: { value: '--yolo' } })
    fireEvent.blur(input)
    expect(onOverrideChange).toHaveBeenCalledTimes(1)
  })
})
