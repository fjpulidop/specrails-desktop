/**
 * A small, conservative POSIX-shell reader for the agent policy hook.
 *
 * It is NOT a shell: it splits a command line into simple commands, removes
 * quotes, expands only `~` / `$HOME` (everything else that would expand is
 * marked `dynamic`), records redirect targets, follows `cd` for the following
 * commands, and surfaces nested scripts (`$(…)`, backticks, `bash -c '…'`,
 * `eval …`) so the rules can read them too. Heredoc bodies are data and are
 * skipped. Pure; never throws for any input (unbalanced quotes simply end the
 * word at the end of the text).
 */

export interface ShellWord {
  /** Text after quote removal and `~`/`$HOME` expansion. */
  text: string
  /** Contains an expansion this reader does not resolve (`$X`, `$(…)`, backticks, `~user`). */
  dynamic: boolean
  /** Index of the first UNQUOTED glob character (`*`, `?`, `[`), or -1. */
  globAt: number
}

export interface SimpleCommand {
  /** Words with leading assignments and transparent wrappers (`sudo`, `env`, `command`…) removed. */
  words: ShellWord[]
  /** Redirect targets (`> f`, `2>> f`, `< f`, `&> f`). */
  redirects: ShellWord[]
  /** The working directory this command runs in (after earlier `cd`s), or null when unknown. */
  cwd: string | null
  /** Reads its operands from stdin (`xargs`): targets are unknowable. */
  viaXargs: boolean
}

export interface ShellContext {
  cwd: string
  home: string
}

const SEPARATORS = new Set([';', '&', '&&', '||', '|', '|&', '\n', '(', ')'])
const WRAPPERS = new Set(['sudo', 'doas', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'env', 'timeout', 'stdbuf', 'caffeinate'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])
const MAX_NESTING = 4

interface Token { kind: 'word'; word: ShellWord; raw: string }
interface OpToken { kind: 'op'; op: string }
interface RedirToken { kind: 'redir'; op: string }
type AnyToken = Token | OpToken | RedirToken

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r'
}

/** Read `$(...)` starting at index of `(` after `$`; returns [inner, endIndexExclusive]. */
function readParenGroup(text: string, open: number): [string, number] {
  let depth = 0
  let quote: string | null = null
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!
    if (quote) {
      if (ch === '\\' && quote === '"') { i++; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; continue }
    if (ch === '\\') { i++; continue }
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return [text.slice(open + 1, i), i + 1]
    }
  }
  return [text.slice(open + 1), text.length]
}

function readBraceVar(text: string, open: number): [string, number] {
  const close = text.indexOf('}', open)
  return close === -1 ? [text.slice(open + 1), text.length] : [text.slice(open + 1, close), close + 1]
}

interface Lexed { tokens: AnyToken[]; nested: string[] }

