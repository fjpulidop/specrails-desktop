# Run questions: one card, every surface

A run that needs the person (a question or an approval) shows **one question card**,
identical in the inbox, the live board, the mission card, the run window, Settings ▸
saved executions and the companion's answer sheet. The card is answered where it is.

## The card (`RunQuestion`)

Built on the server by [`server/shared/run-question.ts`](../../server/shared/run-question.ts)
from Core's pending human interrupts, mirrored in the client by
[`components/run-question/run-question.ts`](../../client/src/components/run-question/run-question.ts)
and drawn by [`RunQuestionCard`](../../client/src/components/run-question/RunQuestionCard.tsx).

```ts
interface RunQuestion {
  interruptId: string                 // Core's interrupt id ('' for a legacy loop pause)
  kind: 'question' | 'approval'
  asker: 'planner' | 'developer' | 'fixer' | 'reviewer' | 'install' | 'run'
  text: string                        // the question, never a node id or path
  why?: string
  detail?: string                     // verbatim, e.g. an exact command
  options: { id: string; label: string; meaning?: string; detail?: string }[]
  recommended?: string                // an option id
  endsRun: string[]                   // option ids after which the run ends
  mayEndRun: boolean                  // a planner "not here", an endsRun choice, a rejection
  canReject: boolean                  // an approval Core lets the person reject with a reason
  install?: { tool: string; command: string } // a machine-wide install (Core machineInstalls)
}
```

Where it travels: `GET /jobs/:id` (`job.question`, also for a run retained over a restart),
`job.interactive` and `loop.run_paused` (`question`; `question: null` once answered),
inbox items of kind `question` (`question`, and `detail` is the short question the
notification shows), live-board cards (`question`), `GET /agent-runtime/runs/:id`
(`question`) and the companion's `GET /v1/projects/:pid/inbox/runs/:runId/question` (`card`).

## Core capability

A Core advertising `questionOptions: 1` (contract 5.17, additive) adds `text`, `asker`,
`why`, `options`, `recommended`, `endsRun` and `detail` to a question interrupt and
`rejectable: true` to an approval; `prompt` still reads on its own for older hosts.
Install questions (`machineInstalls: 1`) use the same `options` with `data.kind ===
'machine-install'`. The Implement recipe asks the planner for choices
(`questionOptions`, `recommendedOption`, `questionWhy`, always ending with `not-here`)
and routes a rejected approval to the `rejected` end only on such a Core. Role
decisions get their choices from Core itself. An older Core keeps plain-text questions
and Approve only; the card renders them with a text box.

## Answers

`POST /jobs/:id/messages` while the run is paused in this process:
`{ text, interruptId, optionId? }`, `{ text: '', interruptId, approve: true }` or
`{ text: reason, interruptId, reject: true }`. A run retained across a restart is resumed
with the same controls on `POST /loop-runs/:id/resume` (`{ answer, interruptId, optionId? }`,
`{ approve: [id] }`, `{ reject: id, reason }`). Core receives `--answer … --option <id>` or
`--reject <id> --reason …`. An install question's choice (`install` / `self`) is turned
into Core's answer by the host ([machine-installs](../../server/modules/machine-installs/README.md)).

## Instant update and vocabulary

The card confirms in place ("Answer sent — the run continues") and announces the answer
to every surface of the window (`announceRunQuestionAnswered`); other windows follow
`job.interactive` / `loop.run_resumed`. Whether a run needs the person comes from one place, the run's hold
([`loop-run-hold.ts`](../../server/modules/loops/runtime/loop-run-hold.ts)): `question` and
`approval` need you (the inbox lists them as questions with the card); `provider_limit` and
`budget` are pauses; `restart`, `interrupted` and `paused` wait for Resume and read like the run
window (inbox detail `held:<kind>[:<step>]`). The notice is "Needs you"; actions are "Answer",
"Approve" and "Reject" in every locale. A provider limit, a budget or a restart pause is
never announced as needing the person, and the question is never under "Failure reasons".
