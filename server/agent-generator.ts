import { createInterface } from 'readline'
import { createHash, randomUUID } from 'crypto'
import treeKill from 'tree-kill'
import { spawnClaude } from './util/cli-prompt'
import { getAdapter, type ProviderAdapter, type AdapterEvent } from './providers'
import { finaliseInvocationResult } from './result-event'
import { recordInvocation, type InvocationStatus } from './ai-invocations'
import type { DbInstance } from './db'
import type { WsMessage } from './types'
import {
  captureProcessAdmission,
  ProcessAdmissionClosedError,
} from './process-admission'
import { trackTransientChild } from './transient-children'

/**
 * Optional recording context threaded from the caller (profiles-router Studio
 * generate/test, agent-refine-manager auto-test). When present, the custom-agent
 * generate/test spawns write an `ai_invocations` row (surface='agent-studio')
 * on EVERY terminal path — success, non-zero exit, empty output, spawn error,
 * and timeout/kill — using the pricing-table fallback for killed runs that never
 * emitted a terminal `result` event (COST-ACCOUNTING-AUDIT MED-3). When absent
 * the functions behave byte-identically to before (no DB handle required, so the
 * legacy call sites keep compiling).
 */
export interface AgentStudioRecordCtx {
  db: DbInstance
  projectId: string
  /** launch/refine/session id, stored as `surface_ref_id`. */
  surfaceRefId?: string | null
  broadcast?: (msg: WsMessage) => void
}

const AGENT_STUDIO_ADAPTER: ProviderAdapter = getAdapter('claude')

/**
 * Finalise the accumulated adapter events (native cost, or pricing-table
 * estimate when the run was killed before its `result` event) and persist one
 * surface='agent-studio' row. Best-effort — a recording failure is logged, never
 * thrown, so it can never break the generate/test flow.
 */
function recordAgentStudioInvocation(
  ctx: AgentStudioRecordCtx,
  events: readonly AdapterEvent[],
  status: InvocationStatus,
  startedAtIso: string,
): void {
  try {
    const { result, estimated } = finaliseInvocationResult(AGENT_STUDIO_ADAPTER, events, {
      fallbackModel: AGENT_STUDIO_ADAPTER.defaultModel(),
    })
    recordInvocation(ctx.db, {
      id: randomUUID(),
      project_id: ctx.projectId,
      provider: AGENT_STUDIO_ADAPTER.id,
      surface: 'agent-studio',
      surface_ref_id: ctx.surfaceRefId ?? null,
      status,
      started_at: startedAtIso,
      finished_at: new Date().toISOString(),
      total_cost_usd_estimated: estimated,
      ...result,
    })
    ctx.broadcast?.({ type: 'spending.invalidated', projectId: ctx.projectId })
  } catch (err) {
    console.error('[agent-generator] recordInvocation failed:', err)
  }
}

/**
 * Generate a draft `custom-*.md` body by spawning a one-shot claude
 * invocation with an agent-authoring system prompt. Resolves with the full
 * response text after the child process closes; rejects on non-zero exit or
 * spawn error.
 *
 * Hard cap on the child: 90 seconds wall-clock. Callers should also set a
 * timeout on their fetch/HTTP layer for safety.
 */

/**
 * Kill a child's whole subtree with SIGTERM, escalating to SIGKILL after a grace
 * window if it ignores the signal — so a hung/signal-swallowing CLI (and its
 * grandchildren) is never orphaned. Consistent with QueueManager._kill.
 */
function escalateKill(child: { pid?: number; once: (e: string, cb: () => void) => void; kill: (s: NodeJS.Signals) => boolean }): void {
  if (child.pid) {
    treeKill(child.pid, 'SIGTERM')
    const pid = child.pid
    const esc = setTimeout(() => {
      try { treeKill(pid, 'SIGKILL', () => { /* best-effort */ }) } catch { /* gone */ }
    }, 2000)
    esc.unref?.()
    child.once('close', () => clearTimeout(esc))
  } else {
    try { child.kill('SIGTERM') } catch { /* already gone */ }
  }
}