function lex(text: string, home: string): Lexed {
  const tokens: AnyToken[] = []
  const nested: string[] = []
  let i = 0
  let pendingHeredocs: Array<{ delim: string; strip: boolean }> = []

  const skipHeredocs = () => {
    // Called right after a newline: skip each pending heredoc body.
    for (const doc of pendingHeredocs) {
      while (i < text.length) {
        const end = text.indexOf('\n', i)
        const line = text.slice(i, end === -1 ? text.length : end)
        i = end === -1 ? text.length : end + 1
        if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.delim) break
      }
    }
    pendingHeredocs = []
  }

  while (i < text.length) {
    const ch = text[i]!
    if (isSpace(ch)) { i++; continue }
    if (ch === '\\' && text[i + 1] === '\n') { i += 2; continue }
    if (ch === '#') {
      // Comment to end of line (only at a word start).
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (ch === '\n') {
      tokens.push({ kind: 'op', op: '\n' })
      i++
      if (pendingHeredocs.length) skipHeredocs()
      continue
    }
    // Operators.
    const two = text.slice(i, i + 2)
    const three = text.slice(i, i + 3)
    if (two === '&&' || two === '||' || two === '|&') { tokens.push({ kind: 'op', op: two }); i += 2; continue }
    if (ch === ';' || ch === '|' || ch === '(' || ch === ')') { tokens.push({ kind: 'op', op: ch }); i++; continue }
    // Redirections (optionally prefixed by a fd number, handled in word path below).
    if (three === '<<<') { tokens.push({ kind: 'redir', op: '<<<' }); i += 3; continue }
    if (two === '<<') {
      i += 2
      let strip = false
      if (text[i] === '-') { strip = true; i++ }
      while (i < text.length && isSpace(text[i]!)) i++
      // Delimiter word (quotes removed).
      let delim = ''
      while (i < text.length && !isSpace(text[i]!) && text[i] !== '\n' && text[i] !== ';' && text[i] !== '|' && text[i] !== '&') {
        const c = text[i]!
        if (c !== "'" && c !== '"' && c !== '\\') delim += c
        i++
      }
      if (delim) pendingHeredocs.push({ delim, strip })
      continue
    }
    if (two === '&>' || two === '>>' || two === '>|' || two === '>&' || two === '<&' || two === '<>') {
      tokens.push({ kind: 'redir', op: two }); i += 2
      if (text[i] === '>') i++ // &>>
      continue
    }
    if (ch === '>' || ch === '<') { tokens.push({ kind: 'redir', op: ch }); i++; continue }
    if (ch === '&') { tokens.push({ kind: 'op', op: '&' }); i++; continue }

    // A word.
    let out = ''
    let raw = ''
    let dynamic = false
    let globAt = -1
    let first = true
    const start = i
    while (i < text.length) {
      const c = text[i]!
      if (isSpace(c) || c === '\n' || c === ';' || c === '|' || c === '&' || c === '(' || c === ')' || c === '<' || c === '>') {
        // `2>` / `2>>`: a fd prefix belongs to the redirect, not a word.
        break
      }
      if (first && c === '~') {
        const rest = text.slice(i + 1)
        const m = /^[A-Za-z0-9_.-]*/.exec(rest)
        const user = m ? m[0] : ''
        if (user === '') { out += home; i++; first = false; continue }
        dynamic = true
      }
      first = false
      if (c === '\\') { out += text[i + 1] ?? ''; i += 2; continue }
      if (c === "'") {
        const close = text.indexOf("'", i + 1)
        out += close === -1 ? text.slice(i + 1) : text.slice(i + 1, close)
        i = close === -1 ? text.length : close + 1
        continue
      }
      if (c === '"') {
        i++
        while (i < text.length && text[i] !== '"') {
          const d = text[i]!
          if (d === '\\' && i + 1 < text.length && '"\\$`\n'.includes(text[i + 1]!)) { out += text[i + 1]; i += 2; continue }
          if (d === '$') {
            const r = readDollar(text, i, home, nested)
            out += r.text; dynamic = dynamic || r.dynamic; i = r.end; continue
          }
          if (d === '`') {
            const close = text.indexOf('`', i + 1)
            nested.push(close === -1 ? text.slice(i + 1) : text.slice(i + 1, close))
            dynamic = true
            out += '`'
            i = close === -1 ? text.length : close + 1
            continue
          }
          out += d; i++
        }
        i++ // closing quote
        continue
      }
      if (c === '$') {
        const r = readDollar(text, i, home, nested)
        out += r.text; dynamic = dynamic || r.dynamic; i = r.end; continue
      }
      if (c === '`') {
        const close = text.indexOf('`', i + 1)
        nested.push(close === -1 ? text.slice(i + 1) : text.slice(i + 1, close))
        dynamic = true
        out += '`'
        i = close === -1 ? text.length : close + 1
        continue
      }
      if ((c === '*' || c === '?' || c === '[') && globAt === -1) globAt = out.length
      out += c
      i++
    }
    raw = text.slice(start, i)
    // A bare fd number followed by a redirect (`2>`) is part of the redirect.
    if (/^\d+$/.test(raw) && (text[i] === '>' || text[i] === '<')) continue
    tokens.push({ kind: 'word', word: { text: out, dynamic, globAt }, raw })
  }
  return { tokens, nested }
}

function readDollar(text: string, at: number, home: string, nested: string[]): { text: string; dynamic: boolean; end: number } {
  const next = text[at + 1]
  if (next === '(') {
    if (text[at + 2] === '(') {
      // Arithmetic $(( … )): a number, never a path we care about.
      const [, end] = readParenGroup(text, at + 1)
      return { text: '0', dynamic: true, end }
    }
    const [inner, end] = readParenGroup(text, at + 1)
    nested.push(inner)
    return { text: '$()', dynamic: true, end }
  }
  if (next === '{') {
    const [name, end] = readBraceVar(text, at + 1)
    if (name === 'HOME') return { text: home, dynamic: false, end }
    return { text: `\${${name}}`, dynamic: true, end }
  }
  const m = /^[A-Za-z_][A-Za-z0-9_]*|^[0-9@*#?$!-]/.exec(text.slice(at + 1))
  if (!m) return { text: '$', dynamic: false, end: at + 1 }
  if (m[0] === 'HOME') return { text: home, dynamic: false, end: at + 1 + m[0].length }
  return { text: `$${m[0]}`, dynamic: true, end: at + 1 + m[0].length }
}

export function joinPath(base: string, rel: string): string {
  const absolute = rel.startsWith('/')
  const parts = (absolute ? rel : `${base}/${rel}`).split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') { out.pop(); continue }
    out.push(part)
  }
  return `/${out.join('/')}`
}

