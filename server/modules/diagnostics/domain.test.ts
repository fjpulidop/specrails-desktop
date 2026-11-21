import { describe, expect, it } from 'vitest'
import {
  appendStall,
  buildReportFiles,
  isSecretKey,
  nextAcknowledgement,
  operationLabel,
  parseCrashMarker,
  redactQuotedSecretFields,
  redactSettings,
  reportFileName,
  sidecarStderrLines,
  tailText,
  unacknowledgedCrashes,
  type CrashMarker,
  type ReportSources,
} from './domain'

const marker = (atMs: number, extra: Partial<CrashMarker> = {}): CrashMarker => ({
  version: 1, id: `${atMs}-42`, atMs, at: new Date(atMs).toISOString(), pid: 42, exitCode: 1, signal: null, uptimeMs: 1000,
  wasReady: true, outcome: 'restarted', recentRestarts: 1, maxRestarts: 3, windowSecs: 60, stderrTail: ['boom'], ...extra,
})

describe('crash markers', () => {
  it('accepts the host schema and rejects anything malformed', () => {
    const raw = { ...marker(1_700_000_000_000), stderrTail: ['a', 3, 'b'] }
    expect(parseCrashMarker(raw)).toMatchObject({ id: '1700000000000-42', outcome: 'restarted', stderrTail: ['a', 'b'] })
    for (const bad of [null, [], 'x', { ...raw, id: '../etc' }, { ...raw, outcome: 'maybe' }, { ...raw, atMs: 'soon' }, { ...raw, pid: undefined }]) {
      expect(parseCrashMarker(bad)).toBeNull()
    }
  })

  it('lists only crashes after the acknowledgement, oldest first, without stderr', () => {
    const notices = unacknowledgedCrashes([marker(30), marker(10), marker(20)], 10)
    expect(notices.map(n => n.atMs)).toEqual([20, 30])
    expect(notices[0]).not.toHaveProperty('stderrTail')
  })

  it('acknowledgements only move forward and never past the newest marker', () => {
    const markers = [marker(10), marker(20)]
    expect(nextAcknowledgement(0, 20, markers)).toBe(20)
    expect(nextAcknowledgement(20, 5, markers)).toBe(20)
    expect(nextAcknowledgement(0, 9_999_999, markers)).toBe(20)
    expect(nextAcknowledgement(5, 'later', markers)).toBe(5)
  })
})

describe('stalls and operations', () => {
  it('keeps the newest stalls only', () => {
    let stalls = [] as ReturnType<typeof appendStall>
    for (let i = 0; i < 5; i++) stalls = appendStall(stalls, { atMs: i, durationMs: 300, operation: null, utilization: 1 }, 3)
    expect(stalls.map(s => s.atMs)).toEqual([2, 3, 4])
  })

  it('labels requests without ids, tokens or query strings', () => {
    expect(operationLabel('get', '/api/projects/0b7c1f9e-1d2a-4c3b-9a8b-112233445566/jobs/123?token=abc')).toBe('GET /api/projects/:id/jobs/:id')
    expect(operationLabel('POST', '/api/projects/my-app/tickets')).toBe('POST /api/projects/my-app/tickets')
    expect(operationLabel('GET', '/api/x/' + 'a'.repeat(40))).toBe('GET /api/x/:id')
  })
})

describe('redaction helpers', () => {
  it('recognises secret-named keys but keeps counters readable', () => {
    for (const key of ['apiKey', 'github_token', 'password', 'clientSecret', 'env', 'headers', 'Authorization', 'webhook_url']) expect(isSecretKey(key), key).toBe(true)
    for (const key of ['max_tokens', 'tokensIn', 'theme', 'author', 'ui_language']) expect(isSecretKey(key), key).toBe(false)
  })

  it('redacts quoted secret fields inside JSON log lines', () => {
    expect(redactQuotedSecretFields('{"apiKey":"abc","model":"x","github_token": "ghp_1"}')).toBe('{"apiKey":"[REDACTED]","model":"x","github_token": "[REDACTED]"}')
  })

  it('removes nested secrets from settings and redacts other strings', () => {
    const settings = redactSettings([
      { key: 'external_mcp', value: JSON.stringify({ servers: [{ name: 'gh', env: { GITHUB_TOKEN: 'x' }, headers: { Authorization: 'y' }, url: 'https://x' }] }) },
      { key: 'ui_theme', value: 'dracula' },
      { key: 'jira_api_token', value: 'secret-value' },
    ], text => text.replace('https://x', '[url]'))
    expect(settings).toEqual({
      external_mcp: { servers: [{ name: 'gh', env: '[REDACTED]', headers: '[REDACTED]', url: '[url]' }] },
      jira_api_token: '[REDACTED]',
      ui_theme: 'dracula',
    })
  })

  it('tails at a line boundary and keeps only error lines of the sidecar log', () => {
    expect(tailText('one\ntwo\nthree', 8)).toBe('three')
    expect(sidecarStderrLines('t [OUT] hello\nt [ERR] bad\nt [EXIT] code=Some(1)\nt [HOST] ready')).toBe('t [ERR] bad\nt [EXIT] code=Some(1)\nt [HOST] ready')
  })
})

describe('report files', () => {
  const sources: ReportSources = {
    createdAtMs: Date.UTC(2026, 10, 18, 9, 30, 5),
    versions: { app: '3.5.0', core: '4.1.0', api: 3, contractSchema: '1' },
    system: { platform: 'darwin', release: '25', arch: 'arm64', node: 'v22', uptimeSec: 10, rssBytes: 1, cpuCount: 8, totalMemoryBytes: 2 },
    desktopHost: true,
    projectCount: 2,
    settings: [{ key: 'ui_language', value: 'es' }],
    serverLog: 'started SECRET\n',
    sidecarLog: 'a [OUT] noise\nb [ERR] failed SECRET\n',
    desktopLog: 'c [sidecar] started pid 1\n',
    crashes: [marker(5, { stderrTail: ['oops SECRET'] })],
    stalls: { thresholdMs: 200, sampling: false, sinceMs: 0, total: 0, longestMs: 0, recent: [] },
  }
  const redact = (text: string) => text.split('SECRET').join('[REDACTED]')

  it('contains exactly the documented files, every one redacted', () => {
    const files = buildReportFiles(sources, redact)
    expect(files.map(f => f.name)).toEqual(['README.txt', 'system.json', 'settings.json', 'server.log', 'sidecar-stderr.log', 'desktop.log', 'crashes.json', 'stalls.json'])
    for (const file of files) {
      expect(file.content, file.name).not.toContain('SECRET')
      expect(file.description.length).toBeGreaterThan(10)
    }
    expect(files.find(f => f.name === 'sidecar-stderr.log')?.content).toBe('b [ERR] failed [REDACTED]')
    expect(JSON.parse(files.find(f => f.name === 'system.json')!.content)).toMatchObject({ versions: { app: '3.5.0', core: '4.1.0' }, projectCount: 2 })
    const readme = files[0].content
    expect(readme).toContain('was not sent anywhere')
    for (const file of files.slice(1)) expect(readme).toContain(file.name)
  })

  it('omits host files outside the desktop app', () => {
    const names = buildReportFiles({ ...sources, desktopHost: false, sidecarLog: null, desktopLog: null }, redact).map(f => f.name)
    expect(names).not.toContain('sidecar-stderr.log')
    expect(names).not.toContain('desktop.log')
  })

  it('names the archive after its creation time', () => {
    expect(reportFileName(sources.createdAtMs)).toBe('specrails-report-20261118-093005.zip')
  })
})
