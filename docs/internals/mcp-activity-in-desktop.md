# MCP activity in Desktop

An external MCP client (Claude Code, Codex…) is the vehicle the person drives
Specrails with, so what it does shows in the Specrails window, the way Intent
keeps its own steps in its mission.

## What shows, and where

- **Missions it creates** (`specrails_missions(create)`, `intent_start` without
  a mission) are ordinary missions marked `origin = 'mcp'` with the client's
  name (`origin_client`, migration 42 in `server/desktop-db.ts`). The sidebar
  row carries an `MCP` chip; under "active only" a recently active MCP mission
  (30 min) stays listed even without a turn of its own.
- **Messages it sends** (`specrails_missions(send)`, `surface: 'mcp'`) are stored
  with `agent_messages.surface = 'mcp'` and announced live on
  `agent_input_started`; the bubble reads "via MCP". The agent's reply, tool
  activity and cards are the same as for a message typed in the app.
- **Every change it makes** (any non-read v2 action) is an `mcp-action` system
  row (client, tool, action, outcome, summary, refs, or the error) in the
  mission the session works with. That mission is also the call's origin, so a
  launched run, a delivery decision or a CI repair posts its card there, as for
  a mission's own agent (launch defaults stay the project's: the mission's
  provider/model only carry over for in-app agents).
- Reads leave no trace. Titles set outside a turn broadcast `agent_title`.

## A conversation, not a menu

The MCP client is the person's chat with the mission, so it follows the
mission's own conversation:

- `specrails_missions(create)` with `message` creates the mission and starts it
  in the same call (the send's tier and cost confirmation, forecast from recent
  mission turns); without one, `data.ask` is the single open question to put to
  the person (no menu).
- `intent_start` of a seeded Intent (a spec or stored intent) waits for its
  opening turn like a send and returns what it found (`data.turn.reply`); the
  state's offers are the mission's own choices (its option chips and cards).
- Talking to a mission never asks for a cost confirmation, as typing in the
  app never does: `send`, `ask`, `create` with a goal and answering one of the
  mission's options or restating its draft. Work of its own keeps the
  confirmation (card launches, Intent, CI repair, hand-off, renew). A reply
  arrives whole (up to 16 000 characters), not as an excerpt.
- Fewer round trips (measured on real sessions, where waits were followed by a
  `get` to read the reply): a mission turn and a spec request wait the full
  45 s by default; `specrails_wait(until)` on a mission that finished wakes
  with its reply and open choices (`fired[].data`); `specrails_specs(get,
  options.request)` waits for a running AI result instead of answering
  pending.
- A mission's turn start is journaled (`agent_input_started` / `agent_dequeued`
  → `mission.turn` running), so a wait right after a send never wakes on the
  previous turn's end.
- `get` marks a long message `truncated` (with `chars`); `message`
  (`options.message=<id>`, default the last reply) reads it whole (40 000
  characters).
- Reply, still-working and Intent summaries tell the agent to relay the mission
  in its own words, keep the conversation there and offer a menu only for a
  real decision (never one of its own while the mission works).

## Permission level

A mission starts at the person's default level wherever it is created: the
app, an MCP client, its `MCP · <client>` log mission, Run on a PR
(`missionDefaultTierLevel`, desktop setting `missions.default_tier_level`,
`GET/PATCH /api/agent/mission-defaults`). It is Autonomous until the person
picks a level in the app; that pick becomes the default (the app adopts the
server value at startup). An MCP client never changes a mission's level
(`update` keeps it the person's).

## Which mission

`server/mcp/v2/core/mission-journal.ts`, called from the v2 registry around the
handler of an external session's change (`sessionState.external`, set for
non-in-app sessions in `server/mcp/mcp-server.ts`):

1. `options.mission` (`mission:<id>` or the id) on any call: that mission, and
   it becomes the session's mission for its project.
2. A `specrails_missions` call on a mission (`ref`): that mission.
3. `create` / `intent_start`: the mission they made, after they run.
4. Otherwise the mission bound for the call's project (`project`, the project
   of its `ref`, else the session's), else the client's log mission
   `MCP · <client>` for that project (Home without one): the one still in use
   (not archived or deleted, `findMcpLogMission`), so a reconnecting client
   (an app restart opens a new MCP session) keeps logging there; a new one
   only when there is none.

The binding lives in the MCP session (`journalMissions`, per project) and only
follows live missions: a deleted one is replaced on the next change. In-app
mission agents (an agent capability) are never journaled: they already act in
their own mission with their own cards.

## Not covered

Tool calls the mission agent makes during a turn are shown live but are not
stored as messages (they reach the agent actions audit); after a reload the
transcript keeps the messages, cards and `mcp-action` rows, not the tool
activity log.

Tests: `server/mcp/v2/core/mission-journal.test.ts`, `server/agent-chat.test.ts`
(message surface), `client/.../AgentMcpActionLine.test.tsx`.