export async function generateCustomAgent(
  cwd: string,
  opts: { name: string; description: string; record?: AgentStudioRecordCtx },
): Promise<string> {
  const admission = opts.record
    ? captureProcessAdmission(opts.record.projectId)
    : captureProcessAdmission()
  const systemPrompt = [
    'You are a specrails agent-authoring assistant.',
    '',
    'Your task: given a short description of what the user wants, produce a COMPLETE',
    'Markdown file for a specrails custom agent. The file MUST be valid input for',
    'Claude Code: YAML frontmatter between `---` separators, followed by the agent body.',
    '',
    'Required frontmatter fields:',
    '  - name: the exact agent id (starts with `custom-`, lowercase, kebab-case)',
    '  - description: one sentence saying when this agent should run (include tag hints in square brackets)',
    '  - model: one of `sonnet`, `opus`, `haiku`',
    '  - color: one of `blue`, `green`, `red`, `yellow`, `purple`, `cyan`',
    '  - memory: `project`',
    '',
    'Body sections (use `#` headings): Identity, Mission, Workflow protocol, Personality.',
    'Personality block: bullet list of tone, risk_tolerance, detail_level, focus_areas.',
    '',
    'Be concise. No conversational preamble. Output ONLY the Markdown file — no code',
    'fences, no explanations. Start at `---`.',
  ].join('\n')

  const userPrompt = [
    `Generate a custom agent with id "${opts.name}".`,
    '',
    'Description of what it should do:',
    opts.description,
  ].join('\n')

  return new Promise<string>((resolve, reject) => {
    const child = spawnClaude(
      [
        // This is a pure text transformation. The non-existent sentinel is
        // intentional: an empty tool list is dropped by some Claude versions
        // and silently restores the default toolkit.
        '--tools',
        '__none__',
        '--output-format',
        'stream-json',
        '--verbose',
        '--append-system-prompt',
        systemPrompt,
        '-p',
        userPrompt,
      ],
      {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd,
      },
    )
    if (opts.record) trackTransientChild(opts.record.projectId, child)

    let collected = ''
    // Accumulate adapter events so a killed/failed generate run is still costed
    // from the per-assistant-event usage snapshots (MED-3).
    const adapterEvents: AdapterEvent[] = []
    const startedAt = new Date().toISOString()
    const record = opts.record
    let settled = false
    const settle = (status: InvocationStatus, complete: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(killer)
      if (record && admission.isCurrent()) {
        recordAgentStudioInvocation(record, adapterEvents, status, startedAt)
      }
      complete()
    }
    const killer = setTimeout(() => {
      settle('aborted', () => {
        escalateKill(child)
        reject(new Error('agent generation timed out after 90s'))
      })
    }, 90_000)

    const reader = createInterface({ input: child.stdout!, crlfDelay: Infinity })
    reader.on('line', (line) => {
      if (record) {
        const ev = AGENT_STUDIO_ADAPTER.parseStreamLine(line)
        if (ev) adapterEvents.push(ev)
      }
      let parsed: unknown
      try { parsed = JSON.parse(line) } catch { return }
      if (!parsed || typeof parsed !== 'object') return
      // Claude stream-json format: {type:"assistant", message:{content:[{type:"text", text:"..."}]}}
      const p = parsed as Record<string, unknown>
      const message = p.message as Record<string, unknown> | undefined
      const content = message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
            const text = (block as { text?: unknown }).text
            if (typeof text === 'string') collected += text
          }
        }
      }
    })

    let stderr = ''
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    child.on('error', (err) => {
      settle('failed', () => reject(admission.isCurrent()
        ? err
        : new ProcessAdmissionClosedError(opts.record?.projectId)))
    })

    child.on('close', (code) => {
      if (!admission.isCurrent()) {
        settle('aborted', () => reject(new ProcessAdmissionClosedError(opts.record?.projectId)))
        return
      }
      const trimmed = collected.trim()
      const status: InvocationStatus = code === 0 && trimmed ? 'success' : 'failed'
      settle(status, () => {
        if (code !== 0) {
          reject(new Error(`claude exited with code ${code}${stderr ? `: ${stderr.slice(-500)}` : ''}`))
          return
        }
        if (!trimmed) {
          reject(new Error('claude returned empty output'))
          return
        }
        resolve(trimmed)
      })
    })
  })
}

export interface TestAgentResult {
  output: string
  tokens: number
  durationMs: number
  draftHash: string
}

/**
 * Smoke-test a draft custom agent. Strips the frontmatter, uses the agent body
 * as a claude system prompt, and runs the sample task as the user prompt. Does
 * not touch the filesystem or register the agent anywhere — purely sandboxed.
 *
 * Returns the full assistant output plus token usage and duration for the
 * Studio's Test pane and the agent_tests table.
 *
 * Hard cap: 120 seconds wall-clock, 4000-token configurable ceiling (callers
 * can override via `tokenCeiling`).
 */
