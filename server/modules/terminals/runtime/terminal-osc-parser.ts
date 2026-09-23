/**
 * Streaming OSC sequence parser for shell-integration marks.
 *
 * Recognises:
 *   ESC ] 133 ; A             ST   → prompt-start
 *   ESC ] 133 ; B             ST   → prompt-end (input start)
 *   ESC ] 133 ; C             ST   → pre-exec
 *   ESC ] 133 ; D [; <code>]  ST   → post-exec (with optional exit code)
 *   ESC ] 1337 ; CurrentDir=… ST   → cwd
 *   ESC ] 1337 ; File=…       ST   → (observed but produces no mark; left for image addon)
 *
 * Where ESC = 0x1B, ST = either BEL (0x07) or ESC \ (0x1B 0x5C).
 *
 * Invariants:
 *   - The byte stream is never modified. The parser is observe-only.
 *   - Malformed or truncated sequences are tolerated; parser state is bounded.
 *   - Sequence body length is capped (8 KB) to bound memory under adversarial input.
 */

export type OscMarkKind = 'prompt-start' | 'prompt-end' | 'pre-exec' | 'post-exec' | 'cwd'

export interface OscMarkEvent {
  kind: OscMarkKind
  /** Raw payload after the leading code (e.g. for D;7 the payload is "7"; for CurrentDir=/x, the payload is "/x") */
  payload?: string
  exitCode?: number
}

const ESC = 0x1b
const BEL = 0x07
const BACKSLASH = 0x5c

const MAX_BODY_BYTES = 8 * 1024

type State = 'normal' | 'esc' | 'osc-body' | 'st-pending'

export class OscParser {
  private state: State = 'normal'
  private body: number[] = []

  reset(): void {
    this.state = 'normal'
    this.body = []
  }

  feed(chunk: Uint8Array | Buffer): OscMarkEvent[] {
    const out: OscMarkEvent[] = []
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i]
      switch (this.state) {
        case 'normal':
          if (b === ESC) this.state = 'esc'
          break
        case 'esc':
          if (b === 0x5d /* ']' */) {
            this.state = 'osc-body'
            this.body = []
          } else {
            this.state = 'normal'
          }
          break
        case 'osc-body':
          if (b === BEL) {
            this.flush(out)
            this.state = 'normal'
          } else if (b === ESC) {
            this.state = 'st-pending'
          } else {
            if (this.body.length < MAX_BODY_BYTES) {
              this.body.push(b)
            } else {
              // Body too large — discard sequence and reset.
              this.body = []
              this.state = 'normal'
            }
          }
          break
        case 'st-pending':
          if (b === BACKSLASH) {
            this.flush(out)
            this.state = 'normal'
          } else if (b === ESC) {
            // Two ESCs in a row inside an OSC body — restart from this ESC.
            this.body = []
            this.state = 'esc'
          } else {
            // Not a real ST. Append the previous ESC and this byte to the body.
            if (this.body.length + 2 <= MAX_BODY_BYTES) {
              this.body.push(ESC)
              this.body.push(b)
              this.state = 'osc-body'
            } else {
              this.body = []
              this.state = 'normal'
            }
          }
          break
      }
    }
    return out
  }

  private flush(out: OscMarkEvent[]): void {
    const ev = parseOscBody(this.body)
    if (ev) out.push(ev)
    this.body = []
  }
}

function bytesToString(bytes: number[]): string {
  // Fast ASCII path; OSC payloads are ASCII or UTF-8. Use TextDecoder for safety.
  return new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(bytes))
}

function parseOscBody(bytes: number[]): OscMarkEvent | null {
  if (bytes.length === 0) return null
  // Find the first ';' separator. The code prefix before ';' tells us 133 vs 1337.
  const semicolon = bytes.indexOf(0x3b /* ';' */)
  if (semicolon === -1) return null
  const codeStr = bytesToString(bytes.slice(0, semicolon))
  const rest = bytesToString(bytes.slice(semicolon + 1))
  if (codeStr === '133') return parse133(rest)
  if (codeStr === '1337') return parse1337(rest)
  return null
}

function parse133(rest: string): OscMarkEvent | null {
  if (rest.length === 0) return null
  const subcode = rest[0]
  switch (subcode) {
    case 'A': return { kind: 'prompt-start' }
    case 'B': return { kind: 'prompt-end' }
    case 'C': return { kind: 'pre-exec' }
    case 'D': {
      const tail = rest.slice(1) // "" or ";<code>" or ";<code>;..."
      if (tail.length === 0) return { kind: 'post-exec' }
      if (tail[0] !== ';') return null
      const codeStr = tail.slice(1).split(';')[0]
      if (codeStr.length === 0) return { kind: 'post-exec' }
      const n = Number(codeStr)
      if (!Number.isFinite(n) || !Number.isInteger(n)) return { kind: 'post-exec' }
      return { kind: 'post-exec', exitCode: n }
    }
    default: return null
  }
}

function parse1337(rest: string): OscMarkEvent | null {
  // Only CurrentDir=… surfaces a mark; File=… is left for the image addon.
  const eq = rest.indexOf('=')
  if (eq === -1) return null
  const key = rest.slice(0, eq)
  const value = rest.slice(eq + 1)
  if (key === 'CurrentDir') return { kind: 'cwd', payload: value }
  return null
}
