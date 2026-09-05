import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaptureResult } from '../../lib/browser-capture'

const { upload } = vi.hoisted(() => ({ upload: vi.fn() }))
vi.mock('../../lib/browser-capture', () => ({ uploadCaptureImage: upload }))

import { AnnotationEditor, ImageAnnotationEditor } from './AnnotationEditor'

const ORIGINAL = 'data:image/png;base64,b3JpZ2luYWw='
const ANNOTATED = 'data:image/png;base64,YW5ub3RhdGVk'

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('PointerEvent', MouseEvent)
})

afterEach(() => { vi.unstubAllGlobals() })

function loadImage(naturalWidth = 2560, naturalHeight = 1600, availableWidth = 1280, availableHeight = 800) {
  const image = screen.getByRole('img') as HTMLImageElement
  Object.defineProperties(image, { naturalWidth: { value: naturalWidth }, naturalHeight: { value: naturalHeight } })
  vi.spyOn(image.parentElement!.parentElement!, 'getBoundingClientRect').mockReturnValue({ width: availableWidth, height: availableHeight } as DOMRect)
  vi.spyOn(image, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1280, height: 800 } as DOMRect)
  fireEvent.load(image)
  return image
}

function addRedaction() {
  fireEvent.click(screen.getByRole('button', { name: /^(Blur \/ redact|Redact)/ }))
  const layer = screen.getByRole('img').parentElement!.querySelector('svg')!
  fireEvent.pointerDown(layer, { clientX: 100, clientY: 100, pointerId: 1 })
  fireEvent.pointerMove(layer, { clientX: 400, clientY: 300, pointerId: 1 })
  fireEvent.pointerUp(layer, { clientX: 400, clientY: 300, pointerId: 1 })
}

function mockCanvas() {
  const context = {
    drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: '',
  }
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(ANNOTATED)
  return { context, getContext }
}

describe('ImageAnnotationEditor', () => {
  it.each([
    { width: 2560, height: 1600, expectedWidth: 896, expectedHeight: 560 },
    { width: 750, height: 4000, expectedWidth: 105, expectedHeight: 560 },
  ])('fits a $width×$height image inside the space left for the image without changing its ratio', ({ width, height, expectedWidth, expectedHeight }) => {
    render(<ImageAnnotationEditor screenshotDataUrl={ORIGINAL} onConfirm={vi.fn()} onReselect={vi.fn()} onCancel={vi.fn()} />)
    const image = loadImage(width, height, 1200, 560)
    expect(Number.parseFloat(image.parentElement!.style.width)).toBeCloseTo(expectedWidth)
    expect(Number.parseFloat(image.parentElement!.style.height)).toBeCloseTo(expectedHeight)
    const box = image.parentElement!.querySelector('svg')!.getAttribute('viewBox')!.split(' ').map(Number)
    expect(box[2]).toBeCloseTo(expectedWidth)
    expect(box[3]).toBeCloseTo(expectedHeight)
  })

  it('awaits saving even without annotations and prevents duplicate confirmation', async () => {
    let save!: () => void
    const onConfirm = vi.fn(() => new Promise<void>((resolve) => { save = resolve }))
    render(<ImageAnnotationEditor screenshotDataUrl={ORIGINAL} onConfirm={onConfirm} onReselect={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByTestId('annotation-confirm'))
    expect(screen.getByTestId('annotation-confirm')).toBeDisabled()
    fireEvent.click(screen.getByTestId('annotation-confirm'))
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith({ screenshotDataUrl: ORIGINAL })
    await act(async () => { save() })
    expect(screen.getByTestId('annotation-confirm')).toBeEnabled()
  })

  it('flattens redactions at natural Retina resolution for any attachment destination', async () => {
    const { context, getContext } = mockCanvas()
    const onConfirm = vi.fn()
    render(<ImageAnnotationEditor screenshotDataUrl={ORIGINAL} onConfirm={onConfirm} onReselect={vi.fn()} onCancel={vi.fn()} />)
    const image = loadImage()
    addRedaction()
    fireEvent.click(screen.getByTestId('annotation-confirm'))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
    expect(onConfirm.mock.calls[0][0]).toMatchObject({ screenshotDataUrl: ANNOTATED, annotations: { baseWidth: 2560, baseHeight: 1600, objects: [{ kind: 'blur' }] } })
    const canvas = getContext.mock.instances[0] as unknown as HTMLCanvasElement
    expect([canvas.width, canvas.height]).toEqual([2560, 1600])
    expect(context.drawImage).toHaveBeenCalledWith(image, 0, 0, 2560, 1600)
    expect(context.fillStyle).toBe('#111827')
    expect(context.fillRect).toHaveBeenCalledWith(200, 200, 600, 400)
    expect(upload).not.toHaveBeenCalled()
  })

  it('keeps redactions and offers retry when canvas rendering fails instead of sending the original', async () => {
    const { getContext } = mockCanvas()
    getContext.mockReturnValueOnce(null)
    const onConfirm = vi.fn()
    render(<ImageAnnotationEditor screenshotDataUrl={ORIGINAL} onConfirm={onConfirm} onReselect={vi.fn()} onCancel={vi.fn()} />)
    loadImage()
    addRedaction()
    fireEvent.click(screen.getByTestId('annotation-confirm'))
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled()
    fireEvent.click(screen.getByTestId('annotation-confirm'))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
    expect(onConfirm.mock.calls[0][0].screenshotDataUrl).toBe(ANNOTATED)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps the editor open if the destination rejects an unannotated snapshot', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('offline'))
    render(<ImageAnnotationEditor screenshotDataUrl={ORIGINAL} onConfirm={onConfirm} onReselect={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByTestId('annotation-confirm'))
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByTestId('annotation-confirm')).toBeEnabled()
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})

describe('AnnotationEditor capture storage wrapper', () => {
  it('only confirms the annotated attachment after an upload succeeds, retaining a failed redaction for retry', async () => {
    mockCanvas()
    const onConfirm = vi.fn()
    const screenshot = { id: 'raw', name: 'screen.png' }
    const domAttachment = { id: 'dom' }
    const result = { screenshot, domAttachment, screenshotDataUrl: ORIGINAL } as unknown as CaptureResult
    upload.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ id: 'annotated' })
    render(<AnnotationEditor result={result} pendingSpecId="pending-a" onConfirm={onConfirm} onReselect={vi.fn()} onCancel={vi.fn()} />)
    loadImage()
    addRedaction()
    fireEvent.click(screen.getByTestId('annotation-confirm'))
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('annotation-confirm'))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
    expect(upload.mock.calls[1][0]).toBe('pending-a')
    expect(upload.mock.calls[1][1]).toBeInstanceOf(File)
    expect(onConfirm.mock.calls[0][0]).toMatchObject({ screenshot: { id: 'annotated' }, rawScreenshot: screenshot, domAttachment, screenshotDataUrl: ANNOTATED })
  })
})
