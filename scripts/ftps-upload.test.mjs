import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ftps-upload.sh')
// The fake curl is a POSIX shell script; release deploys run on ubuntu-latest.
const posix = process.platform !== 'win32'

function fixture(t, failures) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ftps upload '))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const bin = path.join(root, 'bin'), calls = path.join(root, 'calls.log'), installer = path.join(root, 'app-setup.exe')
  fs.mkdirSync(bin)
  fs.writeFileSync(installer, 'installer bytes')
  // Fails the first <failures> calls like a dropped data socket, then succeeds.
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh
echo "$@" >> "${calls}"
n=$(wc -l < "${calls}")
if [ "$n" -le ${failures} ]; then echo '< 426 Connection closed; transfer aborted' >&2; echo 'curl: (56) Recv failure: Connection reset by peer' >&2; exit 56; fi
exit 0
`, { mode: 0o755 })
  const run = (args, env = {}) => spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOST: 'ftp.example.invalid', FTP_USER: 'user', FTP_PASS: 'secret', FTPS_UPLOAD_RETRY_DELAY: '0', ...env },
  })
  const callCount = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').length : 0)
  return { run, installer, callCount, calls }
}

test('retries a dropped FTPS transfer from byte 0 and reports the server replies', { skip: !posix }, t => {
  const { run, installer, callCount, calls } = fixture(t, 2)
  const result = run(['downloads/v1.2.3/', installer])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(callCount(), 3)
  assert.match(result.stderr, /426 Connection closed/)
  assert.match(result.stdout, /Uploaded app-setup\.exe to downloads\/v1\.2\.3\//)
  const args = fs.readFileSync(calls, 'utf8').split('\n')[0]
  for (const flag of ['--ssl-reqd', '--ftp-create-dirs', '-T']) assert.ok(args.includes(flag), flag)
  assert.ok(!args.includes('-C'), 'Never resume a partial upload')
  assert.ok(args.includes('ftp://ftp.example.invalid/downloads/v1.2.3/'))
})

test('fails the release after the bounded number of attempts', { skip: !posix }, t => {
  const { run, installer, callCount } = fixture(t, 99)
  const result = run(['latest/', installer], { FTPS_UPLOAD_ATTEMPTS: '3' })
  assert.equal(result.status, 1)
  assert.equal(callCount(), 3)
  assert.match(result.stderr, /failed after 3 attempts/)
})

test('refuses missing files, empty file lists and missing credentials before connecting', { skip: !posix }, t => {
  const { run, installer, callCount } = fixture(t, 0)
  assert.notEqual(run(['latest/', path.join(path.dirname(installer), 'missing.exe')]).status, 0)
  assert.notEqual(run(['latest/']).status, 0)
  assert.notEqual(run(['latest/', installer], { FTP_PASS: '' }).status, 0)
  assert.equal(callCount(), 0)
})
