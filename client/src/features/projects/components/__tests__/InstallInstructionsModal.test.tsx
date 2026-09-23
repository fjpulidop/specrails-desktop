import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { InstallInstructionsModal } from '../InstallInstructionsModal'
import type { SetupPrerequisitesStatus } from '../../hooks/usePrerequisites'

function statusFor(platform: 'darwin' | 'win32' | 'linux'): SetupPrerequisitesStatus {
  return {
    ok: false,
    platform,
    prerequisites: [],
    missingRequired: [],
  }
}

describe('InstallInstructionsModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders only the host platform section by default (macOS)', () => {
    render(<InstallInstructionsModal open={true} onClose={() => {}} status={statusFor('darwin')} onRecheck={() => {}} />)
    expect(screen.getByTestId('install-section-darwin')).toBeInTheDocument()
    expect(screen.queryByTestId('install-section-win32')).not.toBeInTheDocument()
    expect(screen.queryByTestId('install-section-linux')).not.toBeInTheDocument()
  })

  it('shows Windows section by default when host is Windows and includes the winget command', () => {
    render(<InstallInstructionsModal open={true} onClose={() => {}} status={statusFor('win32')} onRecheck={() => {}} />)
    const section = screen.getByTestId('install-section-win32')
    expect(section).toBeInTheDocument()
    expect(section.textContent).toContain('winget install OpenJS.NodeJS.LTS')
    expect(section.textContent).toContain('winget install Git.Git')
  })

  it('reveals other platforms via the toggle', () => {
    render(<InstallInstructionsModal open={true} onClose={() => {}} status={statusFor('darwin')} onRecheck={() => {}} />)
    fireEvent.click(screen.getByTestId('install-toggle-others'))
    expect(screen.getByTestId('install-section-win32')).toBeInTheDocument()
    expect(screen.getByTestId('install-section-linux')).toBeInTheDocument()
  })

  it('writes the command to the clipboard when copy is clicked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    render(<InstallInstructionsModal open={true} onClose={() => {}} status={statusFor('darwin')} onRecheck={() => {}} />)
    fireEvent.click(screen.getAllByTestId('install-copy-button')[0])

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('brew install node git'))
    expect(await screen.findByText(/copied/i)).toBeInTheDocument()
  })

  it('falls back to execCommand when clipboard API is unavailable', async () => {
    Object.assign(navigator, { clipboard: undefined })
    const execCommand = vi.fn().mockReturnValue(true)
    Object.assign(document, { execCommand })

    render(<InstallInstructionsModal open={true} onClose={() => {}} status={statusFor('darwin')} onRecheck={() => {}} />)
    fireEvent.click(screen.getAllByTestId('install-copy-button')[0])

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith('copy'))
  })

  it('triggers onRecheck when the recheck button is clicked', () => {
    const onRecheck = vi.fn()
    render(<InstallInstructionsModal open={true} onClose={() => {}} status={statusFor('darwin')} onRecheck={onRecheck} />)
    fireEvent.click(screen.getByTestId('install-recheck-button'))
    expect(onRecheck).toHaveBeenCalledTimes(1)
  })
})
