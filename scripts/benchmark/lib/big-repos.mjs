// Large throwaway repositories and specs for long-running (soak) benchmarks:
// many modules across many files, a repository lint that enforces documented
// conventions (so a careless implementation needs correction rounds), and a
// deliberately slow integration suite (minutes per run, with steady output so
// Core's verification idle guard never mistakes it for a hang). Pure data.

const NT = "import test from 'node:test'\nimport assert from 'node:assert'\n"

/**
 * One module per row: [file stem, starting source, requirement for the long spec].
 * Each requirement is small and independent, so a spec built from N rows plans N tasks.
 */
export const MODULES = [
  ['money', 'export function add(a, b) {\n  return a + b\n}', '`src/money.js`: add `toCents(amount)` that converts a decimal amount (number or numeric string) to integer cents, rounding half away from zero; it throws `TypeError` for anything not finite.'],
  ['slug', "export function lower(s) {\n  return String(s).toLowerCase()\n}", '`src/slug.js`: add `slugify(text)` that lowercases, strips diacritics (NFD), replaces every run of non-alphanumerics with one `-` and trims leading/trailing `-`.'],
  ['dates', 'export function isLeap(y) {\n  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0\n}', '`src/dates.js`: add `daysInMonth(year, month)` (month 1–12, leap years respected) that throws `RangeError` for a month outside 1–12.'],
  ['queue', 'export function createQueue() {\n  return { items: [] }\n}', '`src/queue.js`: add `enqueue(q, x)`, `dequeue(q)` (returns `undefined` on empty) and `size(q)`; `dequeue` must be O(1) amortised (no `Array.prototype.shift`).'],
  ['lru', 'export function createCache(limit) {\n  return { limit, map: new Map() }\n}', '`src/lru.js`: add `get(cache, key)` and `set(cache, key, value)` with least-recently-used eviction once `limit` entries are stored; `get` refreshes recency.'],
  ['csv', "export function splitLines(text) {\n  return String(text).split('\\n')\n}", '`src/csv.js`: add `parseCsvLine(line)` that splits on commas but keeps commas inside double quotes and unescapes `""` to `"`.'],
  ['stats', 'export function sum(xs) {\n  return xs.reduce((a, b) => a + b, 0)\n}', '`src/stats.js`: add `mean(xs)` and `median(xs)`; both throw `RangeError` on an empty list; `median` must not mutate its input.'],
  ['retry', 'export function delays(n) {\n  return Array.from({ length: n }, (_, i) => i)\n}', '`src/retry.js`: add `backoff(attempt, { base = 100, cap = 10000 } = {})` returning `min(cap, base * 2 ** attempt)`; negative attempts throw `RangeError`.'],
  ['color', "export function isHex(s) {\n  return /^#[0-9a-f]{6}$/i.test(s)\n}", '`src/color.js`: add `hexToRgb(hex)` returning `{ r, g, b }` for `#rrggbb` and the short `#rgb` form; invalid input throws `TypeError`.'],
  ['words', "export function words(s) {\n  return String(s).split(/\\s+/).filter(Boolean)\n}", '`src/words.js`: add `titleCase(s)` that capitalises every word except the small words `a, an, the, of, and, or, in` (unless first).'],
  ['matrix', 'export function zeros(n) {\n  return Array.from({ length: n }, () => Array(n).fill(0))\n}', '`src/matrix.js`: add `transpose(m)` for rectangular matrices and `multiply(a, b)`, which throws `RangeError` when the inner dimensions differ.'],
  ['range', 'export function clamp(x, lo, hi) {\n  return Math.min(hi, Math.max(lo, x))\n}', '`src/range.js`: add `range(start, end, step = 1)` (end exclusive, negative steps allowed) that throws `RangeError` for a zero step.'],
  ['roman', 'export const NUMERALS = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 }', '`src/roman.js`: add `toRoman(n)` for 1–3999 using subtractive notation; outside that range throw `RangeError`.'],
  ['bytes', 'export const UNITS = [\'B\', \'KB\', \'MB\', \'GB\', \'TB\']', '`src/bytes.js`: add `formatBytes(n)` using 1024 steps and one decimal (`1536` → `"1.5 KB"`, `0` → `"0 B"`); negative input throws `RangeError`.'],
  ['url', "export function hasScheme(s) {\n  return /^[a-z][a-z0-9+.-]*:/i.test(s)\n}", '`src/url.js`: add `parseQuery(qs)` returning an object; repeated keys become arrays; `+` decodes to a space; a leading `?` is ignored.'],
  ['tree', 'export function node(value, children = []) {\n  return { value, children }\n}', '`src/tree.js`: add `depth(tree)` and `flatten(tree)` (pre-order values); both must be iterative (no recursion), so deep trees do not overflow the stack.'],
  ['diff', "export function lines(s) {\n  return String(s).split('\\n')\n}", '`src/diff.js`: add `lcsLength(a, b)` for two arrays (the length of their longest common subsequence) in O(len(a)·len(b)) time and O(min) memory.'],
  ['semver', "export function parts(v) {\n  return String(v).split('.').map(Number)\n}", '`src/semver.js`: add `compare(a, b)` returning -1/0/1 for `MAJOR.MINOR.PATCH` with an optional `-prerelease` (a prerelease sorts before its release).'],
  ['events', 'export function createEmitter() {\n  return { handlers: new Map() }\n}', '`src/events.js`: add `on(em, name, fn)` returning an unsubscribe function, and `emit(em, name, ...args)` that calls handlers in subscription order.'],
  ['throttle', 'export function now() {\n  return Date.now()\n}', '`src/throttle.js`: add `rateLimiter(limit, windowMs, clock = Date.now)` returning `tryAcquire()` that allows at most `limit` calls per sliding window.'],
  ['ini', "export function trimAll(lines) {\n  return lines.map(l => l.trim())\n}", '`src/ini.js`: add `parseIni(text)` supporting `[section]` headers, `key = value` pairs, and `;`/`#` comments; keys before any section go to `""`.'],
  ['luhn', "export function digits(s) {\n  return String(s).replace(/\\D/g, '').split('').map(Number)\n}", '`src/luhn.js`: add `isValidLuhn(s)` (spaces allowed, any other non-digit makes it invalid, fewer than 2 digits is invalid).'],
  ['template', "export function escapeHtml(s) {\n  return String(s).replace(/[&<>\"']/g, c => `&#${c.charCodeAt(0)};`)\n}", '`src/template.js`: add `render(tpl, data)` replacing `{{ name }}` (spaces optional) with HTML-escaped values; unknown names render as an empty string.'],
  ['geo', 'export const EARTH_RADIUS_KM = 6371', '`src/geo.js`: add `haversineKm(a, b)` for `{ lat, lon }` points in degrees; the result is rounded to 3 decimals.'],
  ['bits', 'export function popcount(n) {\n  let c = 0\n  for (; n; n &= n - 1) c++\n  return c\n}', '`src/bits.js`: add `isPowerOfTwo(n)` (integers only, `0` is not) and `nextPowerOfTwo(n)` for positive integers up to 2^30.'],
  ['chunk', 'export function head(xs) {\n  return xs[0]\n}', '`src/chunk.js`: add `chunk(xs, size)` (last chunk may be shorter) and `zip(...arrays)` truncated to the shortest array; `size < 1` throws `RangeError`.'],
  ['path', "export function sep() {\n  return '/'\n}", '`src/path.js`: add `normalize(p)` that resolves `.` and `..` segments and duplicate slashes for POSIX paths, keeping a leading `/`.'],
  ['heap', 'export function createHeap(compare = (a, b) => a - b) {\n  return { compare, items: [] }\n}', '`src/heap.js`: add `push(h, x)`, `pop(h)` (returns `undefined` on empty) and `peek(h)` as a binary heap using `h.compare`.'],
  ['crc', 'export const POLY = 0xedb88320', '`src/crc.js`: add `crc32(input)` for a string (UTF-8) or `Uint8Array`, returning an unsigned 32-bit integer (`crc32("hello")` is `907060870`).'],
  ['duration', 'export const MINUTE = 60', '`src/duration.js`: add `formatDuration(seconds)` → `"1h 2m 3s"` style (omit zero units, `0` → `"0s"`) and `parseDuration(text)` as its inverse.'],
  ['mask', "export function last4(s) {\n  return String(s).slice(-4)\n}", '`src/mask.js`: add `maskEmail(email)` keeping the first character of the local part and the domain (`ada@x.io` → `a**@x.io`); invalid emails throw `TypeError`.'],
  ['graph', 'export function createGraph() {\n  return new Map()\n}', '`src/graph.js`: add `addEdge(g, a, b)` (directed) and `topoSort(g)` (Kahn); a cycle throws `Error` whose message names one node of the cycle.'],
  ['currency', "export const SYMBOLS = { EUR: '€', USD: '$', GBP: '£' }", '`src/currency.js`: add `formatMoney(cents, code)` → `"€12.34"`, negative as `"-€12.34"`; an unknown code throws `RangeError`.'],
  ['ids', "export const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'", '`src/ids.js`: add `toBase36(n)` / `fromBase36(s)` for non-negative safe integers; invalid characters throw `TypeError`.'],
  ['schedule', 'export const DAYS = [\'mon\', \'tue\', \'wed\', \'thu\', \'fri\', \'sat\', \'sun\']', '`src/schedule.js`: add `nextWeekday(date, weekday)` returning a new `Date` for the next given weekday (never the same day) in UTC.'],
  ['sanitize', "export function stripTags(s) {\n  return String(s).replace(/<[^>]*>/g, '')\n}", '`src/sanitize.js`: add `safeFilename(name)` that removes path separators, control characters and leading dots, and limits the result to 100 characters.'],
  ['vector', 'export function vec(x, y) {\n  return { x, y }\n}', '`src/vector.js`: add `addV`, `scaleV`, `dot` and `length` for 2-D vectors; none of them mutates its arguments.'],
  ['pager', 'export function pageCount(total, size) {\n  return Math.ceil(total / size)\n}', '`src/pager.js`: add `paginate(items, page, size)` returning `{ items, page, pages, hasNext }` (1-based pages; out-of-range pages return empty items).'],
  ['tokens', "export function isSpace(c) {\n  return c === ' ' || c === '\\t'\n}", '`src/tokens.js`: add `tokenize(expr)` for arithmetic expressions (numbers with decimals, `+ - * / ( )`), throwing `SyntaxError` with the position of an unknown character.'],
  ['bloom', 'export function createBloom(bits) {\n  return { bits, data: new Uint8Array(Math.ceil(bits / 8)) }\n}', '`src/bloom.js`: add `addB(b, s)` and `mightContain(b, s)` with three FNV-1a based hashes; an added string must always be reported as present.'],
]

