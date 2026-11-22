#!/usr/bin/env node
// The simulated person answering a client's own confirmation dialog (Claude Code's `Elicitation` hook, run from
// the scenario's temp cwd `.claude/settings.json`): the same yes/no the scenario's person gives in the chat.
// argv: <accept|decline|cancel> <log.jsonl>. Reads the hook input on stdin, logs it, prints the hook decision.
import fs from 'node:fs'

const [answer = 'cancel', logFile] = process.argv.slice(2)
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', d => { input += d })
process.stdin.on('end', () => {
  let event = null
  try { event = JSON.parse(input) } catch { event = null }
  if (logFile) try { fs.appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), answer, server: event?.mcp_server_name ?? null, message: event?.message ?? null }) + '\n') } catch { /* best effort */ }
  const output = answer === 'accept' ? { hookEventName: 'Elicitation', action: 'accept', content: { confirm: true } }
    : answer === 'decline' ? { hookEventName: 'Elicitation', action: 'decline' }
      : { hookEventName: 'Elicitation', action: 'cancel' }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: output }) + '\n')
})
