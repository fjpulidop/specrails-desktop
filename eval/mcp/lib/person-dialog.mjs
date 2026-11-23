#!/usr/bin/env node
// The simulated person answering a client's own forms (Claude Code's `Elicitation` hook, run from the scenario's
// temp cwd `.claude/settings.json`): a confirmation gets the same yes/no the scenario's person gives in the chat; a
// choice form (a select plus "Something else — write it") gets the option they want, picked by id from the
// keyboard, or their one free-text answer (person.formAnswer).
// argv: <accept|decline|cancel> <log.jsonl> [person.json]. Reads the hook input on stdin, logs it, prints the decision.
import fs from 'node:fs'
import { formAnswer } from './person.mjs'

const [answer = 'cancel', logFile, personFile] = process.argv.slice(2)
let person = {}
try {
  const raw = personFile ? JSON.parse(fs.readFileSync(personFile, 'utf8')) : {}
  person = { ...raw, ...(raw.pick ? { pick: new RegExp(raw.pick, 'i') } : {}) }
} catch { person = {} }
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', d => { input += d })
process.stdin.on('end', () => {
  let event = null
  try { event = JSON.parse(input) } catch { event = null }
  const schema = event?.requested_schema ?? event?.requestedSchema ?? null
  const props = schema?.properties ?? {}
  const choiceForm = Boolean(props.choice || props.other)
  const reply = choiceForm ? formAnswer(person, { requestedSchema: schema }) : formAnswer({}, { requestedSchema: schema ?? { properties: { confirm: {} } } }, { confirm: answer })
  if (logFile) try { fs.appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), kind: choiceForm ? 'choice' : 'confirm', answer: reply, server: event?.mcp_server_name ?? null, message: event?.message ?? null }) + '\n') } catch { /* best effort */ }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Elicitation', ...reply } }) + '\n')
})