export const LINT = `// Repository lint (run by \`npm test\`). Conventions, see CONTRIBUTING.md:
//  1. every exported function in src/ has a JSDoc block (/** ... */) right above it with @param for each parameter and @returns;
//  2. no console.log in src/;
//  3. lines are at most 100 characters;
//  4. every src/<name>.js has a test/<name>.test.js.
import fs from 'node:fs'
const problems = []
for (const file of fs.readdirSync('src').filter(f => f.endsWith('.js'))) {
  const text = fs.readFileSync('src/' + file, 'utf8')
  const lines = text.split('\\n')
  lines.forEach((line, i) => {
    if (line.length > 100) problems.push(\`src/\${file}:\${i + 1}: line longer than 100 characters\`)
    if (/console\\.log/.test(line)) problems.push(\`src/\${file}:\${i + 1}: console.log is not allowed in src/\`)
    const fn = /^export (?:async )?function\\s+(\\w+)\\s*\\(([^)]*)\\)/.exec(line)
    if (!fn) return
    let j = i - 1
    while (j >= 0 && lines[j].trim() === '') j--
    if (j < 0 || !lines[j].trim().endsWith('*/')) { problems.push(\`src/\${file}:\${i + 1}: \${fn[1]} has no JSDoc block\`); return }
    let k = j
    while (k >= 0 && !lines[k].includes('/**')) k--
    const doc = lines.slice(Math.max(0, k), j + 1).join('\\n')
    const params = fn[2].split(',').map(p => p.trim().replace(/=.*$/, '').replace(/^\\.\\.\\./, '').trim()).filter(p => p && !p.startsWith('{'))
    for (const p of params) if (!new RegExp('@param\\\\s+(\\\\{[^}]*\\\\}\\\\s+)?\\\\[?' + p + '\\\\b').test(doc)) problems.push(\`src/\${file}:\${i + 1}: \${fn[1]} JSDoc lacks @param \${p}\`)
    if (!/@returns?\\b/.test(doc)) problems.push(\`src/\${file}:\${i + 1}: \${fn[1]} JSDoc lacks @returns\`)
  })
  const stem = file.replace(/\\.js$/, '')
  if (!fs.existsSync('test/' + stem + '.test.js')) problems.push(\`src/\${file}: missing test/\${stem}.test.js\`)
}
if (problems.length) { console.error(problems.join('\\n')); console.error(\`lint: \${problems.length} problem(s)\`); process.exit(1) }
console.log('lint: ok')
`

