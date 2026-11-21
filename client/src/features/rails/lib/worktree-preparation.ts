import { getApiBase } from '../../../lib/api'

/**
 * Prepared run checkouts for Launch all: asking while the dialog is open lets
 * the server populate up to three worktrees before the person confirms, and
 * releasing on dismiss drops them. Both are advisory and never throw.
 */
export async function prepareRunCheckouts(count: number): Promise<void> {
  try {
    await fetch(`${getApiBase()}/rails/worktree-preparation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count }),
    })
  } catch { /* advisory */ }
}

export async function releaseRunCheckouts(): Promise<void> {
  try {
    await fetch(`${getApiBase()}/rails/worktree-preparation/release`, { method: 'POST' })
  } catch { /* advisory */ }
}
