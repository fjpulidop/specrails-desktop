/**
 * xterm.js and its always-on addons, loaded on demand: the first terminal a
 * project opens (or reattaches) pulls the chunk, so the app shell never ships
 * it. `loadXtermRuntime()` is idempotent; once it has resolved,
 * `getXtermRuntime()` returns the same classes synchronously.
 */
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { WebLinksAddon } from '@xterm/addon-web-links'
import type { SearchAddon } from '@xterm/addon-search'
import type { Unicode11Addon } from '@xterm/addon-unicode11'

export interface XtermRuntime {
  Terminal: typeof Terminal
  FitAddon: typeof FitAddon
  WebLinksAddon: typeof WebLinksAddon
  SearchAddon: typeof SearchAddon
  Unicode11Addon: typeof Unicode11Addon
}

let runtime: XtermRuntime | null = null
let pending: Promise<XtermRuntime> | null = null

export function loadXtermRuntime(): Promise<XtermRuntime> {
  if (runtime) return Promise.resolve(runtime)
  pending ??= Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/addon-web-links'),
    import('@xterm/addon-search'),
    import('@xterm/addon-unicode11'),
    import('@xterm/xterm/css/xterm.css'),
  ]).then(([xterm, fit, webLinks, search, unicode11]) => {
    runtime = {
      Terminal: xterm.Terminal,
      FitAddon: fit.FitAddon,
      WebLinksAddon: webLinks.WebLinksAddon,
      SearchAddon: search.SearchAddon,
      Unicode11Addon: unicode11.Unicode11Addon,
    }
    return runtime
  }).catch((error: unknown) => {
    pending = null
    throw error
  })
  return pending
}

/** The loaded runtime. Call only after `loadXtermRuntime()` has resolved. */
export function getXtermRuntime(): XtermRuntime {
  if (!runtime) throw new Error('xterm runtime not loaded')
  return runtime
}
