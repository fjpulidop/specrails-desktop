import http from 'http'
import { AddressInfo } from 'net'
import { PassThrough } from 'stream'
import { runCli } from '../runner'
import type { RunnerIo } from '../types'

/**
 * In-process fake OpenAI-compatible endpoint. Each scripted reply is served
 * to the next POST /chat/completions as SSE (`data:` lines, one delta per
 * chunk, `[DONE]` terminator). Requests are recorded for assertions.
 */
export type ScriptedToolCall = { id?: string; name: string; arguments: string }
export type Scripted =
  | { text?: string; toolCalls?: ScriptedToolCall[]; usage?: { prompt_tokens: number; completion_tokens: number }; splitArgs?: boolean }
  | { status: number; body: string; contentType?: string }
  | { rawSse: string }

export interface RecordedRequest {
  headers: http.IncomingHttpHeaders
  body: Record<string, unknown>
}

export class FakeEndpoint {
  readonly requests: RecordedRequest[] = []
  private readonly script: Scripted[] = []
  private server!: http.Server
  baseUrl = ''

  reply(...items: Scripted[]): this {
    this.script.push(...items)
    return this
  }

  async start(): Promise<this> {
    this.server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        if (req.url !== '/v1/chat/completions') {
          res.writeHead(404).end('not found')
          return
        }
        this.requests.push({ headers: req.headers, body: JSON.parse(raw) })
        const next = this.script.shift()
        if (!next) {
          res.writeHead(500, { 'content-type': 'text/plain' }).end('no scripted reply')
          return
        }
        if ('status' in next) {
          res.writeHead(next.status, { 'content-type': next.contentType ?? 'application/json' }).end(next.body)
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        if ('rawSse' in next) {
          res.end(next.rawSse)
          return
        }
        const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
          `data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`
        let out = ''
        for (const word of (next.text ?? '').split(/(?<= )/)) if (word) out += chunk({ content: word })
        ;(next.toolCalls ?? []).forEach((tc, index) => {
          const id = tc.id ?? `call_${index}`
          if (next.splitArgs) {
            out += chunk({ tool_calls: [{ index, id, type: 'function', function: { name: tc.name, arguments: '' } }] })
            for (const piece of tc.arguments.match(/.{1,4}/g) ?? []) out += chunk({ tool_calls: [{ index, function: { arguments: piece } }] })
          } else {
            out += chunk({ tool_calls: [{ index, id, type: 'function', function: { name: tc.name, arguments: tc.arguments } }] })
          }
        })
        const finish = next.toolCalls?.length ? 'tool_calls' : 'stop'
        out += `data: ${JSON.stringify({ id: 'chatcmpl-1', choices: [{ index: 0, delta: {}, finish_reason: finish }], ...(next.usage ? { usage: next.usage } : {}) })}\n\n`
        out += 'data: [DONE]\n\n'
        res.end(out)
      })
    })
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`
    return this
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

export interface Harness {
  io: RunnerIo
  stdin: PassThrough
  frames: () => Array<Record<string, unknown>>
  stderr: () => string
}

export function makeIo(cwd: string, env: Record<string, string | undefined>, extra: Partial<RunnerIo> = {}): Harness {
  const stdin = new PassThrough()
  let out = ''
  let err = ''
  const io: RunnerIo = {
    stdin,
    stdout: { write: (c: string) => (out += c) },
    stderr: { write: (c: string) => (err += c) },
    env,
    cwd,
    ...extra,
  }
  return {
    io,
    stdin,
    frames: () => out.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>),
    stderr: () => err,
  }
}

export async function run(argv: string[], h: Harness): Promise<number> {
  return runCli(argv, h.io)
}

export const byType = (frames: Array<Record<string, unknown>>, type: string) => frames.filter((f) => f.type === type)
export const resultOf = (frames: Array<Record<string, unknown>>) => byType(frames, 'result').at(-1) as Record<string, unknown>
export const assistantBlocks = (frames: Array<Record<string, unknown>>) =>
  byType(frames, 'assistant').flatMap((f) => ((f.message as { content: Array<Record<string, unknown>> }).content ?? []))
export const assistantText = (frames: Array<Record<string, unknown>>) =>
  assistantBlocks(frames)
    .filter((b) => b.type === 'text')
    .map((b) => b.text as string)
    .join('')
