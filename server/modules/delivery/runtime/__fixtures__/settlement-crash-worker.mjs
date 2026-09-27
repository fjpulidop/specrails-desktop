// Real host-process crash fixture: no production fault-injection switch.
import { appendFileSync, writeSync } from 'node:fs'
import path from 'node:path'
import { initDb } from '../../../../db.ts'
import { defaultGitRunner } from '../../../../worktree-manager.ts'
import { reattachIsolatedSettlement } from '../rail-isolated-launch.ts'

const [database, root, runId, cutWorktree] = process.argv.slice(2)
const db = initDb(database)
try {
  await reattachIsolatedSettlement({
    db, project: { id: 'p', path: root }, broadcast() {},
    onLoopRunFinished() { appendFileSync(path.join(root, 'premature-finish'), 'finished\n') },
  }, 'group', runId, {
    git: { async run(args, cwd) {
      if (cwd === cutWorktree && args[0] === 'branch') {
        writeSync(2, 'desktop-settlement-crash:between-repositories\n')
        process.kill(process.pid, 'SIGKILL')
        throw new Error('SIGKILL did not terminate the host')
      }
      return defaultGitRunner.run(args, cwd)
    } },
    recordProvenance(input) { appendFileSync(path.join(root, 'child-provenance.jsonl'), JSON.stringify({ runId: input.runId, repoDir: input.repoDir }) + '\n') },
  })
  throw new Error('Settlement unexpectedly passed the crash boundary')
} finally { db.close() }
