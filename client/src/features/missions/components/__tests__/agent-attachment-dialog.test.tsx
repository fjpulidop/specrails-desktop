import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../../lib/agent-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/agent-api')>()
  return {
    ...actual,
    fetchAgentAttachmentBlob: vi.fn().mockResolvedValue(new Blob(['x'], { type: 'image/png' })),
  }
})

import { AgentAttachmentChips } from '../AgentMessage'

const IMAGE = { id: 'a1', filename: 'shot.png', mimeType: 'image/png', size: 2048 }
const ZIP = { id: 'a2', filename: 'logs.zip', mimeType: 'application/zip', size: 4096 }

beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:mock') })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
})
afterEach(cleanup)

describe('AgentAttachmentChips dialogs (modal standard)', () => {
  it('opens images in the shared media lightbox with focus trap and focus return', async () => {
    const user = userEvent.setup()
    render(<AgentAttachmentChips conversationId="c1" attachments={[IMAGE] as never} />)
    const chip = screen.getByRole('button', { name: /shot\.png/ })
    await user.click(chip)
    const dialog = await screen.findByRole('dialog')
    expect(dialog.getAttribute('data-dialog-layer')).toBe('media')
    await waitFor(() => expect(document.querySelector('img[src="blob:mock"]')).toBeTruthy())
    for (let i = 0; i < 4; i += 1) {
      await user.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(chip))
  })

  it('asks before downloading other files with a confirm-size standard dialog', async () => {
    const user = userEvent.setup()
    render(<AgentAttachmentChips conversationId="c1" attachments={[ZIP] as never} />)
    await user.click(screen.getByRole('button', { name: /logs\.zip/ }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.getAttribute('data-dialog-size')).toBe('confirm')
    const footer = dialog.querySelector('[data-dialog-footer]')!
    await waitFor(() => expect(footer.querySelector('a[download="logs.zip"]')).toBeTruthy())
    const labels = Array.from(footer.querySelectorAll('button, a')).map((el) => el.textContent?.trim())
    expect(labels).toHaveLength(2)
    // Cancel (ghost) comes before the primary download action.
    expect(footer.firstElementChild?.tagName).toBe('BUTTON')
  })
})
