import type { Usage } from './types'

/**
 * Emits the claude-shaped `stream-json` subset the desktop's local adapter
 * parses (design D2). One JSON object per line on stdout; nothing else ever
 * goes to stdout. `total_cost_usd` is never emitted — the desktop prices local
 * runs from the connection's optional rates, or leaves cost NULL.
 */
export class FrameEmitter {
  constructor(private readonly out: { write(chunk: string): unknown }) {}

  private emit(frame: Record<string, unknown>): void {
    this.out.write(JSON.stringify(frame) + '\n')
  }

  init(sessionId: string, model: string): void {
    this.emit({ type: 'system', subtype: 'init', session_id: sessionId, model })
  }

  /** Incremental text delta. `messageId` is stable per API call so usage dedups by message. */
  assistantText(messageId: string, model: string, text: string, usage?: Usage): void {
    this.emit({
      type: 'assistant',
      message: {
        id: messageId,
        role: 'assistant',
        model,
        content: [{ type: 'text', text }],
        ...(usage ? { usage } : {}),
      },
    })
  }

  assistantToolUse(messageId: string, model: string, id: string, name: string, input: unknown, usage?: Usage): void {
    this.emit({
      type: 'assistant',
      message: {
        id: messageId,
        role: 'assistant',
        model,
        content: [{ type: 'tool_use', id, name, input }],
        ...(usage ? { usage } : {}),
      },
    })
  }

  /** Usage-only carrier for an API call that produced no tool calls (usage arrives after the last delta). */
  assistantUsage(messageId: string, model: string, usage: Usage): void {
    this.emit({ type: 'assistant', message: { id: messageId, role: 'assistant', model, content: [], usage } })
  }

  toolResult(toolUseId: string, content: string, isError: boolean): void {
    this.emit({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
    })
  }

  result(args: {
    sessionId: string
    isError: boolean
    numTurns: number
    durationMs: number
    usage: Usage
    result: string
    reason?: string
  }): void {
    this.emit({
      type: 'result',
      subtype: args.isError ? 'error' : 'success',
      is_error: args.isError,
      num_turns: args.numTurns,
      duration_ms: args.durationMs,
      usage: args.usage,
      session_id: args.sessionId,
      result: args.result,
      ...(args.reason ? { reason: args.reason } : {}),
    })
  }
}
