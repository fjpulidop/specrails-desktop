import { describe, expect, it } from 'vitest'
import { captureProcessOutput, createLogRing } from './log-ring'

describe('server log ring', () => {
  it('timestamps complete lines, keeps partial ones and drops the oldest past the cap', () => {
    const ring = createLogRing({ maxChars: 120, now: () => Date.UTC(2026, 0, 1) })
    ring.push('out', 'one\ntw')
    ring.push('out', 'o\n')
    ring.push('err', Buffer.from('partial'))
    expect(ring.text()).toBe('2026-01-01T00:00:00.000Z [OUT] one\n2026-01-01T00:00:00.000Z [OUT] two\n2026-01-01T00:00:00.000Z [ERR] partial\n')
    for (let i = 0; i < 10; i++) ring.push('out', `line ${i}\n`)
    const text = ring.text()
    expect(text.length).toBeLessThanOrEqual(200)
    expect(text).toContain('line 9')
    expect(text).not.toContain('[OUT] one')
  })

  it('mirrors stream writes without changing them and can be removed', () => {
    const ring = createLogRing()
    const written: unknown[] = []
    const out = { write: (chunk: unknown) => { written.push(chunk); return true } } as unknown as NodeJS.WriteStream
    const err = { write: () => true } as unknown as NodeJS.WriteStream
    const restore = captureProcessOutput(ring, { out, err })
    out.write('hello\n')
    expect(written).toEqual(['hello\n'])
    expect(ring.text()).toContain('[OUT] hello')
    restore()
    out.write('after\n')
    expect(ring.text()).not.toContain('after')
  })
})
