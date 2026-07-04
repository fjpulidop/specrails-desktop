import { describe, it, expect } from 'vitest'
import { dataUrlToFile } from '../data-url'

// A 1×1 transparent PNG — the same shape canvas.toDataURL / the capture API produce.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

describe('dataUrlToFile', () => {
  it('decodes a base64 PNG data URL into a File with the right name/type/bytes', async () => {
    const file = dataUrlToFile(`data:image/png;base64,${PNG_B64}`, 'capture-1.png')
    expect(file.name).toBe('capture-1.png')
    expect(file.type).toBe('image/png')
    const bytes = new Uint8Array(await file.arrayBuffer())
    // PNG magic number.
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(bytes.length).toBeGreaterThan(20)
  })

  it('decodes a percent-encoded (non-base64) data URL', async () => {
    const file = dataUrlToFile('data:text/plain,hello%20world', 'note.txt')
    expect(file.type).toBe('text/plain')
    expect(await file.text()).toBe('hello world')
  })

  it('defaults the mime type when the header omits it', () => {
    const file = dataUrlToFile(`data:;base64,${PNG_B64}`, 'blob.bin')
    expect(file.type).toBe('application/octet-stream')
  })

  it('throws on a non-data URL', () => {
    expect(() => dataUrlToFile('https://example.com/x.png', 'x.png')).toThrow(/not a data URL/)
    expect(() => dataUrlToFile('data:image/png;base64', 'x.png')).toThrow(/not a data URL/)
  })
})
