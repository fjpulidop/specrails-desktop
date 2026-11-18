import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { claudeAdapter } from '../../../providers/claude-adapter'
import { parseStreamEvents } from '../../../providers/runtime'
import type { AdapterEvent } from '../../../providers/types'
import { codexSessionsRoot, findCodexRollout, readCodexRolloutTail, readFileTail } from './codex-rollout-reader'
import { claudeProjectsRoot, encodeClaudeProjectDir, findClaudeTranscript, readClaudeTranscriptTail } from './claude-transcript-reader'
import {
  claudeContextUsage, claudeContextUsageFromTranscript, claudeContextWindow, codexContextUsageFromRollout, contextPercent, coreContextUsage, parseContextUsageSnapshot,
} from './mission-context-usage'

const NOW = new Date('2026-11-18T10:00:00.000Z')

/** Parse realistic `claude -p --output-format stream-json` lines through the real adapter. */
function claudeEvents(frames: Array<Record<string, unknown>>): AdapterEvent[] {
  return frames.flatMap((frame) => [...parseStreamEvents(claudeAdapter, JSON.stringify(frame))])
}

const init = (model = 'claude-sonnet-4-5-20250929') => ({
  type: 'system', subtype: 'init', session_id: 'sess-1', model, cwd: '/tmp/m', tools: ['Read'], permissionMode: 'default',
})
const assistant = (usage: Record<string, number>, options: { parent?: string | null; text?: string; id?: string; model?: string; tool?: boolean } = {}) => ({
  type: 'assistant',
  parent_tool_use_id: options.parent ?? null,
  session_id: 'sess-1',
  message: {
    id: options.id ?? `msg_${Math.random().toString(36).slice(2)}`,
    model: options.model ?? 'claude-sonnet-4-5-20250929',
    role: 'assistant',
    content: options.tool
      ? [{ type: 'tool_use', id: 'toolu_1', name: 'Task', input: { prompt: 'look around' } }]
      : [{ type: 'text', text: options.text ?? 'ok' }],
    usage: { output_tokens: 900, service_tier: 'standard', ...usage },
  },
})
const result = (modelUsage: Record<string, unknown>) => ({
  type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1', num_turns: 3, total_cost_usd: 0.12,
  usage: { input_tokens: 40, cache_creation_input_tokens: 9000, cache_read_input_tokens: 60_000, output_tokens: 2000 },
  modelUsage,
})
const sonnetUsage = {
  'claude-sonnet-4-5-20250929': { inputTokens: 40, outputTokens: 2000, cacheReadInputTokens: 60_000, cacheCreationInputTokens: 9000, costUSD: 0.11, contextWindow: 200_000 },
  'claude-haiku-4-5-20251001': { inputTokens: 1200, outputTokens: 80, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01, contextWindow: 200_000 },
}

