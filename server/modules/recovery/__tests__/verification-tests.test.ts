import { describe, expect, it } from 'vitest'
import { classifyVerificationTests, parseRound, testName } from '..'

const P = '[verification primary-1/npm] '
const pass = (n: number, file: string, title: string) => `${P}  ✓  ${n} ${file} › ${title} [spec:desktop/close] (843ms)`
const fail = (n: number, file: string, title: string) => `${P}  ✘  ${n} ${file} › ${title} [spec:desktop/close] (6.1s)`
const SALIR = 'Salir exits from main'
const MENUS = 'tests/desktop/menus.spec.ts'
const timingBlock = (title: string) => [
  `${P}  1) ${MENUS}:221:1 › ${title} [spec:desktop/close] ──────`,
  `${P}    Error: expect(received).toBe(expected) // Object.is equality`,
  `${P}    - Timeout 5000ms exceeded while waiting on the predicate`,
]

describe('verification test outcomes', () => {
  it('names a test by file and title, without line numbers, spec tags or durations', () => {
    expect(testName(`${MENUS}:209:1`, `${SALIR} [spec:a/b] (1.3s)`)).toBe(`${MENUS} › ${SALIR}`)
    const round = parseRound([pass(21, `${MENUS}:209:1`, SALIR), `\u001b[2m${fail(23, `${MENUS}:221:1`, 'native close exits')}\u001b[22m`])
    expect([...round.outcomes]).toEqual([[`${MENUS} › ${SALIR}`, new Set(['pass'])], [`${MENUS} › native close exits`, new Set(['fail'])]])
  })

  it('reads Vitest and Jest results too', () => {
    const vitest = parseRound([' ✓ src/a.test.ts > sum > adds 2ms', ' × src/a.test.ts > sum > carries 3ms', ' ❯ src/b.test.ts (2 tests | 1 failed) 5ms', '   × parser > reads 1ms'])
    expect([...vitest.outcomes.keys()]).toEqual(['src/a.test.ts › sum › adds', 'src/a.test.ts › sum › carries', 'src/b.test.ts › parser › reads'])
    expect(vitest.outcomes.get('src/b.test.ts › parser › reads')).toEqual(new Set(['fail']))
    const jest = parseRound([' FAIL src/c.test.js', '  ✕ rejects empty (3 ms)', ' PASS src/d.test.js', '  ✓ accepts (1 ms)'])
    expect([...jest.outcomes]).toEqual([['src/c.test.js › rejects empty', new Set(['fail'])], ['src/d.test.js › accepts', new Set(['pass'])]])
  })

  it('lists the latest round\'s failing tests and nothing as flaky for a plain failure', () => {
    const result = classifyVerificationTests([{ lines: [fail(1, `${MENUS}:5:1`, 'opens the menu')] }])
    expect(result).toMatchObject({ failingTests: [`${MENUS} › opens the menu`], flakyTests: [], rounds: 1 })
  })

  it('a test that failed and was then fixed is not flaky, and is not failing any more', () => {
    const result = classifyVerificationTests([{ lines: [fail(1, `${MENUS}:5:1`, 'opens')] }, { lines: [pass(1, `${MENUS}:5:1`, 'opens')] }])
    expect(result.failingTests).toEqual([])
    expect(result.flakyTests).toEqual([])
  })

  it('a test that passed and failed on the same candidate is flaky (mixed)', () => {
    const result = classifyVerificationTests([{ lines: [pass(21, `${MENUS}:209:1`, SALIR), fail(21, `${MENUS}:209:1`, SALIR)] }])
    expect(result.flakyBasis).toEqual({ [`${MENUS} › ${SALIR}`]: 'mixed' })
  })

  it('a test whose outcome flips twice across rounds is flaky (alternating), wherever its line moved', () => {
    const rounds = [[pass(1, `${MENUS}:156:1`, SALIR)], [fail(1, `${MENUS}:165:1`, SALIR)], [pass(1, `${MENUS}:181:1`, SALIR)], [fail(1, `${MENUS}:209:1`, SALIR)]].map((lines) => ({ lines }))
    expect(classifyVerificationTests(rounds).flakyBasis).toEqual({ [`${MENUS} › ${SALIR}`]: 'alternating' })
  })

  it('takes the test runner\'s own flaky report', () => {
    const result = classifyVerificationTests([{ lines: [fail(3, `${MENUS}:9:1`, 'quits'), `${P}  1 flaky`, `${P}    [electron] › ${MENUS}:9:1 › quits ──`, `${P}  12 passed (40s)`] }])
    expect(result.flakyBasis).toEqual({ [`${MENUS} › quits`]: 'reported' })
  })

  it('a test that passed in earlier rounds and now fails on a timeout is flaky (timing); an assertion about the change is not', () => {
    const earlier = { lines: [pass(23, `${MENUS}:221:1`, 'native close exits'), pass(24, `${MENUS}:232:1`, 'keeps the draft')] }
    const latest = { lines: [fail(23, `${MENUS}:221:1`, 'native close exits'), fail(24, `${MENUS}:232:1`, 'keeps the draft'), ...timingBlock('native close exits'),
      `${P}  2) ${MENUS}:232:1 › keeps the draft ──`, `${P}    Expected: "saved"`, `${P}    Received: "lost"`, `${P}  2 failed`] }
    const result = classifyVerificationTests([earlier, earlier, latest])
    expect(result.failingTests).toEqual([`${MENUS} › native close exits`, `${MENUS} › keeps the draft`])
    expect(result.flakyBasis).toEqual({ [`${MENUS} › native close exits`]: 'timing' })
    // Once is not a pattern: a single earlier pass does not make a timeout flaky.
    expect(classifyVerificationTests([earlier, latest]).flakyTests).toEqual([])
  })

  it('reads no rounds as nothing', () => {
    expect(classifyVerificationTests([{ lines: ['npm run build', 'built in 2s'] }])).toEqual({ failingTests: [], flakyTests: [], flakyBasis: {}, rounds: 0 })
  })
})
