import { createInterface } from 'readline'
import { createHash } from 'crypto'
import treeKill from 'tree-kill'
import { spawnClaude } from './util/cli-prompt'

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
  opts: { name: string; description: string },
): Promise<string> {
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
        '--dangerously-skip-permissions',
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

    let collected = ''
    const killer = setTimeout(() => {
      escalateKill(child)
      reject(new Error('agent generation timed out after 90s'))
    }, 90_000)

    const reader = createInterface({ input: child.stdout!, crlfDelay: Infinity })
    reader.on('line', (line) => {
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
      clearTimeout(killer)
      reject(err)
    })

    child.on('close', (code) => {
      clearTimeout(killer)
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}${stderr ? `: ${stderr.slice(-500)}` : ''}`))
        return
      }
      const trimmed = collected.trim()
      if (!trimmed) {
        reject(new Error('claude returned empty output'))
        return
      }
      resolve(trimmed)
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
  opts: { draftBody: string; sampleTask: string; tokenCeiling?: number },
): Promise<TestAgentResult> {
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
        '--dangerously-skip-permissions',
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

    let collected = ''
    let tokensIn = 0
    let tokensOut = 0
    let truncated = false
    const killer = setTimeout(() => {
      escalateKill(child)
      reject(new Error('test agent run timed out after 120s'))
    }, 120_000)

    const reader = createInterface({ input: child.stdout!, crlfDelay: Infinity })
    reader.on('line', (line) => {
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
      // Usage in result / stop events
      const usage = (p.usage ?? message?.usage) as Record<string, unknown> | undefined
      if (usage) {
        if (typeof usage.input_tokens === 'number') tokensIn += usage.input_tokens as number
        if (typeof usage.output_tokens === 'number') tokensOut += usage.output_tokens as number
      }
      // Enforce token ceiling
      if (tokensIn + tokensOut >= tokenCeiling && !truncated) {
        truncated = true
        escalateKill(child)
      }
    })

    let stderr = ''
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    child.on('error', (err) => {
      clearTimeout(killer)
      reject(err)
    })

    child.on('close', (code) => {
      clearTimeout(killer)
      const durationMs = Date.now() - started
      if (!truncated && code !== 0 && !collected) {
        reject(new Error(`claude exited with code ${code}${stderr ? `: ${stderr.slice(-500)}` : ''}`))
        return
      }
      resolve({
        output: truncated
          ? collected + `\n\n[… output truncated after reaching ${tokenCeiling}-token ceiling]`
          : collected,
        tokens: tokensIn + tokensOut,
        durationMs,
        draftHash,
      })
    })
  })
}

