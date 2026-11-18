import { describe, expect, it } from 'vitest'
import { BoundedExecError, execBounded, runBounded } from './bounded-exec'

const node = process.execPath

describe('runBounded', () => {
  it('captures stdout/stderr and the exit code', async () => {
    const res = await runBounded(node, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'], { timeoutMs: 10_000 })
    expect(res).toMatchObject({ stdout: 'out', stderr: 'err', code: 3, timedOut: false })
    expect(res.error).toBeUndefined()
  })

  it('feeds input on stdin and closes it', async () => {
    const res = await runBounded(node, ['-e', 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(d.toUpperCase()))'], { timeoutMs: 10_000, input: 'abc' })
    expect(res.stdout).toBe('ABC')
  })

  it('kills the process tree on timeout without blocking the event loop', async () => {
    let ticks = 0
    const timer = setInterval(() => { ticks += 1 }, 10)
    const started = Date.now()
    try {
      // The child spawns a grandchild that would outlive a direct-pid kill.
      const res = await runBounded(node, ['-e', `
        require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'inherit' })
        setTimeout(() => {}, 60000)
      `], { timeoutMs: 300, killGraceMs: 200 })
      expect(res.timedOut).toBe(true)
      expect(res.code).toBeNull()
    } finally { clearInterval(timer) }
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(ticks).toBeGreaterThan(10)
  })

  it('reports a spawn failure instead of throwing', async () => {
    const res = await runBounded('/definitely/not/a/binary', [], { timeoutMs: 1_000 })
    expect(res.error).toBeInstanceOf(Error)
    expect(res.code).toBeNull()
  })

  it('caps buffered output at maxBuffer', async () => {
    const res = await runBounded(node, ['-e', 'process.stdout.write("x".repeat(10000))'], { timeoutMs: 10_000, maxBuffer: 100 })
    expect(res.stdout.length).toBe(100)
  })

  it('runs through the shell when asked', async () => {
    const res = await runBounded(`"${node}" -e "process.stdout.write('sh')"`, [], { timeoutMs: 10_000, shell: true })
    expect(res.stdout).toBe('sh')
  })
})

describe('execBounded', () => {
  it('resolves stdout on success', async () => {
    await expect(execBounded(node, ['-e', 'process.stdout.write("ok")'], { timeoutMs: 10_000 })).resolves.toBe('ok')
  })

  it('rejects with a BoundedExecError carrying status and stderr on non-zero exit', async () => {
    const err = await execBounded(node, ['-e', 'process.stderr.write("nope"); process.exit(2)'], { timeoutMs: 10_000 }).catch((e) => e)
    expect(err).toBeInstanceOf(BoundedExecError)
    expect(err.status).toBe(2)
    expect(err.stderr).toBe('nope')
    expect(err.message).toContain('nope')
  })

  it('rejects on timeout', async () => {
    const err = await execBounded(node, ['-e', 'setTimeout(()=>{}, 60000)'], { timeoutMs: 200, killGraceMs: 100 }).catch((e) => e)
    expect(err).toBeInstanceOf(BoundedExecError)
    expect(err.timedOut).toBe(true)
    expect(err.message).toMatch(/timed out/)
  })
})
