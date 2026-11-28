/** Tapflow plugin state in the app database (`desktop_settings` key `plugins.tapflow.state`). */
import type { DbInstance } from '../../../db'
import { getDesktopSetting, setDesktopSetting } from '../../../desktop-db'
import { EMPTY_TAPFLOW_STATE, type TapflowStoredState } from '../domain'
import type { TapflowStore } from '../application'

export const TAPFLOW_STATE_KEY = 'plugins.tapflow.state'

export function createTapflowStore(db: DbInstance): TapflowStore {
  return {
    read: () => {
      const raw = getDesktopSetting(db, TAPFLOW_STATE_KEY)
      if (!raw) return { ...EMPTY_TAPFLOW_STATE }
      try {
        const parsed = JSON.parse(raw) as Partial<TapflowStoredState>
        return {
          installedVersion: typeof parsed.installedVersion === 'string' ? parsed.installedVersion : null,
          nodePath: typeof parsed.nodePath === 'string' ? parsed.nodePath : null,
          active: parsed.active === true,
          port: Number.isInteger(parsed.port) && (parsed.port as number) > 1023 && (parsed.port as number) < 65536 ? parsed.port as number : EMPTY_TAPFLOW_STATE.port,
        }
      } catch {
        return { ...EMPTY_TAPFLOW_STATE }
      }
    },
    write: (state) => setDesktopSetting(db, TAPFLOW_STATE_KEY, JSON.stringify(state)),
  }
}
