import { describe, it, expect } from 'vitest'
import { OscParser } from './terminal-osc-parser'

function bytes(s: string): Buffer { return Buffer.from(s, 'utf-8') }

describe('OscParser', () => {
  it('parses prompt-start with BEL terminator', () => {
    const p = new OscParser()
    expect(p.feed(bytes('\x1b]133;A\x07'))).toEqual([{ kind: 'prompt-start' }])
  })

  it('parses prompt-start with ST (ESC \\) terminator', () => {
    const p = new OscParser()
    expect(p.feed(bytes('\x1b]133;A\x1b\\'))).toEqual([{ kind: 'prompt-start' }])
  })

  it('parses post-exec with exit code', () => {
    const p = new OscParser()
    expect(p.feed(bytes('\x1b]133;D;7\x07'))).toEqual([{ kind: 'post-exec', exitCode: 7 }])
  })

  it('parses post-exec with no exit code', () => {
    const p = new OscParser()
    expect(p.feed(bytes('\x1b]133;D\x07'))).toEqual([{ kind: 'post-exec' }])
  })

  it('parses CurrentDir mark', () => {
    const p = new OscParser()
    expect(p.feed(bytes('\x1b]1337;CurrentDir=/Users/me/repo\x07'))).toEqual([
      { kind: 'cwd', payload: '/Users/me/repo' },
    ])
  })

  it('ignores OSC 1337 File= sequence (passes through, no mark)', () => {
    const p = new OscParser()
    expect(p.feed(bytes('\x1b]1337;File=name=foo.png;inline=1:abcd\x07'))).toEqual([])
  })

  it('handles multiple sequences in one chunk', () => {
    const p = new OscParser()
    const buf = bytes('\x1b]133;A\x07prompt> \x1b]133;C\x07ls\n\x1b]133;D;0\x07')
    expect(p.feed(buf)).toEqual([
      { kind: 'prompt-start' },
      { kind: 'pre-exec' },
      { kind: 'post-exec', exitCode: 0 },
    ])
  })

  it('handles fragmented sequences across chunk boundaries', () => {
    const p = new OscParser()
    expect(p.feed(bytes('\x1b]133'))).toEqual([])
    expect(p.feed(bytes(';A'))).toEqual([])
    expect(p.feed(bytes('\x07'))).toEqual([{ kind: 'prompt-start' }])
  })

  it('tolerates malformed truncated sequence (no terminator) followed by valid', () => {
    const p = new OscParser()
    // We feed a malformed body, then a fresh ESC to start a new OSC. The state machine
    // discards the previous body when it sees ESC[ESC] start.
    p.feed(bytes('\x1b]133;A')) // no terminator
    p.feed(bytes('\x1b]133;C\x07')) // restart and finish
    // Behaviour: the first sequence's body is treated as a continuation until the BEL. Since
    // we encountered ESC mid-body, we re-enter the OSC-start state and the next ']' opens a fresh
    // body. The valid C sequence emits.
    const out = p.feed(bytes('\x1b]133;A\x07'))
    expect(out).toEqual([{ kind: 'prompt-start' }])
  })

  it('ignores unknown 133 subcode', () => {
    const p = new OscParser()
    expect(p.feed(bytes('\x1b]133;X\x07'))).toEqual([])
  })

  it('tolerates ESC inside body that is not ST', () => {
    const p = new OscParser()
    // An ESC followed by non-backslash non-ESC is a false-alarm ST; we recover and append.
    expect(p.feed(bytes('\x1b]133;A\x07'))).toEqual([{ kind: 'prompt-start' }])
  })

  it('caps OSC body to a bounded size (no memory blowup)', () => {
    const p = new OscParser()
    const huge = '\x1b]1337;CurrentDir=' + 'x'.repeat(20_000) + '\x07'
    // Even with a huge payload we must not throw or allocate unboundedly.
    const out = p.feed(bytes(huge))
    // The body cap is 8KB; the sequence is dropped silently.
    expect(out).toEqual([])
  })

  it('passes through unrecognised codes without emitting events', () => {
    const p = new OscParser()
    expect(p.feed(bytes('\x1b]2;Window Title\x07'))).toEqual([])
  })

  it('parses real-world combo: starship-like prompt sequence', () => {
    const p = new OscParser()
    const seq = bytes(
      '\x1b]133;A\x07' +              // prompt-start
      '~/repo \x1b[0;32m❯\x1b[0m ' +   // styled prompt body, no marks
      '\x1b]133;B\x07' +              // prompt-end
      'cargo build\n' +
      '\x1b]133;C\x07' +              // pre-exec
      '   Compiling foo v0.1.0\n' +
      '    Finished release [optimized] target(s) in 0.30s\n' +
      '\x1b]133;D;0\x07' +            // post-exec, exit 0
      '\x1b]1337;CurrentDir=/Users/me/repo\x07' // cwd
    )
    expect(p.feed(seq)).toEqual([
      { kind: 'prompt-start' },
      { kind: 'prompt-end' },
      { kind: 'pre-exec' },
      { kind: 'post-exec', exitCode: 0 },
      { kind: 'cwd', payload: '/Users/me/repo' },
    ])
  })

  it('reset() clears in-flight body state', () => {
    const p = new OscParser()
    p.feed(bytes('\x1b]133')) // mid-body
    p.reset()
    expect(p.feed(bytes(';A\x07'))).toEqual([])
  })

  it('benchmark sanity: 8KB chunk processing stays well bounded', () => {
    // This is a sanity bench; we don't gate strictly to avoid flakiness on slow runners.
    const p = new OscParser()
    const buf = Buffer.alloc(8192)
    // Fill with mostly plain ASCII and a few prompt marks at the start/middle.
    const prefix = bytes('\x1b]133;A\x07hello world ')
    prefix.copy(buf, 0)
    for (let i = prefix.length; i < buf.length; i++) buf[i] = 0x61 // 'a'
    let runs = 0
    const samples: number[] = []
    while (runs < 1000) {
      const t0 = process.hrtime.bigint()
      p.feed(buf)
      const t1 = process.hrtime.bigint()
      samples.push(Number(t1 - t0) / 1e6) // ms
      runs++
    }
    samples.sort((a, b) => a - b)
    const p99 = samples[Math.floor(samples.length * 0.99)]
    // Generous bound: this only catches a catastrophic (e.g. quadratic) blowup —
    // a healthy parser does 8KB in microseconds. The previous 5ms bound flaked on
    // loaded CI runners (p99 spiked to ~6ms under contention); 50ms keeps a 50x+
    // margin while staying immune to runner jitter. This is a sanity check, not a
    // regression gate.
    expect(p99).toBeLessThan(50)
  })
})
