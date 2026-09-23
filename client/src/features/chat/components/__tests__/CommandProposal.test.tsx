import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '../../../../test-utils'
import { CommandProposal } from '../CommandProposal'

describe('CommandProposal', () => {
  const command = '/specrails:implement --spec SPEA-001'
  const onRun = vi.fn()
  const onDismiss = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders "Suggested command" heading', () => {
    render(<CommandProposal command={command} onRun={onRun} onDismiss={onDismiss} />)
    expect(screen.getByText('Suggested command')).toBeInTheDocument()
  })

  it('renders the command text', () => {
    render(<CommandProposal command={command} onRun={onRun} onDismiss={onDismiss} />)
    expect(screen.getByText(command)).toBeInTheDocument()
  })

  it('renders Run and Dismiss buttons initially', () => {
    render(<CommandProposal command={command} onRun={onRun} onDismiss={onDismiss} />)
    expect(screen.getByRole('button', { name: /run/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument()
  })

  it('calls onRun with command when Run is clicked', () => {
    render(<CommandProposal command={command} onRun={onRun} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole('button', { name: /run/i }))
    expect(onRun).toHaveBeenCalledWith(command)
    expect(onRun).toHaveBeenCalledTimes(1)
  })

  it('shows "Queued" badge after Run is clicked', () => {
    render(<CommandProposal command={command} onRun={onRun} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole('button', { name: /run/i }))
    expect(screen.getByText('Queued')).toBeInTheDocument()
  })

  it('hides Run and Dismiss buttons after Run is clicked', () => {
    render(<CommandProposal command={command} onRun={onRun} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole('button', { name: /run/i }))
    expect(screen.queryByRole('button', { name: /run/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /dismiss/i })).not.toBeInTheDocument()
  })

  it('calls onDismiss with command when Dismiss is clicked', () => {
    render(<CommandProposal command={command} onRun={onRun} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(onDismiss).toHaveBeenCalledWith(command)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('does not show "Queued" initially', () => {
    render(<CommandProposal command={command} onRun={onRun} onDismiss={onDismiss} />)
    expect(screen.queryByText('Queued')).not.toBeInTheDocument()
  })

  it('renders the command in a preformatted block', () => {
    render(<CommandProposal command={command} onRun={onRun} onDismiss={onDismiss} />)
    const pre = document.querySelector('pre')
    expect(pre).toBeTruthy()
    expect(pre?.textContent).toBe(command)
  })
})
