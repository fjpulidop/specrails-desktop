import { formatDuration, formatTokens } from './format'



// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

export const isTTY = process.stdout.isTTY === true


export function ansi(code: string, text: string): string {
  if (!isTTY) return text
  return `\x1b[${code}m${text}\x1b[0m`
}


export const dim = (t: string) => ansi('2', t)

export const red = (t: string) => ansi('31', t)

export const bold = (t: string) => ansi('1', t)

export const dimCyan = (t: string) => ansi('2;36', t)


export function cliPrefix(): string {
  return dim('[specrails-desktop]')
}


export function cliLog(msg: string): void {
  process.stdout.write(`${cliPrefix()} ${msg}\n`)
}


export function cliError(msg: string): void {
  process.stderr.write(`${cliPrefix()} ${red(`error: ${msg}`)}\n`)
}


export function cliWarn(msg: string): void {
  process.stderr.write(`${cliPrefix()} ${dim(`warning: ${msg}`)}\n`)
}


// ---------------------------------------------------------------------------
// Summary line
// ---------------------------------------------------------------------------

export interface SummaryData {
  durationMs: number
  costUsd?: number
  totalTokens?: number
  exitCode: number
}


export function printSummary(data: SummaryData): void {
  const doneLabel = isTTY ? bold('[specrails-desktop] done') : '[specrails-desktop] done'
  const durationPart = `duration: ${formatDuration(data.durationMs)}`
  const costPart = data.costUsd != null ? `  cost: $${data.costUsd.toFixed(2)}` : ''
  const tokenPart = data.totalTokens != null ? `  tokens: ${formatTokens(data.totalTokens)}` : ''
  const exitPart = `  exit: ${data.exitCode}`

  process.stdout.write(`${doneLabel}  ${durationPart}${costPart}${tokenPart}${exitPart}\n`)
}
