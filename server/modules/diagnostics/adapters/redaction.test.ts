import os from 'os'
import { describe, expect, it } from 'vitest'
import { createDiagnosticRedactor } from './redaction'
import { buildReportFiles } from '../domain'

describe('diagnostic redactor', () => {
  const known = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
  const redact = createDiagnosticRedactor(() => [known, null, 'short'])

  it('removes the exact tokens this server holds, wherever they appear', () => {
    const out = redact(`ws protocol desktop-token.${known} and ?t=${known}`)
    expect(out).not.toContain(known)
    expect(out).toContain('[REDACTED]')
    // Short values are never replaced literally (they would mangle prose).
    expect(redact('a short word')).toBe('a short word')
  })

  it('removes provider keys, bearer tokens, PEM keys and credentials in URLs', () => {
    const samples = [
      `ANTHROPIC_API_KEY=sk-ant-api03-${'x'.repeat(40)}`,
      `token ghp_${'A'.repeat(36)}`,
      `Authorization: Bearer ${'b'.repeat(40)}`,
      'git fetch https://user:hunter2pass@github.com/acme/repo.git',
      `AWS key AKIA${'B'.repeat(16)}`,
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
      'X-Desktop-Token: abcdefabcdefabcdef',
    ]
    const leaked = ['sk-ant-api03', 'ghp_AAAA', 'bbbbbbbbbbbbbbbbbbbb', 'hunter2pass', 'AKIABBBB', 'MIIEow', 'abcdefabcdefabcdef']
    samples.forEach((sample, index) => expect(redact(sample), sample).not.toContain(leaked[index]))
  })

  it('shows paths in the home folder as ~', () => {
    const home = os.homedir()
    const out = redact(`opened ${home}/projects/acme/src/index.ts`)
    expect(out).toBe('opened ~/projects/acme/src/index.ts')
    expect(out).not.toContain(home)
  })

  it('leaves ordinary log lines readable', () => {
    expect(redact('[queue] job 12 finished in 300 ms, max_tokens=4096')).toBe('[queue] job 12 finished in 300 ms, max_tokens=4096')
  })

  it('every report file passes through it', () => {
    const home = os.homedir()
    const files = buildReportFiles({
      createdAtMs: 0,
      versions: { app: null, core: null, api: null, contractSchema: null },
      system: { platform: 'darwin', release: '1', arch: 'arm64', node: 'v22', uptimeSec: 0, rssBytes: 0, cpuCount: 1, totalMemoryBytes: 0 },
      desktopHost: true, projectCount: 0,
      settings: [{ key: 'last_project_path', value: `${home}/code/app` }],
      serverLog: `{"apiKey":"zz-plain-value","path":"${home}/x"}\n`,
      sidecarLog: `t [ERR] auth failed for ${known}\n`,
      desktopLog: '', crashes: [], stalls: { thresholdMs: 200, sampling: false, sinceMs: 0, total: 0, longestMs: 0, recent: [] },
    }, redact)
    const all = files.map(file => file.content).join('\n')
    for (const leak of [known, 'zz-plain-value', home]) expect(all).not.toContain(leak)
  })
})
