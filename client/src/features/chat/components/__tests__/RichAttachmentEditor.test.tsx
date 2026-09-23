import { describe, it, expect } from 'vitest'
import { render, screen } from '../../../../test-utils'
import { RichAttachmentEditor } from '../RichAttachmentEditor'

describe('RichAttachmentEditor — height bounds', () => {
  it('caps the editor height and scrolls instead of growing without bound', () => {
    // Regression: pasting a very large text grew the contenteditable off-screen
    // with no vertical scroll because no maxHeight was set.
    render(<RichAttachmentEditor ticketKey="t1" ariaLabel="Composer" />)
    const box = screen.getByRole('textbox')
    expect(box.style.overflow).toBe('auto')
    expect(box.style.maxHeight).toBe('320px') // default cap
    expect(box.style.minHeight).toBe('120px') // default floor
  })

  it('honours a custom maxHeight/minHeight', () => {
    render(<RichAttachmentEditor ticketKey="t2" ariaLabel="Composer" minHeight={72} maxHeight={200} />)
    const box = screen.getByRole('textbox')
    expect(box.style.minHeight).toBe('72px')
    expect(box.style.maxHeight).toBe('200px')
    expect(box.style.overflow).toBe('auto')
  })
})
