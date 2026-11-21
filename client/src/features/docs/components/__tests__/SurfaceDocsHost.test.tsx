import { describe, it, expect, vi } from 'vitest'
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '../../../../test-utils'
import type { DocsTarget } from '../../../../lib/docs-events'

vi.mock('../DocsDialog', () => ({
  default: ({ open, onClose, target, showReplayTour }: { open: boolean; onClose: () => void; target: (DocsTarget & { nonce: number }) | null; showReplayTour?: boolean }) => open
    ? <div data-testid="docs-modal" data-target={target ? `${target.category}/${target.slug}#${target.anchor ?? ''}:${target.nonce}` : 'none'} data-replay={String(showReplayTour)}>
        <button type="button" onClick={onClose}>close docs</button>
      </div>
    : null,
}))

import { SurfaceDocsHost } from '../SurfaceDocsHost'
import { HelpHint } from '../../../../components/HelpHint'
import { openDocs } from '../../../../lib/docs-events'
import { helpTarget } from '../../../../lib/help-topics'

describe('SurfaceDocsHost', () => {
  it('renders nothing until the guide is asked for', () => {
    const { container } = render(<SurfaceDocsHost />)
    expect(container).toBeEmptyDOMElement()
  })

  it('a "Learn more" hint inside a surface window opens the guide in that window, at its section, without the tour', async () => {
    const user = userEvent.setup()
    render(<><HelpHint topic="themes" variant="link" /><SurfaceDocsHost /></>)
    await user.click(screen.getByRole('button', { name: /learn more/i }))
    const modal = await screen.findByTestId('docs-modal')
    const t = helpTarget('themes')
    expect(modal).toHaveAttribute('data-target', `${t.category}/${t.slug}#${t.anchor ?? ''}:1`)
    expect(modal).toHaveAttribute('data-replay', 'false')
    await user.click(screen.getByText('close docs'))
    await waitFor(() => expect(screen.queryByTestId('docs-modal')).not.toBeInTheDocument())
    // The same hint again re-opens (a new nonce re-fires the same section).
    act(() => openDocs(t))
    expect(await screen.findByTestId('docs-modal')).toHaveAttribute('data-target', `${t.category}/${t.slug}#${t.anchor ?? ''}:2`)
  })

  it('a plain open (no section) opens the guide wherever it lands', async () => {
    render(<SurfaceDocsHost />)
    act(() => openDocs())
    expect(await screen.findByTestId('docs-modal')).toHaveAttribute('data-target', 'none')
  })
})