describe('claudeContextUsage', () => {
  it('measures the newest root request input side, counting cache tokens once and never output', () => {
    const events = claudeEvents([
      init(),
      assistant({ input_tokens: 5, cache_creation_input_tokens: 2000, cache_read_input_tokens: 10_000 }, { id: 'm1', tool: true }),
      assistant({ input_tokens: 12, cache_creation_input_tokens: 1600, cache_read_input_tokens: 17_000 }, { id: 'm2' }),
      result(sonnetUsage),
    ])
    expect(claudeContextUsage(events, { now: NOW })).toEqual({
      provider: 'claude', model: 'claude-sonnet-4-5-20250929', usedTokens: 18_612, windowTokens: 200_000,
      percent: 9, source: 'response', measuredAt: NOW.toISOString(),
    })
  })

  it('ignores sub-agent frames even when they are newer', () => {
    const events = claudeEvents([
      init(),
      assistant({ input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 30_000 }, { tool: true }),
      assistant({ input_tokens: 4000, cache_creation_input_tokens: 90_000, cache_read_input_tokens: 0 }, { parent: 'toolu_1', model: 'claude-haiku-4-5-20251001' }),
      result(sonnetUsage),
    ])
    expect(claudeContextUsage(events, { now: NOW })?.usedTokens).toBe(30_010)
  })

  it('skips frames whose usage is all zeros', () => {
    const events = claudeEvents([
      init(),
      assistant({ input_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 50_000 }),
      assistant({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }),
      result(sonnetUsage),
    ])
    expect(claudeContextUsage(events, { now: NOW })?.usedTokens).toBe(50_103)
  })

  it('marks usage unknown after compact_boundary until the next root response', () => {
    const compact = { type: 'system', subtype: 'compact_boundary', session_id: 'sess-1', compact_metadata: { trigger: 'auto', pre_tokens: 180_000 } }
    const before = claudeEvents([init(), assistant({ input_tokens: 1, cache_read_input_tokens: 170_000 }), compact])
    expect(claudeContextUsage(before, { now: NOW })).toMatchObject({ usedTokens: null, percent: null, compacted: true })
    const after = claudeEvents([init(), assistant({ input_tokens: 1, cache_read_input_tokens: 170_000 }), compact,
      assistant({ input_tokens: 9000, cache_creation_input_tokens: 3000, cache_read_input_tokens: 0 }), result(sonnetUsage)])
    expect(claudeContextUsage(after, { now: NOW })).toMatchObject({ usedTokens: 12_000, windowTokens: 200_000, percent: 6, compacted: true })
  })

  it('uses the 1M window for a [1m] model, preferring the init model key', () => {
    const events = claudeEvents([
      init('claude-opus-4-1-20250805[1m]'),
      assistant({ input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 250_000 }, { model: 'claude-opus-4-1-20250805' }),
      result({
        'claude-opus-4-1-20250805[1m]': { inputTokens: 10, outputTokens: 1, contextWindow: 1_000_000 },
        'claude-haiku-4-5-20251001': { inputTokens: 1, outputTokens: 1, contextWindow: 200_000 },
      }),
    ])
    expect(claudeContextUsage(events, { now: NOW })).toMatchObject({ model: 'claude-opus-4-1-20250805[1m]', windowTokens: 1_000_000, percent: 25 })
    // `[1m]` alone implies the window even when the result does not report one.
    const noWindow = claudeEvents([init('opus[1m]'), assistant({ input_tokens: 100, cache_read_input_tokens: 99_900 })])
    expect(claudeContextUsage(noWindow, { now: NOW })).toMatchObject({ windowTokens: 1_000_000, percent: 10 })
  })

  it('keeps window null (no guessing) when no contextWindow was reported', () => {
    const events = claudeEvents([init(), assistant({ input_tokens: 10, cache_read_input_tokens: 5000 }), result({ 'claude-sonnet-4-5-20250929': { inputTokens: 10 } })])
    expect(claudeContextUsage(events, { now: NOW })).toMatchObject({ usedTokens: 5010, windowTokens: null, percent: null })
  })

  it('returns null when the turn carried no usage (e.g. a Core session turn)', () => {
    expect(claudeContextUsage([{ kind: 'session-started', sessionId: 's' }, { kind: 'text-delta', text: 'hi' }], { now: NOW })).toBeNull()
  })

  it('does not clamp the percentage', () => {
    const events = claudeEvents([init(), assistant({ input_tokens: 10, cache_read_input_tokens: 209_990 }), result(sonnetUsage)])
    expect(claudeContextUsage(events, { now: NOW })?.percent).toBe(105)
  })
})

describe('claudeContextWindow', () => {
  it('falls back to the assistant model, then the largest entry', () => {
    const usage = { a: { contextWindow: 200_000 }, b: { contextWindow: 400_000 } }
    expect(claudeContextWindow(usage, { initModel: 'missing', assistantModel: 'a' })).toEqual({ model: 'a', window: 200_000 })
    expect(claudeContextWindow(usage, {})).toEqual({ model: 'b', window: 400_000 })
    expect(claudeContextWindow(undefined, {})).toBeNull()
  })
})

