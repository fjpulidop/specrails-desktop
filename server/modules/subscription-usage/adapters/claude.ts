import { execFile } from 'node:child_process'
import { homedir, userInfo } from 'node:os'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { normalizeClaude, record } from '../domain'
import type { UsageReader } from '../ports'
import { UsageError } from './errors'
import { fingerprint, limitedJson, readAuthFile } from './local-auth'
interface ClaudeOptions {
  configDir?: string
  platform?: NodeJS.Platform
  readFile?: typeof readAuthFile
  keychain?: (service: string, signal: AbortSignal) => Promise<string | null>
  request?: typeof fetch
}
function readKeychain(service: string, signal: AbortSignal): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let account: string
    try { account = process.env.USER || process.env.USERNAME || userInfo().username } catch { account = 'claude-code-user' }
    if (!/^[a-zA-Z0-9._-]+$/.test(account)) account = 'claude-code-user'
    execFile('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w'], { timeout: 3000, maxBuffer: 1024 * 1024, signal }, (error, stdout) => {
      if (!error) resolve(stdout)
      else if ((error as NodeJS.ErrnoException & { code?: number }).code === 44) resolve(null)
      else reject(new UsageError('credentials-unreadable'))
    })
  })
}
export function createClaudeReader(options: ClaudeOptions = {}): UsageReader {
  const configured = options.configDir ?? process.env.CLAUDE_CONFIG_DIR
  const configDir = configured ?? path.join(homedir(), '.claude')
  async function credentials(signal: AbortSignal) {
    if (!path.isAbsolute(configDir)) throw new UsageError('unsupported-platform')
    let keychainFailure = false
    if ((options.platform ?? process.platform) === 'darwin') {
      const aliases = configured ? [configDir] : []
      if (configured) { try { const canonical = await realpath(configDir); if (canonical !== configDir) aliases.push(canonical) } catch { /* use the exact resolved context */ } }
      const services = configured ? aliases.map(dir => `Claude Code-credentials-${fingerprint(dir.normalize('NFC')).slice(0, 8)}`) : ['Claude Code-credentials']
      for (const service of services) {
        try { const raw = await (options.keychain ?? readKeychain)(service, signal); if (raw) return raw }
        catch { keychainFailure = true; break }
      }
    }
    const file = await (options.readFile ?? readAuthFile)(path.join(configDir, '.credentials.json'))
    if (file) return file
    if (keychainFailure) throw new UsageError('credentials-unreadable')
    return null
  }
  return {
    async context(signal) { return fingerprint(`${configDir}:${await credentials(signal) ?? 'none'}`) },
    async read(signal) {
      const raw = await credentials(signal)
      if (!raw) return { availability: 'signed-out', windows: [], plan: null, source: null }
      let data
      try { data = record(JSON.parse(raw)) } catch { throw new UsageError('credentials-unreadable') }
      const oauth = record(data.claudeAiOauth)
      if (typeof oauth.accessToken !== 'string' || !oauth.accessToken) return { availability: 'unsupported-auth', windows: [], plan: null, source: null }
      const response = await (options.request ?? fetch)('https://api.anthropic.com/api/oauth/usage', {
        headers: { Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code/2.1.0' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), redirect: 'error',
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        if (response.status === 401) throw new UsageError('signed-out')
        if (response.status === 403) throw new UsageError('permission-denied')
        if (response.status === 429) {
          const header = response.headers.get('retry-after')
          const seconds = header !== null && header.trim() !== '' ? Number(header) : NaN
          const date = header ? Date.parse(header) : NaN
          const retry = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? date - Date.now() : 60_000
          throw new UsageError('rate-limited', true, Math.max(30_000, Math.min(24 * 60 * 60_000, retry)))
        }
        throw new UsageError('provider-error', response.status >= 500)
      }
      const payload = await limitedJson(response), windows = normalizeClaude(payload)
      if (!windows.length) throw new UsageError('usage-unavailable')
      return { availability: 'available', windows, plan: null, source: 'oauth' }
    },
  }
}
