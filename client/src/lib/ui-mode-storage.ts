import { FEATURE_AGENT_MODE } from './feature-flags'

/**
 * The persisted Board/Mission choice. Kept outside `UiModeContext` so the shell
 * can read it at module load (to prefetch the Board chunk) without the context.
 */
export type UiMode = 'kanban' | 'agent'

const STORAGE_KEY = 'specrails-desktop:uiMode'

/** The mode this machine starts in (persisted pick, else the default). */
export function readStoredUiMode(): UiMode {
  // Flag OFF pins kanban so Kanban stays byte-identical.
  if (!FEATURE_AGENT_MODE) return 'kanban'
  try {
    // Agent Mode is the DEFAULT; an explicit user pick (either mode, persisted
    // on every switch) wins over it on the next launch.
    return localStorage.getItem(STORAGE_KEY) === 'kanban' ? 'kanban' : 'agent'
  } catch {
    return 'agent'
  }
}

export function writeStoredUiMode(m: UiMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, m)
  } catch {
    /* ignore */
  }
}