const tokenCount = (total: number, window: number) => JSON.stringify({
  timestamp: '2026-11-18T09:59:00.000Z', type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: total * 3, cached_input_tokens: total * 2, output_tokens: 3000, reasoning_output_tokens: 900, total_tokens: total * 3 + 3000 },
      last_token_usage: { input_tokens: total - 500, cached_input_tokens: total - 4000, output_tokens: 500, reasoning_output_tokens: 120, total_tokens: total },
      model_context_window: window,
    },
    rate_limits: { primary: { used_percent: 12 } },
  },
})
const rollout = [
  JSON.stringify({ timestamp: '2026-11-18T09:50:00.000Z', type: 'session_meta', payload: { id: '0199a213-81c0-7800-8aa1-bbab2a035a53', cwd: '/tmp/m' } }),
  JSON.stringify({ timestamp: '2026-11-18T09:50:01.000Z', type: 'turn_context', payload: { cwd: '/tmp/m', model: 'gpt-5-codex', effort: 'medium' } }),
  tokenCount(21_000, 272_000),
  JSON.stringify({ timestamp: '2026-11-18T09:58:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: {} } }),
  tokenCount(64_000, 272_000),
  JSON.stringify({ timestamp: '2026-11-18T09:59:30.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'done' } }),
].join('\n')

describe('codexContextUsageFromRollout', () => {
  it('picks the last token_count with both values', () => {
    expect(codexContextUsageFromRollout(rollout, { now: NOW })).toEqual({
      provider: 'codex', model: 'gpt-5-codex', usedTokens: 64_000, windowTokens: 272_000, percent: 24,
      source: 'session-file', measuredAt: NOW.toISOString(),
    })
  })

  it('ignores a partial first line from a cut tail and returns null without token_count', () => {
    expect(codexContextUsageFromRollout(`_tokens":12}}\n${tokenCount(1000, 10_000)}`, { now: NOW })?.percent).toBe(10)
    expect(codexContextUsageFromRollout(rollout.split('\n').slice(0, 2).join('\n'), { now: NOW })).toBeNull()
    expect(codexContextUsageFromRollout('', { now: NOW })).toBeNull()
  })
})

describe('codex rollout reader', () => {
  let root: string | null = null
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = null })

  it('finds the rollout by session id suffix and reads only the tail', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rollouts-'))
    const id = '0199a213-81c0-7800-8aa1-bbab2a035a53'
    const day = path.join(root, '2026', '11', '18')
    fs.mkdirSync(day, { recursive: true })
    fs.mkdirSync(path.join(root, '2026', '11', '17'), { recursive: true })
    fs.writeFileSync(path.join(root, '2026', '11', '17', 'rollout-2026-11-17T08-00-00-other-id-0000.jsonl'), '{}\n')
    const file = path.join(day, `rollout-2026-11-18T09-50-00-${id}.jsonl`)
    fs.writeFileSync(file, `${'x'.repeat(300 * 1024)}\n${rollout}\n`)
    expect(await findCodexRollout(id, root)).toBe(file)
    const tail = await readCodexRolloutTail(id, root)
    expect(tail!.length).toBeLessThanOrEqual(256 * 1024)
    expect(codexContextUsageFromRollout(tail!, { now: NOW })?.usedTokens).toBe(64_000)
    expect(await readFileTail(path.join(root, 'nope.jsonl'))).toBeNull()
  })

  it('returns null for a missing file or a non-id session string', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rollouts-'))
    expect(await readCodexRolloutTail('0199a213-0000-0000-0000-000000000000', root)).toBeNull()
    expect(await findCodexRollout('../../etc/passwd', root)).toBeNull()
  })

  it('respects CODEX_HOME', () => {
    expect(codexSessionsRoot({ CODEX_HOME: '/custom/codex' })).toBe(path.join('/custom/codex', 'sessions'))
    expect(codexSessionsRoot({})).toBe(path.join(os.homedir(), '.codex', 'sessions'))
  })
})

