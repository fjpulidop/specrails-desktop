/** Shared verdict syntax for loop gates and review evidence. Only a verdict
 * line counts; mentions in prose/tool invocations do not prove verification. */
export type SentinelVerdict = 'pass' | 'fail' | 'absent'

const SENTINEL_RE = /^[ \t]*VERIFICATION:[ \t]*(PASS|FAIL)\b[ \t]*(?:[—:-][ \t]*)?([^\r\n]*)/gim

export function parseVerificationSentinel(text: string): { verdict: SentinelVerdict; detail: string | null } {
  let verdict: SentinelVerdict = 'absent'
  let detail: string | null = null
  for (const match of text.matchAll(SENTINEL_RE)) {
    verdict = match[1].toUpperCase() === 'PASS' ? 'pass' : 'fail'
    const tail = (match[2] ?? '').trim()
    detail = verdict === 'fail' && tail ? tail.slice(0, 512) : null
  }
  return { verdict, detail }
}
