/**
 * Shared types for the local agent runner.
 *
 * The runner speaks OpenAI chat-completions to the endpoint and claude-shaped
 * `stream-json` to its parent (Specrails Desktop). Both dialects are modelled
 * here so the loop (`runner.ts`) stays free of ad-hoc shapes.
 */

export type ToolPolicy =
  | { kind: 'none' }
  | { kind: 'allow'; names: string[] }
  | { kind: 'disallow'; names: string[] }
  | { kind: 'default' }

export interface RunnerOptions {
  prompt: string | null
  model: string
  baseUrl: string
  apiKeyEnv: string | null
  resume: string | null
  systemPrompt: string | null
  appendSystemPrompt: string | null
  toolPolicy: ToolPolicy
  maxTurns: number | null
  mcpConfig: string | null
  addDirs: string[]
  outputFormat: 'stream-json'
  inputFormat: 'text' | 'stream-json'
  reasoningEffort: string | null
}

/** OpenAI chat-completions message shapes (the subset the runner produces). */
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface Usage {
  input_tokens: number
  output_tokens: number
}

/** A tool the loop can execute: built-in or MCP-backed. */
export interface RunnableTool {
  definition: ToolDefinition
  run: (input: Record<string, unknown>) => Promise<ToolOutcome>
}

export interface ToolOutcome {
  content: string
  isError: boolean
}

/** Persisted session (`~/.specrails/local-runner/sessions/<id>.json`). */
export interface SessionFile {
  id: string
  model: string
  cwd: string
  createdAt: string
  updatedAt: string
  /** History WITHOUT the system message — the system prompt is rebuilt per spawn from argv. */
  messages: ChatMessage[]
}

/** Process-level I/O seam so the whole runner is testable in-process. */
export interface RunnerIo {
  stdin: NodeJS.ReadableStream
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  env: Record<string, string | undefined>
  cwd: string
  fetch?: typeof fetch
  now?: () => number
}
