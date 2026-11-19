import { describe, it, expect, afterEach, vi } from 'vitest'
import type { Response } from 'express'
import type { ProjectContext } from '../../../project-registry'
import { admitRailLaunchPreflight, preflightBlockDetail, setRailLaunchPreflight } from './rail-launch-preflight'

const ctx = { project: { slug: 'shop', provider: 'claude', providers: ['claude'] } } as unknown as ProjectContext
function res() {
  const r = { statusCode: 200, body: undefined as unknown, status(code: number) { r.statusCode = code; return r }, json(body: unknown) { r.body = body; return r } }
  return r
}

afterEach(() => setRailLaunchPreflight(null))

describe('rail launch preflight at the launch door', () => {
  it('admits every launch when no check is wired (tests, CLI)', async () => {
    const r = res()
    expect(await admitRailLaunchPreflight(ctx, r as unknown as Response, 'claude')).toBe(true)
    expect(r.statusCode).toBe(200)
  })

  it('refuses a direct API launch on a full disk or a signed-out provider, naming the fix', async () => {
    const check = vi.fn().mockResolvedValue({ blocking: true, chips: [
      { id: 'disk', kind: 'disk', state: 'fail', freeBytes: 6_000_000 },
      { id: 'provider:claude', kind: 'provider', state: 'fail', providerId: 'claude', status: 'signed-out' },
      { id: 'github', kind: 'github', state: 'warn', status: 'signed-out' },
    ] })
    setRailLaunchPreflight(check)
    const r = res()
    expect(await admitRailLaunchPreflight(ctx, r as unknown as Response, undefined)).toBe(false)
    expect(check).toHaveBeenCalledWith({ worktreesDir: expect.stringContaining('shop'), providers: ['claude'] })
    expect(r.statusCode).toBe(409)
    expect(r.body).toMatchObject({ error: 'launch_preflight_blocked' })
    const body = r.body as { detail: string; chips: Array<{ id: string }> }
    expect(body.detail).toContain('Less than 1 GiB is free')
    expect(body.detail).toContain('claude is signed out')
    expect(body.chips.map(chip => chip.id)).toEqual(['disk', 'provider:claude'])
  })

  it('lets warnings, unknown probes and a broken check through', async () => {
    setRailLaunchPreflight(async () => ({ blocking: false, chips: [{ id: 'disk', kind: 'disk', state: 'warn' }, { id: 'provider:claude', kind: 'provider', state: 'unknown' }] }))
    expect(await admitRailLaunchPreflight(ctx, res() as unknown as Response, 'claude')).toBe(true)
    setRailLaunchPreflight(async () => { throw new Error('statfs failed') })
    expect(await admitRailLaunchPreflight(ctx, res() as unknown as Response, 'claude')).toBe(true)
  })

  it('checks no provider sign-in for a local engine', async () => {
    const check = vi.fn().mockResolvedValue({ blocking: false, chips: [] })
    setRailLaunchPreflight(check)
    await admitRailLaunchPreflight(ctx, res() as unknown as Response, 'ollama', { localEngine: true })
    expect(check).toHaveBeenCalledWith(expect.objectContaining({ providers: [] }))
  })

  it('says a missing CLI is not installed', () => {
    expect(preflightBlockDetail([{ id: 'provider:codex', kind: 'provider', state: 'fail', providerId: 'codex', status: 'missing' }])).toBe('The codex CLI is not installed on this machine: install it, then launch again.')
  })
})
