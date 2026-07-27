// Tiny cross-component git-changed signal. Surfaces that MUTATE a project's
// repo state from the client (PR-card Checkout, Integrate locally, Discard,
// Create PR) notify here; surfaces that DISPLAY git state (AgentGitBar's
// branch strip) subscribe and refetch immediately instead of waiting for the
// next turn settle. Window-event based so it needs no provider and works
// across portals/surfaces.

const GIT_CHANGED_EVENT = 'specrails:git-changed'

export function notifyGitChanged(projectId: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(GIT_CHANGED_EVENT, { detail: { projectId } }))
}

/** Subscribe to git mutations; returns the unsubscribe function. */
export function subscribeGitChanged(cb: (projectId: string) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const handler = (e: Event) => {
    const projectId = (e as CustomEvent<{ projectId?: unknown }>).detail?.projectId
    if (typeof projectId === 'string' && projectId) cb(projectId)
  }
  window.addEventListener(GIT_CHANGED_EVENT, handler)
  return () => window.removeEventListener(GIT_CHANGED_EVENT, handler)
}
