// The launch preflight (disk, provider sign-in) at the rail launch door itself.
// The dashboard and Launch all run it client-side before calling the launch
// route; a direct API launch (MCP, scripts, the companion) reached the door
// without it, so a launch on a full disk or a signed-out provider was accepted
// and failed later. The door now runs the same check: a failing chip refuses
// the launch with 409 `launch_preflight_blocked`. Unknown results (a probe that
// timed out) and warnings never block.
//
// The check is the launch-preflight module's, injected at composition
// (desktop-router) so this module does not depend on it; unset (tests, CLI)
// means no check.

import type { Response } from 'express'
import type { ProjectContext } from '../../../project-registry'
import { validateRequestedProvider } from '../../../provider-selection'
import { batchWorktreeRoot } from '../adapters/decisions/metadata'

export interface RailPreflightChip { id: string; kind: string; state: string; providerId?: string; status?: string; freeBytes?: number | null }
export type RailLaunchPreflightCheck = (input: { worktreesDir: string; providers: string[] }) => Promise<{ blocking: boolean; chips: RailPreflightChip[] }>

let check: RailLaunchPreflightCheck | null = null

/** Composition: the same probe GET /api/launch-preflight answers with (cached sign-in). */
export function setRailLaunchPreflight(next: RailLaunchPreflightCheck | null): void { check = next }

/** One plain sentence per failing chip (pure). */
export function preflightBlockDetail(chips: readonly RailPreflightChip[]): string {
  const failing = chips.filter(chip => chip.state === 'fail')
  return failing.map((chip) => {
    if (chip.kind === 'disk') return 'Less than 1 GiB is free on the disk that holds the run checkouts: free some space, then launch again.'
    if (chip.kind === 'provider' && chip.status === 'missing') return `The ${chip.providerId} CLI is not installed on this machine: install it, then launch again.`
    if (chip.kind === 'provider') return `${chip.providerId} is signed out: sign in, then launch again.`
    return `${chip.id} failed its launch check.`
  }).join(' ')
}

/**
 * Run the preflight for a launch on `provider` (undefined = the project's primary
 * provider). Answers 409 and returns false when a check fails; true otherwise.
 * A broken probe never blocks a launch.
 */
export async function admitRailLaunchPreflight(c: ProjectContext, res: Response, provider: string | undefined, opts: { localEngine?: boolean } = {}): Promise<boolean> {
  if (!check) return true
  const resolved = opts.localEngine ? null : validateRequestedProvider(c.project, provider ?? '')
  const providers = resolved?.ok ? [resolved.provider] : []
  let report
  try { report = await check({ worktreesDir: batchWorktreeRoot(c.project.slug), providers }) } catch { return true }
  if (!report.blocking) return true
  const failing = report.chips.filter(chip => chip.state === 'fail')
  res.status(409).json({ error: 'launch_preflight_blocked', detail: preflightBlockDetail(failing), chips: failing })
  return false
}