/** JSDoc for a starting function, so the starting repository passes its own lint. */
export function documented(source) {
  return source.replace(/^export function (\w+)\(([^)]*)\)/gm, (line, name, params) => {
    const names = params.split(',').map(p => p.trim().replace(/=.*$/, '').trim()).filter(Boolean)
    return ['/**', ` * ${name}.`, ...names.map(p => ` * @param {*} ${p}`), ' * @returns {*}', ' */', line].join('\n')
  })
}

/** A slow, steadily reporting integration suite: `subtests` × `seconds` of waiting, one TAP line per subtest. */
export function slowSuite(subtests, seconds) {
  return NT + "const wait = ms => new Promise(r => setTimeout(r, ms))\n" +
    `test('integration (slow on purpose: about ${Math.round(subtests * seconds / 60)} min)', async t => {\n` +
    `  for (let i = 1; i <= ${subtests}; i++) {\n` +
    `    await t.test('scenario ' + i, async () => { await wait(${seconds * 1000}); assert.ok(true) })\n` +
    '  }\n})\n'
}

/**
 * Files of a large library: `count` modules from MODULES (each with a test), the
 * lint, CONTRIBUTING.md, and a slow integration suite of `slow` = [subtests, seconds].
 */
export function bigLibFiles(name, { count = MODULES.length, slow = [12, 15], offset = 0 } = {}) {
  const rows = MODULES.slice(offset, offset + count)
  const files = {
    'package.json': JSON.stringify({ name, version: '1.0.0', private: true, type: 'module',
      scripts: { lint: 'node scripts/lint.mjs', 'test:unit': "node --test 'test/unit/*.test.js'", test: "node scripts/lint.mjs && node --test 'test/unit/*.test.js' 'test/integration/*.test.js'" } }, null, 2) + '\n',
    'scripts/lint.mjs': LINT,
    'CONTRIBUTING.md': '# Contributing\n\n`npm test` runs `scripts/lint.mjs`, then every unit test and the integration suite.\n\n' +
      '- Every exported function in `src/` needs a JSDoc block with `@param` for each parameter and `@returns`.\n' +
      '- No `console.log` in `src/`. Lines are at most 100 characters.\n' +
      '- Every `src/<name>.js` has `test/unit/<name>.test.js`.\n' +
      `- The integration suite (\`test/integration/\`) is slow on purpose (about ${Math.round(slow[0] * slow[1] / 60)} minutes). While working, run \`npm run lint\` and \`npm run test:unit\` (seconds); run the full \`npm test\` once at the end.\n`,
    'README.md': `# ${name}\n\nA utility library of ${rows.length} small modules in \`src/\`. See CONTRIBUTING.md before changing anything.\n`,
    'CHANGELOG.md': '# Changelog\n\n## Unreleased\n',
    '.gitignore': 'node_modules\n',
    'test/integration/integration.test.js': slowSuite(slow[0], slow[1]),
  }
  for (const [stem, source] of rows) {
    files[`src/${stem}.js`] = documented(source) + '\n'
    const first = /export (?:function (\w+)|const (\w+))/.exec(source)
    const symbol = first[1] ?? first[2]
    files[`test/unit/${stem}.test.js`] = NT + `import * as m from '../../src/${stem}.js'\ntest('${stem} exports ${symbol}', () => assert.ok(m.${symbol} !== undefined))\n`
  }
  // The lint looks for test/<name>.test.js; the template keeps unit tests under test/unit.
  files['scripts/lint.mjs'] = LINT.replace("fs.existsSync('test/' + stem + '.test.js')", "fs.existsSync('test/unit/' + stem + '.test.js')").replace('missing test/${stem}.test.js', 'missing test/unit/${stem}.test.js')
  return files
}

