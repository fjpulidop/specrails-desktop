import { afterEach, describe, expect, it } from 'vitest'
import { getAdapter } from '../../../providers'
import type { DriverDescriptor } from '../../agent-sessions'
import { isReadOnlySessionBoundary, missionReadOnlyGap, missionSessionBoundary, missionSpawnPolicy } from './mission-tool-policy'

const driver = (id: string, toolFiltering: boolean): DriverDescriptor => ({
  id, displayName: id,
  capabilities: { resident: true, nativeInputQueue: true, subagents: 'supported', subagentDisable: true, autonomousContinuation: true, steer: true, toolFiltering, usage: { costUsd: 'per-turn', tokens: 'per-turn' } },
})

afterEach(() => { delete process.env.SPECRAILS_MISSION_READ_ONLY })

describe('missionSpawnPolicy', () => {
  it.each(['claude', 'codex', 'gemini'])('runs %s mission turns read-only with MCP tools retained', (id) => {
    expect(missionSpawnPolicy(getAdapter(id))).toEqual({ toolPolicy: 'read-only', retainMcpTools: true })
    expect(missionReadOnlyGap(getAdapter(id))).toBeNull()
  })

  it('keeps Kimi on its default tools and reports why', () => {
    expect(missionSpawnPolicy(getAdapter('kimi'))).toEqual({})
    expect(missionReadOnlyGap(getAdapter('kimi'))).toBe('unsupported')
  })

  it('is a no-op behind the kill switch', () => {
    process.env.SPECRAILS_MISSION_READ_ONLY = 'false'
    expect(missionSpawnPolicy(getAdapter('claude'))).toEqual({})
    expect(missionReadOnlyGap(getAdapter('claude'))).toBe('disabled')
  })
})

describe('missionSessionBoundary', () => {
  it('maps Claude to bypass permissions plus the read-only tool set', () => {
    const boundary = missionSessionBoundary(getAdapter('claude'), driver('claude', true))
    expect(boundary).toEqual({ permissions: 'bypass', tools: { mode: 'read-only' } })
    expect(isReadOnlySessionBoundary(boundary)).toBe(true)
  })

  it('maps Codex to the read-only sandbox without a tool filter', () => {
    const boundary = missionSessionBoundary(getAdapter('codex'), driver('codex', false))
    expect(boundary).toEqual({ permissions: 'read-only' })
    expect(isReadOnlySessionBoundary(boundary)).toBe(true)
  })

  it('never asks a driver without tool filtering for a tool restriction', () => {
    expect(missionSessionBoundary(getAdapter('claude'), driver('claude', false))).toEqual({ permissions: 'bypass' })
    expect(missionSessionBoundary(getAdapter('claude'), undefined)).toEqual({ permissions: 'bypass' })
  })

  it('keeps the legacy mapping for providers without a verified read-only session', () => {
    const boundary = missionSessionBoundary(getAdapter('gemini'), driver('gemini', false))
    expect(boundary).toEqual({ permissions: 'workspace-write' })
    expect(isReadOnlySessionBoundary(boundary)).toBe(false)
  })

  it('restores the legacy session policy behind the kill switch', () => {
    process.env.SPECRAILS_MISSION_READ_ONLY = 'false'
    expect(missionSessionBoundary(getAdapter('codex'), driver('codex', false))).toEqual({ permissions: 'workspace-write' })
  })
})
