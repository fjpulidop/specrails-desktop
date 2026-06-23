// App-wide owner of a SINGLE persistent Chromium context for "Add Spec from a
// website". Its profile (cookies, logins, localStorage) lives in ONE GLOBAL dir
// under $HOME, so the captured browser shares its session across every project —
// log in once, and any project's capture window sees those cookies.
//
// Why a shared singleton (not per-project): a persistent Chromium profile takes
// an EXCLUSIVE on-disk lock, so exactly one context may open a given userDataDir.
// Pointing every project at one global dir therefore REQUIRES a single shared
// context; each per-project BrowserCaptureManager opens its own pages in it
// (pages are isolated enough for capture, cookies are shared). The context is
// launched lazily on first use and closed once at app shutdown.

import os from 'os'
import path from 'path'
import { BrowserLaunchError, type BrowserContextHandle, type ContextLauncher, type SharedBrowserContext } from './browser-capture-types'
import { createPlaywrightLauncher } from './browser-playwright'

const DEFAULT_VIEWPORT = { width: 1280, height: 800 }

export interface SharedBrowserContextPoolOptions {
  /** Injectable for tests — defaults to the real Playwright launcher. */
  launcher?: ContextLauncher
  /** Override the global persistent-profile dir (tests). */
  profileDir?: string
  homeDir?: string
}

export class SharedBrowserContextPool implements SharedBrowserContext {
  private readonly launcher: ContextLauncher
  private readonly _profileDir: string
  private context: BrowserContextHandle | null = null
  private contextPromise: Promise<BrowserContextHandle> | null = null
  private disposed = false

  constructor(opts: SharedBrowserContextPoolOptions = {}) {
    this.launcher = opts.launcher ?? createPlaywrightLauncher()
    this._profileDir =
      opts.profileDir ?? path.join(opts.homeDir ?? os.homedir(), '.specrails', 'browser-profile')
  }

  /** The global profile dir backing the shared cookies/logins. */
  get profileDir(): string {
    return this._profileDir
  }

  /** Lazily launch (once) and return the shared context. Concurrent callers all
   *  await the same in-flight launch. */
  async acquire(): Promise<BrowserContextHandle> {
    if (this.disposed) throw new BrowserLaunchError('browser context pool disposed')
    if (this.context) return this.context
    if (this.contextPromise) return this.contextPromise
    this.contextPromise = (async () => {
      try {
        const ctx = await this.launcher({ userDataDir: this._profileDir, viewport: DEFAULT_VIEWPORT })
        this.context = ctx
        return ctx
      } catch (err) {
        this.contextPromise = null
        throw new BrowserLaunchError('failed to launch shared browser', err)
      }
    })()
    return this.contextPromise
  }

  /** Close the shared context. Called ONCE at app shutdown — never by a
   *  per-project manager. Resolves an in-flight launch first so a shutdown that
   *  races the lazy launch can't leak a headless Chromium. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    let ctx = this.context
    if (!ctx && this.contextPromise) {
      try { ctx = await this.contextPromise } catch { ctx = null }
    }
    if (ctx) {
      try { await ctx.close() } catch { /* ignore */ }
    }
    this.context = null
    this.contextPromise = null
  }
}
