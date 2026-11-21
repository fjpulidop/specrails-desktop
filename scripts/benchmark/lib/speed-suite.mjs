// The speed benchmark's fixed spec suite: small, medium and large specs, single and
// multi-repository, with real unit tests, a repository lint in `npm test`, and a few
// specs with edge cases that historically needed correction rounds. Every spec has
// HIDDEN acceptance tests (never written into the repository the agent sees); the
// harness runs them on the delivered branch to check spec conformance on its own.
// Pure data.

import { LINT, documented } from './big-repos.mjs'

const NT = "import test from 'node:test'\nimport assert from 'node:assert'\n"

/** A small shop library: three modules with tests, the convention lint and CONTRIBUTING.md. */
export function shopLibFiles(name) {
  const src = {
    cart: 'export function total(items) {\n  return items.reduce((sum, i) => sum + i.price * i.qty, 0)\n}',
    format: "export function formatPrice(cents) {\n  return '$' + (cents / 100).toFixed(2)\n}",
    orders: "export function createOrder(id, items) {\n  return { id, status: 'open', items }\n}",
  }
  return {
    'package.json': JSON.stringify({ name, version: '1.0.0', private: true, type: 'module',
      scripts: { lint: 'node scripts/lint.mjs', test: "node --test 'test/*.test.js' && node scripts/lint.mjs" } }, null, 2) + '\n',
    'scripts/lint.mjs': LINT,
    'CONTRIBUTING.md': '# Contributing\n\n`npm test` runs every unit test, then `scripts/lint.mjs`.\n\n' +
      '- Every exported function in `src/` needs a JSDoc block with `@param` for each parameter and `@returns`.\n' +
      '- No `console.log` in `src/`. Lines are at most 100 characters.\n' +
      '- Every `src/<name>.js` has `test/<name>.test.js`.\n- No dependencies.\n',
    'README.md': `# ${name}\n\nA small shop library (ES modules, no dependencies). \`npm test\` runs the unit tests and the lint.\n\n## API\n\n- \`total(items)\` (src/cart.js)\n- \`formatPrice(cents)\` (src/format.js)\n- \`createOrder(id, items)\` (src/orders.js)\n`,
    '.gitignore': 'node_modules\n',
    ...Object.fromEntries(Object.entries(src).map(([stem, code]) => [`src/${stem}.js`, documented(code) + '\n'])),
    'test/cart.test.js': NT + "import { total } from '../src/cart.js'\ntest('total', () => assert.equal(total([{ price: 2, qty: 3 }, { price: 1, qty: 1 }]), 7))\n",
    'test/format.test.js': NT + "import { formatPrice } from '../src/format.js'\ntest('formatPrice', () => assert.equal(formatPrice(1234), '$12.34'))\n",
    'test/orders.test.js': NT + "import { createOrder } from '../src/orders.js'\ntest('createOrder', () => assert.equal(createOrder(1, []).status, 'open'))\n",
  }
}

const hidden = (imports, body) => NT + imports + '\n' + body.trim() + '\n'
/** The hidden acceptance file's path inside the exported candidate (outside src/ and test/). */
export const HIDDEN_DIR = '.acceptance'

/**
 * The specs. `size`: small | medium | large; `tricky`: edge cases that historically
 * needed corrections. `repos`: template per repository; `hidden[i]` the acceptance
 * files of repository i (imports are relative to `.acceptance/`).
 */
