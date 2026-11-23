import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { initDesktopDb } from '../../desktop-db'
import { setDesktopSetting } from '../../desktop-db'
import { AGENT_CAPABILITY_HEADER } from '../../modules/missions/runtime/agent-tier'
import { mintAgentCapability, _resetAgentCapabilitiesForTest } from '../agent-capability'
import { buildToolSpecs } from './catalog'
import { describeEffect, destructiveActions, registerTieredTool, withConfirmationFields, type McpToolContext, type McpToolSpec, type ToolHandlerExtra } from './types'
import { envelopeOf } from './__fixtures__/envelope'

vi.mock('../../auth', () => ({ loadOrGenerateToken: () => 'confirmation-test-token' }))

type Handler = (args: Record<string, unknown>, extra?: ToolHandlerExtra) => Promise<CallToolResult>
const databases: Array<ReturnType<typeof initDesktopDb>> = []
afterEach(() => { _resetAgentCapabilitiesForTest(); for (const db of databases.splice(0)) db.close() })

function setup(spec: McpToolSpec) {
  const db = initDesktopDb(':memory:')
  databases.push(db)
  const broadcast = vi.fn()
  let call!: Handler
  let config: Record<string, unknown> = {}
  const server = { registerTool: (_name: string, cfg: Record<string, unknown>, handler: Handler) => { config = cfg; call = handler } } as unknown as McpServer
  registerTieredTool(server, { desktopDb: db, broadcast } as unknown as McpToolContext, withConfirmationFields(spec))
  return { db, broadcast, call: (args: Record<string, unknown>, extra?: ToolHandlerExtra) => call(args, extra), config }
}

const facade = (handler = vi.fn(async () => ({ deleted: true }))): McpToolSpec & { handler: typeof handler } => ({
  name: 'specrails_things', title: 'Things',
  description: 'Actions: list, remove (destructive — deletes the thing and its history), edit (write).',
  tier: (args) => args.action === 'remove' ? 'destructive' : args.action === 'edit' ? 'write' : 'read',
  inputSchema: { action: z.enum(['list', 'remove', 'edit']), id: z.string().optional() },
  handler,
})

describe('destructive confirmation', () => {
  it('detects destructive actions and adds confirm/dryRun only to tools that have them', () => {
    expect(destructiveActions(facade())).toEqual(['remove'])
    expect(destructiveActions({ ...facade(), tier: 'destructive' })).toEqual(['*'])
    expect(destructiveActions({ ...facade(), tier: 'read' })).toEqual([])
    expect(destructiveActions({ ...facade(), tier: () => { throw new Error('x') } })).toEqual([])
    expect(Object.keys(withConfirmationFields(facade()).inputSchema)).toEqual(['action', 'id', 'confirm', 'dryRun'])
    const readOnly = { ...facade(), tier: 'read' as const }
    expect(withConfirmationFields(readOnly)).toBe(readOnly)
    expect(describeEffect(facade(), 'remove')).toBe('deletes the thing and its history')
    expect(describeEffect(facade(), 'missing')).toBe('Things')
    expect(describeEffect(facade(), null)).toBe('Things')
  })

  it('refuses an unconfirmed external destructive call with the exact args to resend, then executes with confirm:true', async () => {
    const tool = facade()
    const { call, broadcast } = setup(tool)
    const refused = await call({ action: 'remove', id: 't1' })
    expect(refused.isError).toBe(true)
    expect(envelopeOf(refused)).toMatchObject({
      ok: false,
      error: {
        code: 'confirmation_required', retryable: false,
        resend: { tool: 'specrails_things', args: { action: 'remove', id: 't1', confirm: true } },
        next: [{ args: { confirm: true } }, { args: { dryRun: true } }],
      },
    })
    expect(tool.handler).not.toHaveBeenCalled()
    const done = await call({ action: 'remove', id: 't1', confirm: true })
    expect(envelopeOf(done)).toMatchObject({ ok: true, data: { deleted: true } })
    // The control fields never reach the handler.
    expect(tool.handler).toHaveBeenCalledWith(expect.anything(), { action: 'remove', id: 't1' })
    expect(broadcast).toHaveBeenCalledOnce()
  })

  it('dryRun never executes, for any tier, and describes the call', async () => {
    const tool = facade()
    const { call } = setup(tool)
    const preview = await call({ action: 'remove', id: 't1', dryRun: true })
    expect(envelopeOf(preview)).toMatchObject({
      ok: true, status: 'dry_run',
      data: { tool: 'specrails_things', action: 'remove', tier: 'destructive', args: { action: 'remove', id: 't1' }, effect: 'deletes the thing and its history', wouldExecute: false, requiresConfirm: true },
      next: [{ tool: 'specrails_things', args: { action: 'remove', id: 't1', confirm: true } }],
    })
    const writePreview = await call({ action: 'edit', dryRun: true })
    expect(envelopeOf(writePreview)).toMatchObject({ ok: true, status: 'dry_run', data: { tier: 'write', requiresConfirm: false }, next: [{ args: { action: 'edit' } }] })
    expect(tool.handler).not.toHaveBeenCalled()
  })

  it('leaves non-destructive actions untouched and still refuses a disabled tier first', async () => {
    const tool = facade(vi.fn(async () => ['a']))
    const { call, db } = setup(tool)
    expect(envelopeOf(await call({ action: 'list' }))).toMatchObject({ ok: true, data: ['a'] })
    setDesktopSetting(db, 'mcp_tier_destructive', 'false')
    const refused = await call({ action: 'remove', confirm: true })
    expect(envelopeOf(refused).error).toMatchObject({ code: 'unauthorized', message: expect.stringContaining('"Destructive" permission tier') })
  })

  it('does not ask the in-app agent, whose permission ladder already governs destructive actions', async () => {
    const tool = facade()
    const { call } = setup(tool)
    const token = mintAgentCapability({ conversationId: 'mission-1', projectId: null, tierLevel: 3 })
    const result = await call({ action: 'remove', id: 't1' }, { requestInfo: { headers: { [AGENT_CAPABILITY_HEADER]: token } } })
    expect(envelopeOf(result)).toMatchObject({ ok: true, data: { deleted: true } })
  })

  it('advertises the envelope output schema on registration', () => {
    const { config } = setup(facade())
    expect(Object.keys(config.outputSchema as object)).toEqual(expect.arrayContaining(['ok', 'summary', 'data', 'next', 'error']))
  })

  it('every catalog tool with a destructive action accepts confirm/dryRun; the others do not', () => {
    for (const spec of buildToolSpecs()) {
      const destructive = destructiveActions(spec).length > 0
      expect('confirm' in spec.inputSchema, spec.name).toBe(destructive)
      expect('dryRun' in spec.inputSchema, spec.name).toBe(destructive)
    }
    const byName = new Map(buildToolSpecs().map((spec) => [spec.name, spec]))
    expect(destructiveActions(byName.get('specrails_projects')!)).toEqual(['repository_remove', 'unregister'])
    expect(destructiveActions(byName.get('specrails_missions')!)).toEqual(['abort'])
    expect(destructiveActions(byName.get('specrails_status')!)).toEqual([])
  })
})
