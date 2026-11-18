/**
 * Launch preflight: what can make a batch of rails fail right after launch,
 * checked in one glance before "Launch all". Pure: thresholds and chip
 * derivation only; probes live in the runtime.
 */

export const GIB = 1024 ** 3
/** Below this a worktree checkout or dependency install is likely to fail: launching is blocked. */
export const DISK_FAIL_BYTES = 1 * GIB
/** Below this a batch of worktrees can run out: launching is allowed with a warning. */
export const DISK_WARN_BYTES = 5 * GIB

export type ChipState = 'ok' | 'warn' | 'fail' | 'unknown'
export type SignInStatus = 'signed-in' | 'signed-out' | 'missing' | 'unknown'

export type PreflightChip =
  | { id: 'disk'; kind: 'disk'; state: ChipState; freeBytes: number | null }
  | { id: string; kind: 'provider'; state: ChipState; providerId: string; status: SignInStatus }
  | { id: 'github'; kind: 'github'; state: ChipState; status: SignInStatus }
  | { id: string; kind: 'quota'; state: ChipState; providerId: string; level: string; usedPercent: number | null; rejectedUntil: string | null }

export interface PreflightReport {
  chips: PreflightChip[]
  /** A failing chip blocks the launch (the person must fix it first). */
  blocking: boolean
  checkedAt: string
}

export function diskChip(freeBytes: number | null): PreflightChip {
  const state: ChipState = freeBytes === null ? 'unknown' : freeBytes < DISK_FAIL_BYTES ? 'fail' : freeBytes < DISK_WARN_BYTES ? 'warn' : 'ok'
  return { id: 'disk', kind: 'disk', state, freeBytes }
}

export function providerChip(providerId: string, status: SignInStatus): PreflightChip {
  // A missing CLI or a signed-out account cannot run a single step.
  const state: ChipState = status === 'signed-in' ? 'ok' : status === 'unknown' ? 'unknown' : 'fail'
  return { id: `provider:${providerId}`, kind: 'provider', state, providerId, status }
}

export function githubChip(status: SignInStatus): PreflightChip {
  // Rails still run without GitHub; only pull requests need it.
  const state: ChipState = status === 'signed-in' ? 'ok' : status === 'unknown' ? 'unknown' : 'warn'
  return { id: 'github', kind: 'github', state, status }
}

export function quotaChip(view: { providerId: string; level: string; usedPercent: number | null; rejectedUntil: string | null }): PreflightChip {
  const state: ChipState = view.level === 'rejected' || view.level === 'critical' || view.level === 'warning' ? 'warn' : view.level === 'ok' ? 'ok' : 'unknown'
  return { id: `quota:${view.providerId}`, kind: 'quota', state, providerId: view.providerId, level: view.level, usedPercent: view.usedPercent, rejectedUntil: view.rejectedUntil }
}

export function summarize(chips: PreflightChip[], now: number): PreflightReport {
  return { chips, blocking: chips.some((chip) => chip.state === 'fail'), checkedAt: new Date(now).toISOString() }
}

/** `auth status` exit code → sign-in status (the output is never read: it can carry account details). */
export function signInFromExit(result: { code: number | null; timedOut?: boolean; missing?: boolean }): SignInStatus {
  if (result.missing) return 'missing'
  if (result.timedOut || result.code === null) return 'unknown'
  return result.code === 0 ? 'signed-in' : 'signed-out'
}