export const SPEED_SPECS = [
  {
    key: 'discount', size: 'small', repos: ['shop-lib'],
    title: 'Add an integer-cents discount helper',
    description: 'Add `applyDiscount(totalCents, percent)` to `src/cart.js`. It returns the discounted total in integer cents, rounded half up (for example 999 cents at 15% is 849, and 1 cent at 50% is 1). `percent` must be a number from 0 to 100 inclusive; anything else (including NaN) throws `RangeError`. `totalCents` must be a non-negative integer; anything else (a fraction, a negative number, a string) throws `TypeError`. Add unit tests in `test/cart.test.js` and list the function in README.md.',
    hidden: [{ [`${HIDDEN_DIR}/discount.test.mjs`]: hidden("import { applyDiscount, total } from '../src/cart.js'", `
test('rounds half up to integer cents', () => {
  assert.equal(applyDiscount(999, 15), 849)
  assert.equal(applyDiscount(1000, 12.5), 875)
  assert.equal(applyDiscount(1, 50), 1)
  assert.equal(applyDiscount(3, 50), 2)
  assert.equal(applyDiscount(1234, 0), 1234)
  assert.equal(applyDiscount(1234, 100), 0)
  assert.equal(applyDiscount(0, 30), 0)
})
test('percent range', () => {
  for (const p of [-1, 100.01, 101, NaN, '10', undefined]) assert.throws(() => applyDiscount(100, p), RangeError, String(p))
})
test('totalCents type', () => {
  for (const t of [10.5, -5, '100', null]) assert.throws(() => applyDiscount(t, 10), TypeError, String(t))
})
test('total unchanged', () => assert.equal(total([{ price: 2, qty: 3 }]), 6))
`) }],
  },
  {
    key: 'slugify', size: 'small', tricky: true, repos: ['shop-lib'],
    title: 'Add slugify to the format module',
    description: 'Add `slugify(text)` to `src/format.js`. It lowercases the text and removes diacritics (`Crème Brûlée` becomes `creme-brulee`). Every run of characters that are not `a`-`z` or `0`-`9` becomes a single `-`, and the result never starts or ends with `-`. The result is at most 40 characters: when it is longer, cut it at the last `-` that keeps it within 40 characters and drop that `-`; only when the first word alone is longer than 40 characters, cut it hard at 40. An empty or separator-only text gives `""`. A non-string throws `TypeError`. Add unit tests in `test/format.test.js`.',
    hidden: [{ [`${HIDDEN_DIR}/slugify.test.mjs`]: hidden("import { slugify, formatPrice } from '../src/format.js'", `
test('basic', () => {
  assert.equal(slugify('Crème Brûlée'), 'creme-brulee')
  assert.equal(slugify('  Hello,   World!! '), 'hello-world')
  assert.equal(slugify('ÀÉÎ õü 42'), 'aei-ou-42')
  assert.equal(slugify('a--b__c'), 'a-b-c')
  assert.equal(slugify(''), '')
  assert.equal(slugify('!!!'), '')
})
test('cuts at a word boundary within 40', () => {
  const s = slugify('The quick brown fox jumps over the lazy dog again and again')
  assert.equal(s, 'the-quick-brown-fox-jumps-over-the-lazy')
  assert.ok(s.length <= 40)
  assert.equal(slugify('x'.repeat(39) + ' yz'), 'x'.repeat(39))
  assert.equal(slugify('a'.repeat(40)), 'a'.repeat(40))
  assert.equal(slugify('b'.repeat(55) + ' tail'), 'b'.repeat(40))
})
test('type', () => { for (const v of [null, 5, {}]) assert.throws(() => slugify(v), TypeError) })
test('formatPrice unchanged', () => assert.equal(formatPrice(5), '$0.05'))
`) }],
  },
  {
    key: 'money', size: 'medium', tricky: true, repos: ['shop-lib'],
    title: 'Parse and format money amounts without floating point',
    description: 'Create `src/money.js` with `parseMoney(text)` and `formatMoney(cents, currency = "USD")`, with unit tests in `test/money.test.js`, and document both in README.md.\n\n`parseMoney`: an optional leading `-`, then an optional `$`, then digits, optionally grouped with `,` thousands separators (only complete groups of three after the first group, e.g. `1,234,567`), then an optional `.` followed by one or two digits. It returns integer cents: `"$1,234.5"` is 123450, `"-0.01"` is -1, `"12"` is 1200, `"-$3"` is -300. Anything else throws `SyntaxError`, for example `"1.234"`, `"1,23"`, `"12,34"`, `""`, `"abc"`, `"$-1"`, `"1.2.3"`, `" 1"`. The conversion must not use floating-point arithmetic (`"0.29"` is exactly 29, `"19.99"` is 1999).\n\n`formatMoney`: `USD` gives `$1,234.50` (comma thousands, dot decimals) and `EUR` gives `€1.234,50` (dot thousands, comma decimals); negative amounts put `-` first (`-$0.01`, `-€0,01`). An unknown currency throws `RangeError`; cents that are not an integer throw `TypeError`.',
    hidden: [{ [`${HIDDEN_DIR}/money.test.mjs`]: hidden("import { parseMoney, formatMoney } from '../src/money.js'", `
test('parse valid', () => {
  const cases = { '$1,234.5': 123450, '-0.01': -1, '12': 1200, '-$3': -300, '0.29': 29, '19.99': 1999, '1,234,567.89': 123456789, '1234': 123400, '$0': 0, '7.5': 750, '999,999.99': 99999999 }
  for (const [text, cents] of Object.entries(cases)) assert.equal(parseMoney(text), cents, text)
})
test('parse invalid', () => {
  for (const text of ['1.234', '1,23', '12,34', '', 'abc', '$-1', '1.2.3', ' 1', '1,2345', '1.', '--1', '$$1', '1,234,56']) assert.throws(() => parseMoney(text), SyntaxError, JSON.stringify(text))
})
test('format', () => {
  assert.equal(formatMoney(123450), '$1,234.50')
  assert.equal(formatMoney(123450, 'USD'), '$1,234.50')
  assert.equal(formatMoney(123450, 'EUR'), '€1.234,50')
  assert.equal(formatMoney(-1), '-$0.01')
  assert.equal(formatMoney(-1, 'EUR'), '-€0,01')
  assert.equal(formatMoney(0), '$0.00')
  assert.equal(formatMoney(5), '$0.05')
  assert.equal(formatMoney(123456789, 'EUR'), '€1.234.567,89')
  assert.equal(formatMoney(100000), '$1,000.00')
})
test('format errors', () => {
  assert.throws(() => formatMoney(100, 'GBP'), RangeError)
  assert.throws(() => formatMoney(1.5), TypeError)
  assert.throws(() => formatMoney('100'), TypeError)
})
test('round trip', () => { for (const c of [0, 1, 99, 100, 123456, -98765]) assert.equal(parseMoney(formatMoney(c)), c) })
`) }],
  },
  {
    key: 'orders', size: 'medium', repos: ['shop-lib'],
    title: 'Summarize orders and cancel them safely',
    description: 'In `src/orders.js` add:\n\n1. `summarize(orders)`: orders are `{ id, status, items: [{ price, qty }] }` with status `open`, `paid` or `cancelled`. Return `{ count, byStatus: { open, paid, cancelled }, revenueCents, averagePaidCents }`: `count` is the number of orders, `byStatus` counts each status (all three keys always present), `revenueCents` is the sum of the order totals of `paid` orders only (an order total is `total(items)` from `src/cart.js`), and `averagePaidCents` is `revenueCents` divided by the number of paid orders, rounded to the nearest integer (0 when there are none). An unknown status throws `RangeError` whose message contains the order id.\n2. `cancelOrder(order)`: returns a NEW order object with status `cancelled` and does not mutate its argument; cancelling a `paid` order throws an `Error` with the message `cannot cancel a paid order`; cancelling an already cancelled order returns an equal copy.\n\nAdd unit tests for both in `test/orders.test.js`.',
    hidden: [{ [`${HIDDEN_DIR}/orders.test.mjs`]: hidden("import { summarize, cancelOrder, createOrder } from '../src/orders.js'", `
const o = (id, status, items) => ({ id, status, items })
test('summarize', () => {
  const s = summarize([o(1, 'paid', [{ price: 100, qty: 2 }]), o(2, 'open', [{ price: 5, qty: 1 }]), o(3, 'paid', [{ price: 101, qty: 1 }]), o(4, 'cancelled', [{ price: 9, qty: 9 }])])
  assert.deepEqual(s, { count: 4, byStatus: { open: 1, paid: 2, cancelled: 1 }, revenueCents: 301, averagePaidCents: 151 })
})
test('summarize empty and no paid', () => {
  assert.deepEqual(summarize([]), { count: 0, byStatus: { open: 0, paid: 0, cancelled: 0 }, revenueCents: 0, averagePaidCents: 0 })
  assert.equal(summarize([o(1, 'open', [])]).averagePaidCents, 0)
})
test('unknown status names the id', () => {
  assert.throws(() => summarize([o('ord-77', 'shipped', [])]), err => err instanceof RangeError && /ord-77/.test(err.message))
})
test('cancelOrder', () => {
  const open = o(1, 'open', [{ price: 1, qty: 1 }])
  const c = cancelOrder(open)
  assert.equal(c.status, 'cancelled'); assert.equal(open.status, 'open'); assert.notEqual(c, open)
  assert.deepEqual(c.items, open.items)
  assert.throws(() => cancelOrder(o(2, 'paid', [])), err => err.message === 'cannot cancel a paid order')
  const again = cancelOrder(c)
  assert.deepEqual(again, c)
})
test('createOrder unchanged', () => assert.deepEqual(createOrder(9, []), { id: 9, status: 'open', items: [] }))
`) }],
  },
  {
    key: 'inventory', size: 'large', repos: ['shop-lib'],
    title: 'Inventory with reservations',
    description: 'Create `src/inventory.js` exporting a class `Inventory` (document every method; the lint only checks exported functions), with unit tests in `test/inventory.test.js`, and an "Inventory" section in README.md describing the API.\n\nMethods:\n1. `add(sku, qty)` adds stock on hand.\n2. `remove(sku, qty)` removes stock on hand; it may not remove reserved stock.\n3. `reserve(sku, qty)` reserves available stock and returns a reservation id (a string, unique within the inventory).\n4. `release(id)` cancels a reservation (the stock becomes available again).\n5. `commit(id)` completes a reservation: the reserved quantity leaves the stock on hand.\n6. `onHand(sku)` and `available(sku)` (on hand minus reserved); both are 0 for an unknown sku.\n7. `lowStock(threshold)` returns the skus whose available quantity is below `threshold`, sorted alphabetically (skus that were ever added count, even at 0).\n8. `toJSON()` returns a plain object and `Inventory.fromJSON(obj)` restores an equal inventory, open reservations included (ids keep working, and new ids never collide with restored ones).\n\nRules: `sku` must be a non-empty string and `qty` a positive integer, otherwise `TypeError`. Removing or reserving more than is available throws `RangeError`. An unknown reservation id, or releasing or committing the same reservation twice, throws `Error`.',
    hidden: [{ [`${HIDDEN_DIR}/inventory.test.mjs`]: hidden("import { Inventory } from '../src/inventory.js'", `
test('stock and reservations', () => {
  const inv = new Inventory()
  inv.add('apple', 10); inv.add('pear', 2)
  assert.equal(inv.onHand('apple'), 10); assert.equal(inv.available('kiwi'), 0); assert.equal(inv.onHand('kiwi'), 0)
  const r = inv.reserve('apple', 4)
  assert.equal(typeof r, 'string')
  assert.equal(inv.available('apple'), 6); assert.equal(inv.onHand('apple'), 10)
  assert.throws(() => inv.remove('apple', 7), RangeError)
  inv.remove('apple', 6); assert.equal(inv.onHand('apple'), 4); assert.equal(inv.available('apple'), 0)
  inv.commit(r); assert.equal(inv.onHand('apple'), 0); assert.equal(inv.available('apple'), 0)
  assert.throws(() => inv.commit(r), Error); assert.throws(() => inv.release(r), Error)
  const r2 = inv.reserve('pear', 2); inv.release(r2); assert.equal(inv.available('pear'), 2)
  assert.throws(() => inv.release(r2), Error); assert.throws(() => inv.release('nope'), Error)
  assert.notEqual(inv.reserve('pear', 1), inv.reserve('pear', 1))
})
test('validation', () => {
  const inv = new Inventory()
  for (const [s, q] of [['', 1], [5, 1], ['a', 0], ['a', -1], ['a', 1.5], ['a', '2']]) assert.throws(() => inv.add(s, q), TypeError, JSON.stringify([s, q]))
  inv.add('a', 1)
  assert.throws(() => inv.reserve('a', 2), RangeError)
  assert.throws(() => inv.reserve('a', 0), TypeError)
  assert.throws(() => inv.remove('b', 1), RangeError)
})
test('lowStock', () => {
  const inv = new Inventory()
  inv.add('zeta', 1); inv.add('alpha', 5); inv.add('mid', 3); inv.reserve('alpha', 4)
  inv.add('gone', 2); inv.remove('gone', 2)
  assert.deepEqual(inv.lowStock(3), ['alpha', 'gone', 'zeta'])
})
test('json round trip keeps reservations', () => {
  const inv = new Inventory()
  inv.add('a', 5); const r = inv.reserve('a', 2)
  const copy = Inventory.fromJSON(JSON.parse(JSON.stringify(inv.toJSON())))
  assert.equal(copy.available('a'), 3); assert.equal(copy.onHand('a'), 5)
  const fresh = copy.reserve('a', 1)
  assert.notEqual(fresh, r)
  copy.commit(r); assert.equal(copy.onHand('a'), 3); assert.equal(copy.available('a'), 2)
  assert.deepEqual(copy.toJSON(), Inventory.fromJSON(copy.toJSON()).toJSON())
})
`) }],
  },
  {
    key: 'duration', size: 'medium', tricky: true, repos: ['shop-lib'],
    title: 'Parse and format durations',
    description: 'Create `src/duration.js` with `parseDuration(text)` and `formatDuration(ms)`, with unit tests in `test/duration.test.js`.\n\n`parseDuration` returns milliseconds. The text is one or more `<number><unit>` parts with units `h`, `m`, `s` and `ms`, optionally separated by whitespace; numbers may have a decimal part (`1.5h`). Each unit appears at most once and units must be in decreasing order (`1h30m` and `2m 5s` are valid; `30m1h` and `1m1m` throw `SyntaxError`). `ms` is a unit of its own (`1ms` is one millisecond, not a minute and a second). Empty text, unknown units, a missing number or a missing unit throw `SyntaxError`. The result is rounded to the nearest millisecond.\n\n`formatDuration` is the inverse for non-negative integers: largest units first, no separators, zero parts omitted, `0` gives `"0ms"` (for example 5400000 gives `"1h30m"`, 1500 gives `"1s500ms"`, 90061001 gives `"25h1m1s1ms"`). A negative or non-integer input throws `RangeError`.',
    hidden: [{ [`${HIDDEN_DIR}/duration.test.mjs`]: hidden("import { parseDuration, formatDuration } from '../src/duration.js'", `
test('parse', () => {
  const cases = { '1h30m': 5400000, '2m 5s': 125000, '1ms': 1, '1.5h': 5400000, '1m1s': 61000, '90s': 90000, '0.0005s': 1, '10m 0s 250ms': 600250, '1h 1ms': 3600001, '2.5ms': 3 }
  for (const [text, ms] of Object.entries(cases)) assert.equal(parseDuration(text), ms, text)
})
test('parse invalid', () => {
  for (const text of ['', '30m1h', '1m1m', '5', 'h', '1d', '1 h', '1x', 'ms', '1s1m', ' ', '1h-1m']) assert.throws(() => parseDuration(text), SyntaxError, JSON.stringify(text))
})
test('format', () => {
  assert.equal(formatDuration(0), '0ms')
  assert.equal(formatDuration(5400000), '1h30m')
  assert.equal(formatDuration(1500), '1s500ms')
  assert.equal(formatDuration(90061001), '25h1m1s1ms')
  assert.equal(formatDuration(60000), '1m')
  for (const v of [-1, 1.5, NaN]) assert.throws(() => formatDuration(v), RangeError)
})
test('round trip', () => { for (const ms of [1, 999, 61001, 3600000, 7322004]) assert.equal(parseDuration(formatDuration(ms)), ms) })
`) }],
  },
  {
    key: 'mr-email', size: 'medium', multiRepo: true, repos: ['mr-api', 'mr-web'],
    title: 'Show a masked email for each user',
    description: 'This change spans both repositories.\n\nAPI repository (`src/users.js`): `userDto(u)` also returns `email`, masked: keep the first character of the local part, replace each remaining local-part character with `*`, and keep the domain (`ada@example.com` becomes `a**@example.com`). A user whose email is missing or not valid (exactly one `@` with a non-empty part on each side) gets `email: null`. Other fields are unchanged and the password is never returned.\n\nWeb repository (`src/render.js`): `renderUser(dto)` HTML-escapes the name (`&`, `<`, `>`, `"`, `\'`) and, when `dto.email` is not null, appends a space and `<span class="email">…</span>` with the escaped email inside the `<li>`. For example `{ id: 1, name: "Ada", email: "a**@x.io" }` renders `<li data-id="1">Ada <span class="email">a**@x.io</span></li>`, and without an email it renders `<li data-id="1">Ada</li>`.\n\nUpdate the unit tests in both repositories.',
    hidden: [
      { [`${HIDDEN_DIR}/users.test.mjs`]: hidden("import { userDto } from '../src/users.js'", `
test('masks email', () => {
  assert.deepEqual(userDto({ id: 1, name: 'Ada', email: 'ada@example.com', pw: 'x' }), { id: 1, name: 'Ada', email: 'a**@example.com' })
  assert.equal(userDto({ id: 2, name: 'B', email: 'b@x.io' }).email, 'b@x.io')
})
test('invalid email is null', () => {
  for (const email of [undefined, '', 'nope', '@x.io', 'a@', 'a@b@c']) assert.equal(userDto({ id: 3, name: 'C', email }).email, null, String(email))
})
test('never the password', () => assert.equal('pw' in userDto({ id: 1, name: 'A', pw: 'secret', email: 'a@b.c' }), false))
`) },
      { [`${HIDDEN_DIR}/render.test.mjs`]: hidden("import { renderUser } from '../src/render.js'", `
test('with email', () => assert.equal(renderUser({ id: 1, name: 'Ada', email: 'a**@x.io' }), '<li data-id="1">Ada <span class="email">a**@x.io</span></li>'))
test('without email', () => {
  assert.equal(renderUser({ id: 1, name: 'Ada', email: null }), '<li data-id="1">Ada</li>')
  assert.equal(renderUser({ id: 1, name: 'Ada' }), '<li data-id="1">Ada</li>')
})
test('escapes the name', () => {
  const html = renderUser({ id: 2, name: '<b>&"\\'', email: null })
  assert.match(html, /^<li data-id="2">&lt;b&gt;&amp;&quot;(&#39;|&#x27;|&apos;)<\\/li>$/)
})
test('escapes the email', () => assert.ok(!renderUser({ id: 3, name: 'A', email: '<x>@y' }).includes('<x>')))
`) },
    ],
  },
]

/**
 * Scenario-file entries for one batch: every spec `reps` times, each copy on its own
 * fresh repository, names prefixed by `tag` (so batches never share a repository).
 */
export function speedScenarios({ tag, reps = 3, only = null, timeoutMinutes = 40 }) {
  const out = []
  for (const spec of SPEED_SPECS.filter(s => !only || only.includes(s.key))) {
    for (let k = 1; k <= reps; k++) {
      const name = `${tag}-${spec.key}-${k}`
      const repos = spec.repos.map((template, i) => ({ template, name: spec.repos.length > 1 ? `${name}-${template.replace(/^mr-/, '')}` : name, hidden: spec.hidden[i] ?? {} }))
      out.push({ name, group: `${spec.size}${spec.tricky ? '-tricky' : ''}${spec.multiRepo ? '-multi' : ''}`, spec: spec.key, repos,
        ticket: { title: spec.title, description: spec.description }, timeoutMinutes, answers: [{ recommended: true, once: false }], expect: { status: 'delivered' } })
    }
  }
  return out
}
