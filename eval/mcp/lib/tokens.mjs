// Token counting for response and catalog sizes: the o200k tokenizer when
// `js-tiktoken` resolves (a dev dependency of the server), else the same
// conservative estimate the server's size guard uses (~2.9 bytes per token).
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { DESKTOP_DIR } from './instance.mjs'

/** The server's estimate: bytes / 2.9, rounded up (pure). */
export function approxTokens(text) {
  return Math.ceil(Buffer.byteLength(String(text ?? '')) / 2.9)
}

let counter = null
/** `{ count(text) → number, exact: boolean }`, loaded once. */
export async function tokenCounter() {
  if (counter) return counter
  for (const base of [path.join(DESKTOP_DIR, 'server', 'package.json'), path.join(DESKTOP_DIR, 'package.json')]) {
    try {
      const require = createRequire(base)
      const mod = await import(pathToFileURL(require.resolve('js-tiktoken/lite')).href)
      const rank = (await import(pathToFileURL(require.resolve('js-tiktoken/ranks/o200k_base')).href)).default
      const enc = new mod.Tiktoken(rank)
      counter = { count: text => enc.encode(String(text ?? '')).length, exact: true }
      return counter
    } catch { /* next */ }
  }
  counter = { count: approxTokens, exact: false }
  return counter
}