export async function testCustomAgent(
  cwd: string,
  opts: { draftBody: string; sampleTask: string; tokenCeiling?: number; record?: AgentStudioRecordCtx },
): Promise<TestAgentResult> {
  const admission = opts.record
    ? captureProcessAdmission(opts.record.projectId)
    : captureProcessAdmission()
  const tokenCeiling = opts.tokenCeiling ?? 4000
  // Strip YAML frontmatter so we feed only the agent's instructions.
  const body = opts.draftBody.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
  if (!body) {
    throw new Error('agent body is empty after stripping frontmatter')
  }
  const systemPrompt = [
    'You are acting as the agent described below. Follow its Identity, Mission,',
    'Workflow protocol, and Personality. Respond to the user task using those',
    'instructions. Do NOT preface your response; produce only the agent output.',
    '',
    '--- agent instructions ---',
    body,
    '--- end agent instructions ---',
  ].join('\n')

  const draftHash = createHash('sha256').update(opts.draftBody).digest('hex').slice(0, 16)
  const started = Date.now()

  return new Promise<TestAgentResult>((resolve, reject) => {
    const child = spawnClaude(
      [
        // A Studio smoke test evaluates the supplied instructions and returns
        // text; it never needs authority over the project it is testing in.
        '--tools',
        '__none__',
        '--output-format',
        'stream-json',
        '--verbose',
        '--append-system-prompt',
        systemPrompt,
        '-p',
        opts.sampleTask,
      ],
      {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd,
      },
    )
    if (opts.record) trackTransientChild(opts.record.projectId, child)

    let collected = ''
    // LOW-14 double-count fix: the claude stream emits `message.usage` on EVERY
    // assistant frame AND a top-level cumulative `usage` on the terminal `result`
    // frame. Summing both (the old `p.usage ?? message?.usage` accumulator)
    // roughly doubled the count and tripped the token ceiling at ~half the real
    // budget. Track them separately: the result event's cumulative usage is the
    // authoritative total when it arrives; the per-message running sum is only a
    // fallback for a run killed before its result frame — and is what the live
    // ceiling check reads until (if) the result frame lands.
    let msgTokensIn = 0
    let msgTokensOut = 0
    let resultTokensIn: number | undefined
    let resultTokensOut: number | undefined
    let truncated = false
    // Accumulate adapter events for cost recording (surface='agent-studio', MED-3).
    const adapterEvents: AdapterEvent[] = []
    const startedAt = new Date().toISOString()
    const record = opts.record
    const runningTotalTokens = (): number =>
      resultTokensIn !== undefined || resultTokensOut !== undefined
        ? (resultTokensIn ?? 0) + (resultTokensOut ?? 0)
        : msgTokensIn + msgTokensOut
    let settled = false
    const settle = (status: InvocationStatus, complete: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(killer)
      if (record && admission.isCurrent()) {
        recordAgentStudioInvocation(record, adapterEvents, status, startedAt)
      }
      complete()
    }
    const killer = setTimeout(() => {
      settle('aborted', () => {
        escalateKill(child)
        reject(new Error('test agent run timed out after 120s'))
      })
    }, 120_000)

    const reader = createInterface({ input: child.stdout!, crlfDelay: Infinity })
    reader.on('line', (line) => {
      if (record) {
        const ev = AGENT_STUDIO_ADAPTER.parseStreamLine(line)
        if (ev) adapterEvents.push(ev)
      }
      let parsed: unknown
      try { parsed = JSON.parse(line) } catch { return }
      if (!parsed || typeof parsed !== 'object') return
      const p = parsed as Record<string, unknown>
      // Text blocks
      const message = p.message as Record<string, unknown> | undefined
      const content = message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
            const text = (block as { text?: unknown }).text
            if (typeof text === 'string') collected += text
          }
        }
      }
      // Usage: the terminal `result` frame carries the cumulative total at the
      // top level; assistant frames carry a per-call `message.usage`. Route each
      // to its own accumulator so they are never double-counted.
      if (p.type === 'result') {
        const usage = p.usage as Record<string, unknown> | undefined
        if (usage) {
          if (typeof usage.input_tokens === 'number') resultTokensIn = usage.input_tokens as number
          if (typeof usage.output_tokens === 'number') resultTokensOut = usage.output_tokens as number
        }
      } else {
        const usage = message?.usage as Record<string, unknown> | undefined
        if (usage) {
          if (typeof usage.input_tokens === 'number') msgTokensIn += usage.input_tokens as number
          if (typeof usage.output_tokens === 'number') msgTokensOut += usage.output_tokens as number
        }
      }
      // Enforce token ceiling on the corrected running total.
      if (runningTotalTokens() >= tokenCeiling && !truncated) {
        truncated = true
        escalateKill(child)
      }
    })

    let stderr = ''
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    child.on('error', (err) => {
      settle('failed', () => reject(admission.isCurrent()
        ? err
        : new ProcessAdmissionClosedError(opts.record?.projectId)))
    })

    child.on('close', (code) => {
      if (!admission.isCurrent()) {
        settle('aborted', () => reject(new ProcessAdmissionClosedError(opts.record?.projectId)))
        return
      }
      const durationMs = Date.now() - started
      const failedHard = !truncated && code !== 0 && !collected
      const status: InvocationStatus = truncated ? 'aborted' : failedHard ? 'failed' : 'success'
      settle(status, () => {
        if (failedHard) {
          reject(new Error(`claude exited with code ${code}${stderr ? `: ${stderr.slice(-500)}` : ''}`))
          return
        }
        resolve({
          output: truncated
            ? collected + `\n\n[… output truncated after reaching ${tokenCeiling}-token ceiling]`
            : collected,
          tokens: runningTotalTokens(),
          durationMs,
          draftHash,
        })
      })
    })
  })
}
