import type { ChatMessage, ToolCall, ToolDefinition, Usage } from './types'

/**
 * Streaming OpenAI chat-completions client.
 *
 * One `streamCompletion` call = one API request. The endpoint streams SSE
 * `data:` lines; text deltas are forwarded through `onText` as they arrive,
 * `tool_calls` fragments are assembled by `index` (small models split the
 * `arguments` string across many chunks), and usage is captured from the
 * final chunk when the endpoint honours `stream_options.include_usage`.
 */
export interface CompletionRequest {
  baseUrl: string
  apiKey: string | null
  model: string
  messages: ChatMessage[]
  tools: ToolDefinition[]
  reasoningEffort: string | null
  fetchImpl: typeof fetch
  onText: (delta: string) => void
}

export interface CompletionResponse {
  text: string
  toolCalls: ToolCall[]
  usage: Usage | null
  finishReason: string | null
}

export class EndpointError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly body: string,
  ) {
    super(message)
  }

  /** Context-window overflow as reported by vLLM / llama.cpp / Ollama / OpenAI. */
  get isContextLength(): boolean {
    return this.status === 400 && /context|too long|maximum context|token limit/i.test(this.body)
  }
}

export async function streamCompletion(req: CompletionRequest): Promise<CompletionResponse> {
  const url = `${req.baseUrl}/chat/completions`
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    stream: true,
    stream_options: { include_usage: true },
  }
  if (req.tools.length > 0) body.tools = req.tools
  if (req.reasoningEffort) body.reasoning_effort = req.reasoningEffort

  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream' }
  if (req.apiKey) headers.authorization = `Bearer ${req.apiKey}`

  let res: Response
  try {
    res = await req.fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'manual' })
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause
    const detail = cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err))
    throw new EndpointError(`connection to ${url} failed: ${detail}`, null, '')
  }

  if (!res.ok) {
    // 429 bodies are passed through verbatim so the desktop's classifyProviderLimit
    // can recognise the endpoint's own rate-limit wording.
    const text = await safeText(res)
    throw new EndpointError(`HTTP ${res.status} from ${url}: ${text}`, res.status, text)
  }

  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream') || !res.body) {
    const text = await safeText(res)
    throw new EndpointError(`non-SSE response from ${url} (${contentType || 'no content-type'}): ${text.slice(0, 500)}`, res.status, text)
  }

  return parseSse(res.body, req.onText)
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

interface PartialCall {
  id: string
  name: string
  arguments: string
}

async function parseSse(body: ReadableStream<Uint8Array>, onText: (delta: string) => void): Promise<CompletionResponse> {
  const decoder = new TextDecoder()
  const calls = new Map<number, PartialCall>()
  let text = ''
  let usage: Usage | null = null
  let finishReason: string | null = null
  let buffer = ''

  const handleData = (data: string): boolean => {
    const trimmed = data.trim()
    if (trimmed === '[DONE]') return true
    let chunk: Record<string, unknown>
    try {
      chunk = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      return false
    }
    const u = chunk.usage as { prompt_tokens?: number; completion_tokens?: number } | null | undefined
    if (u && typeof u === 'object') {
      usage = { input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0 }
    }
    const choice = (chunk.choices as Array<Record<string, unknown>> | undefined)?.[0]
    if (!choice) return false
    if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason
    const delta = choice.delta as
      | { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }
      | undefined
    if (!delta) return false
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      text += delta.content
      onText(delta.content)
    }
    for (const tc of delta.tool_calls ?? []) {
      const index = tc.index ?? 0
      let call = calls.get(index)
      if (!call) {
        call = { id: '', name: '', arguments: '' }
        calls.set(index, call)
      }
      if (tc.id) call.id = tc.id
      if (tc.function?.name) call.name += tc.function.name
      if (tc.function?.arguments) call.arguments += tc.function.arguments
    }
    return false
  }

  // Web ReadableStream is async-iterable on Node ≥ 18.
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    let done = false
    let nl: number
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '')
      buffer = buffer.slice(nl + 1)
      if (line.startsWith('data:')) done = handleData(line.slice(5)) || done
    }
    if (done) break
  }
  const tail = buffer.trim()
  if (tail.startsWith('data:')) handleData(tail.slice(5))

  const toolCalls: ToolCall[] = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, c]) => ({
      id: c.id || `call_${index}`,
      type: 'function' as const,
      function: { name: c.name, arguments: c.arguments },
    }))
  return { text, toolCalls, usage, finishReason }
}