describe('snapshot helpers', () => {
  it('computes percent and parses stored snapshots defensively', () => {
    expect(contextPercent(18_600, 200_000)).toBe(9)
    expect(contextPercent(null, 200_000)).toBeNull()
    expect(contextPercent(10, 0)).toBeNull()
    expect(parseContextUsageSnapshot(null)).toBeNull()
    expect(parseContextUsageSnapshot('not json')).toBeNull()
    expect(parseContextUsageSnapshot('{"provider":"claude","source":"guess"}')).toBeNull()
    expect(parseContextUsageSnapshot(JSON.stringify({ provider: 'codex', model: 'gpt-5', usedTokens: 50, windowTokens: 100, source: 'session-file', measuredAt: 'x' })))
      .toEqual({ provider: 'codex', model: 'gpt-5', usedTokens: 50, windowTokens: 100, percent: 50, source: 'session-file', measuredAt: 'x' })
  })
})

// Realistic Claude Code transcript lines (~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl).
const SID = '5c2f0a4e-9d1b-4c3e-8f7a-2b6d1e0c9a11'
const transcriptLine = (entry: Record<string, unknown>) => JSON.stringify({
  parentUuid: 'p', isSidechain: false, userType: 'external', cwd: '/Users/me/.specrails/agent/m1', sessionId: SID,
  version: '2.1.260', uuid: Math.random().toString(36).slice(2), timestamp: '2026-11-18T09:59:00.000Z', ...entry,
})
const transcriptAssistant = (usage: Record<string, number>, extra: Record<string, unknown> = {}) => transcriptLine({
  type: 'assistant',
  message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5-20250929', content: [{ type: 'text', text: 'ok' }],
    usage: { output_tokens: 400, service_tier: 'standard', ...usage } },
  ...extra,
})
const transcript = [
  transcriptLine({ type: 'user', message: { role: 'user', content: 'hi' } }),
  transcriptAssistant({ input_tokens: 3, cache_creation_input_tokens: 4000, cache_read_input_tokens: 20_000 }),
  transcriptAssistant({ input_tokens: 9000, cache_creation_input_tokens: 0, cache_read_input_tokens: 80_000 }, { isSidechain: true }),
  transcriptAssistant({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, { message: { model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } } }),
].join('\n')

describe('claudeContextUsageFromTranscript', () => {
  it('uses the newest root assistant usage, ignoring sidechains and zero usage', () => {
    expect(claudeContextUsageFromTranscript(transcript, { knownWindow: 200_000, now: NOW })).toEqual({
      provider: 'claude', model: 'claude-sonnet-4-5-20250929', usedTokens: 24_003, windowTokens: 200_000, percent: 12,
      source: 'session-file', measuredAt: NOW.toISOString(),
    })
  })

  it('leaves the window null without a known window, and uses 1M for a [1m] model', () => {
    expect(claudeContextUsageFromTranscript(transcript, { now: NOW })).toMatchObject({ usedTokens: 24_003, windowTokens: null, percent: null })
    expect(claudeContextUsageFromTranscript(transcript, { configuredModel: 'opus[1m]', knownWindow: 200_000, now: NOW })).toMatchObject({ windowTokens: 1_000_000, percent: 2 })
  })

  it('marks usage unknown after a newer compact_boundary line', () => {
    const compacted = `${transcript}\n${transcriptLine({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 180_000 } })}`
    expect(claudeContextUsageFromTranscript(compacted, { knownWindow: 200_000, now: NOW })).toMatchObject({ usedTokens: null, percent: null, compacted: true })
    expect(claudeContextUsageFromTranscript(`${compacted}\n${transcriptAssistant({ input_tokens: 10, cache_creation_input_tokens: 5990 })}`, { knownWindow: 200_000, now: NOW }))
      .toMatchObject({ usedTokens: 6000, percent: 3, compacted: true })
  })

  it('returns null without assistant usage', () => {
    expect(claudeContextUsageFromTranscript(transcriptLine({ type: 'user', message: { content: 'hi' } }), { now: NOW })).toBeNull()
  })
})