/** The long spec for rows [offset, offset + count): one numbered requirement per module. */
export function bigSpec({ count = MODULES.length, offset = 0, extra = [] } = {}) {
  const rows = MODULES.slice(offset, offset + count)
  return [
    `Extend the library with ${rows.length} small, independent features. Each one needs unit tests in \`test/unit/<module>.test.js\` covering the normal case and every error case named here, and a line in CHANGELOG.md under "Unreleased". Follow CONTRIBUTING.md (JSDoc on every exported function; the lint runs in \`npm test\`).`,
    '',
    ...rows.map(([, , req], i) => `${i + 1}. ${req}`),
    ...extra.map((req, i) => `${rows.length + i + 1}. ${req}`),
    '',
    'Out of scope: renaming or removing any existing export, adding dependencies.',
  ].join('\n')
}

/**
 * A very long spec for multi-hour runs: every module row becomes `perModule` numbered
 * requirements (the feature, edge-case tests, a runnable example with its test, a doc
 * page), so 40 rows × 4 plan about 160 tasks. Each item is small and checkable.
 */
export function epicSpec({ count = MODULES.length, offset = 0, perModule = 4, extra = [] } = {}) {
  const rows = MODULES.slice(offset, offset + count)
  const items = []
  for (const [stem, , req] of rows) {
    items.push(req)
    if (perModule >= 2) items.push(`\`test/unit/${stem}.edge.test.js\`: at least four edge-case tests (boundaries, wrong types, empty input) for the \`src/${stem}.js\` function(s) added above.`)
    if (perModule >= 3) items.push(`\`examples/${stem}.mjs\`: a runnable example importing the new \`src/${stem}.js\` function(s) and printing one result; \`test/unit/${stem}.example.test.js\` runs it with \`node\` (child_process) and asserts exit code 0.`)
    if (perModule >= 4) items.push(`\`docs/${stem}.md\`: the signatures, every error case and one example of the new \`src/${stem}.js\` function(s); link it from README.md under "## Modules".`)
  }
  return [
    `Extend the library with ${items.length} small, independent requirements (${rows.length} modules). Unit tests live in \`test/unit/\` and cover the normal case and every error case named here; add a line per module in CHANGELOG.md under "Unreleased". Follow CONTRIBUTING.md (JSDoc on every exported function; the lint runs in \`npm test\`).`,
    '',
    ...[...items, ...extra].map((req, i) => `${i + 1}. ${req}`),
    '',
    'Out of scope: renaming or removing any existing export, adding dependencies.',
  ].join('\n')
}

/** A unit-test file that only waits `seconds` (every `npm run test:unit` takes that long, like a heavy real suite). */
export function slowUnit(seconds) {
  return NT + `test('unit warm-up (slow on purpose: ${seconds} s)', async () => { await new Promise(r => setTimeout(r, ${seconds * 1000})); assert.ok(true) })\n`
}