/** Strip assignments and transparent wrappers; detect xargs. */
function normalise(words: ShellWord[]): { words: ShellWord[]; viaXargs: boolean } {
  let rest = words
  let viaXargs = false
  for (let guard = 0; guard < 16 && rest.length > 0; guard++) {
    const head = rest[0]!.text
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) { rest = rest.slice(1); continue }
    const base = head.split('/').pop() ?? head
    if (base === 'xargs') {
      viaXargs = true
      let j = 1
      while (j < rest.length && rest[j]!.text.startsWith('-')) {
        // Options with a separate value.
        if (['-n', '-I', '-L', '-P', '-s', '-E', '-d', '-a'].includes(rest[j]!.text)) j++
        j++
      }
      rest = rest.slice(j)
      continue
    }
    if (WRAPPERS.has(base)) {
      let j = 1
      if (base === 'timeout') {
        while (j < rest.length && rest[j]!.text.startsWith('-')) j++
        j++ // duration
      } else {
        while (j < rest.length) {
          const t = rest[j]!.text
          if (base === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { j++; continue }
          if (!t.startsWith('-')) break
          if ((base === 'sudo' || base === 'doas') && ['-u', '-g', '-C', '-D', '-h', '-p', '-U'].includes(t)) j++
          if (base === 'nice' && t === '-n') j++
          j++
        }
      }
      rest = rest.slice(j)
      continue
    }
    break
  }
  if (rest.length > 0) {
    const head = rest[0]!
    const base = head.text.split('/').pop() ?? head.text
    if (base !== head.text) rest = [{ ...head, text: base }, ...rest.slice(1)]
  }
  return { words: rest, viaXargs }
}

/**
 * Read a script into simple commands, recursively including nested scripts.
 * `cd` (and `pushd`) with a resolvable target changes the cwd of the commands
 * that follow it; an unresolvable `cd` makes the cwd unknown (null).
 */
export function readScript(script: string, ctx: ShellContext, depth = 0): SimpleCommand[] {
  if (depth > MAX_NESTING) return []
  const { tokens, nested } = lex(script, ctx.home)
  const commands: SimpleCommand[] = []
  let cwd: string | null = ctx.cwd
  let words: ShellWord[] = []
  let redirects: ShellWord[] = []
  let pendingRedirect = false

  const flush = () => {
    if (words.length === 0 && redirects.length === 0) return
    const norm = normalise(words.filter((w) => w.text !== '{' && w.text !== '}' && w.text !== '!'))
    const command: SimpleCommand = { words: norm.words, redirects, cwd, viaXargs: norm.viaXargs }
    commands.push(command)
    const head = norm.words[0]?.text
    if (head === 'cd' || head === 'pushd') {
      const target = norm.words.find((w, idx) => idx > 0 && !w.text.startsWith('-'))
      if (!target) cwd = ctx.home
      else if (target.dynamic || target.globAt !== -1 || cwd === null) cwd = null
      else cwd = joinPath(cwd, target.text)
    }
    // Nested scripts handed to a shell or eval.
    if (head && (SHELLS.has(head) || head === 'eval')) {
      let inner: string | null = null
      if (head === 'eval') inner = norm.words.slice(1).map((w) => w.text).join(' ')
      else {
        const flagIndex = norm.words.findIndex((w, idx) => idx > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w.text))
        if (flagIndex !== -1 && norm.words[flagIndex + 1]) inner = norm.words[flagIndex + 1]!.text
      }
      if (inner) commands.push(...readNested(inner, cwd, ctx, depth))
    }
    words = []
    redirects = []
  }

  for (const token of tokens) {
    if (token.kind === 'op') {
      pendingRedirect = false
      if (SEPARATORS.has(token.op)) flush()
      continue
    }
    if (token.kind === 'redir') { pendingRedirect = true; continue }
    if (pendingRedirect) {
      pendingRedirect = false
      // `>&1`, `<&-`: a descriptor, not a path.
      if (!/^\d+$|^-$/.test(token.word.text)) redirects.push(token.word)
      continue
    }
    words.push(token.word)
  }
  flush()
  for (const inner of nested) commands.push(...readNested(inner, ctx.cwd, ctx, depth))
  return commands
}

/** A nested script runs where its parent was; an unknown parent cwd stays unknown. */
function readNested(inner: string, cwd: string | null, ctx: ShellContext, depth: number): SimpleCommand[] {
  const nested = readScript(inner, { cwd: cwd ?? ctx.cwd, home: ctx.home }, depth + 1)
  return cwd === null ? nested.map((command) => ({ ...command, cwd: null })) : nested
}