describe('claude transcript reader', () => {
  let root: string | null = null
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = null })

  it('encodes the cwd like Claude Code and finds the transcript there', async () => {
    expect(encodeClaudeProjectDir('/Users/me/.specrails/agent/m1')).toContain('-Users-me--specrails-agent-m1')
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-projects-'))
    const dir = path.join(root, '-Users-me--specrails-agent-m1')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, `${SID}.jsonl`), `${transcript}\n`)
    const cache = new Map<string, string>()
    const tail = await readClaudeTranscriptTail(SID, '/Users/me/.specrails/agent/m1', { root, cache })
    expect(claudeContextUsageFromTranscript(tail!, { knownWindow: 200_000, now: NOW })?.usedTokens).toBe(24_003)
    expect(cache.get(SID)).toBe(path.join(dir, `${SID}.jsonl`))
  })

  it('falls back to a bounded scan when the encoding does not match, and returns null when missing', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-projects-'))
    const dir = path.join(root, '-private-var-folders-x-m1')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, `${SID}.jsonl`), `${transcript}\n`)
    expect(await findClaudeTranscript(SID, '/var/folders/x/m1', { root })).toBe(path.join(dir, `${SID}.jsonl`))
    expect(await readClaudeTranscriptTail('5c2f0a4e-0000-0000-0000-000000000000', '/var/folders/x/m1', { root })).toBeNull()
    expect(await findClaudeTranscript('../secret', null, { root })).toBeNull()
  })

  it('respects CLAUDE_CONFIG_DIR', () => {
    expect(claudeProjectsRoot({ CLAUDE_CONFIG_DIR: '/cfg/claude' })).toBe(path.join('/cfg/claude', 'projects'))
    expect(claudeProjectsRoot({})).toBe(path.join(os.homedir(), '.claude', 'projects'))
  })
})

describe("Core's per-turn measurement", () => {
  const core = (raw: Record<string, unknown>): AdapterEvent => ({ kind: 'other', type: 'core-context-usage', raw })

  it('takes the latest Core measurement as is', () => {
    const snapshot = coreContextUsage([core({ usedTokens: 1, windowTokens: 10, model: 'a' }), core({ usedTokens: 50_000, windowTokens: 200_000, model: 'claude-sonnet' })], { provider: 'claude', now: NOW })
    expect(snapshot).toEqual({ provider: 'claude', model: 'claude-sonnet', usedTokens: 50_000, windowTokens: 200_000, percent: 25, source: 'response', measuredAt: NOW.toISOString() })
  })

  it('fills a missing window from the last one measured, then from a [1m] model, else leaves it unknown', () => {
    const used = core({ usedTokens: 30_000, windowTokens: null, model: 'claude-opus' })
    expect(coreContextUsage([used], { provider: 'claude', knownWindow: 200_000 })?.windowTokens).toBe(200_000)
    expect(coreContextUsage([core({ usedTokens: 30_000, windowTokens: null, model: 'claude-opus[1m]' })], { provider: 'claude' })?.windowTokens).toBe(1_000_000)
    expect(coreContextUsage([used], { provider: 'claude' })).toMatchObject({ windowTokens: null, percent: null })
  })

  it('keeps a compaction and ignores turns Core did not measure', () => {
    expect(coreContextUsage([core({ usedTokens: null, windowTokens: 258_400, model: 'gpt', compacted: true })], { provider: 'codex' })).toMatchObject({ usedTokens: null, compacted: true, percent: null })
    expect(coreContextUsage([{ kind: 'text-delta', text: 'hi' }], { provider: 'claude' })).toBeNull()
    expect(coreContextUsage([core({ usedTokens: -1, windowTokens: 'x' })], { provider: 'claude' })).toBeNull()
  })
})
