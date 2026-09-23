import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '../../../../test-utils'
import { PipelineProgress } from '../PipelineProgress'
import type { PhaseDefinition } from '../../../../types'
import type { PhaseMap } from '../../hooks/usePipeline'

const phaseDefinitions: PhaseDefinition[] = [
  { key: 'architect', label: 'Architect', description: 'Design phase' },
  { key: 'developer', label: 'Developer', description: 'Build phase' },
  { key: 'reviewer',  label: 'Reviewer',  description: 'Review phase' },
  { key: 'ship',      label: 'Ship',      description: 'Deploy phase' },
]

describe('PipelineProgress', () => {
  it('renders nothing when phaseDefinitions is empty', () => {
    const { container } = render(<PipelineProgress phases={{}} phaseDefinitions={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders all phase labels', () => {
    render(<PipelineProgress phases={{}} phaseDefinitions={phaseDefinitions} />)
    expect(screen.getByText('Architect')).toBeInTheDocument()
    expect(screen.getByText('Developer')).toBeInTheDocument()
    expect(screen.getByText('Reviewer')).toBeInTheDocument()
    expect(screen.getByText('Ship')).toBeInTheDocument()
  })

  it('shows idle icon (Circle) for idle phases — no spin class', () => {
    const phases: PhaseMap = { architect: 'idle' }
    render(<PipelineProgress phases={phases} phaseDefinitions={phaseDefinitions} />)
    // The idle icon is a plain Circle — no animate-spin class present on any svg
    const svgs = document.querySelectorAll('svg')
    const anySpinning = Array.from(svgs).some((s) => s.classList.contains('animate-spin'))
    expect(anySpinning).toBe(false)
  })

  it('shows running icon (Loader2 with animate-spin) for running phase', () => {
    const phases: PhaseMap = { architect: 'running' }
    render(<PipelineProgress phases={phases} phaseDefinitions={phaseDefinitions} />)
    const spinningEl = document.querySelector('.animate-spin')
    expect(spinningEl).toBeInTheDocument()
  })

  it('renders connector lines between phases', () => {
    render(<PipelineProgress phases={{}} phaseDefinitions={phaseDefinitions} />)
    // There are phaseDefinitions.length - 1 connectors (divs with h-px w-8)
    const connectors = document.querySelectorAll('.h-px.w-12')
    expect(connectors.length).toBe(phaseDefinitions.length - 1)
  })

  it('connector is green-tinted when preceding phase is done', () => {
    const phases: PhaseMap = { architect: 'done' }
    render(<PipelineProgress phases={phases} phaseDefinitions={phaseDefinitions} />)
    // First connector follows architect (done) — uses emerald CSS class
    const connectors = document.querySelectorAll('.h-px.w-12')
    const firstConnector = connectors[0] as HTMLElement
    // Tailwind classes — check CSS class rather than computed style (jsdom doesn't process Tailwind)
    expect(firstConnector.className).toContain('bg-emerald-500')
  })

  it('connector uses muted color when both phases are explicitly idle', () => {
    const phases: PhaseMap = { architect: 'idle', developer: 'idle', reviewer: 'idle', ship: 'idle' }
    render(<PipelineProgress phases={phases} phaseDefinitions={phaseDefinitions} />)
    const connectors = document.querySelectorAll('.h-px.w-12')
    const firstConnector = connectors[0] as HTMLElement
    // All idle — connector should use bg-border class, not the green emerald
    expect(firstConnector.className).toContain('bg-border')
    expect(firstConnector.className).not.toContain('bg-emerald-500')
  })

  it('has correct number of phase items', () => {
    render(<PipelineProgress phases={{}} phaseDefinitions={phaseDefinitions} />)
    // Each phase is a cursor-default div — we look for the labels
    expect(screen.getAllByText(/Architect|Developer|Reviewer|Ship/).length).toBe(4)
  })
})
