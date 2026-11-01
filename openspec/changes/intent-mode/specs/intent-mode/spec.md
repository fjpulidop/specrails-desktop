## ADDED Requirements

### Requirement: Flow is presented as Intent mode

Everything a person reads SHALL call the interactive mode **Intent**. That covers UI copy in the eight locales, the board label, the mission header, the composer chip, the command palette, notifications, user guides, internal docs and module READMEs. "Intent" SHALL stay untranslated as a product term, as "Flow" was. Source paths and names SHALL follow: `server/modules/intent`, `client/src/features/intent`, `Intent*` components, types and functions. Architecture tests and the boundary manifests SHALL declare the renamed modules.

#### Scenario: Board label

- **WHEN** a spec is in an active or paused Intent session
- **THEN** its card SHALL show the label "In Intent" in the person's locale

#### Scenario: No visible Flow

- **WHEN** the UI copy in any locale is searched for the word "Flow" as the mode name
- **THEN** no result SHALL be found

### Requirement: Persisted and cross-repository identifiers are frozen

The rename SHALL NOT change any persisted or cross-repository identifier. This covers:

- the `flow_sessions` and `flow_effects` tables and their columns
- accounting `surface = 'flow'`
- the loop id `factory:flow-spec`
- spec `source: 'flow'` and `metadata.flow`
- the Core capability `flowSessions` and Core session ids `flow:<id>`
- the `flow-offer` and other `flow-*` fence blocks
- the `flow.state` WebSocket event
- the error codes `flow_*`

The `/api/projects/:projectId/intent/*` routes SHALL be aliases of `/flow/*`, with identical handlers and response shapes. MCP tools SHALL accept the intent names, and the previous names SHALL keep working as aliases. Shipped migrations SHALL NOT be rewritten.

#### Scenario: Route alias

- **WHEN** a client calls `POST /api/projects/:id/intent` with a body valid for `POST /flow`
- **THEN** the response SHALL equal what `/flow` returns

#### Scenario: Old conversations

- **WHEN** a conversation stored before this change renders a `flow-offer` block
- **THEN** it SHALL render as the Intent offer card

#### Scenario: Analytics history

- **WHEN** usage is aggregated across dates before and after this change
- **THEN** Intent sessions SHALL be reported under one surface, presented as "Intent"

### Requirement: Explore and Delegate are equal paths from an intent

Wherever an intent can move forward, the system SHALL offer two paths with equal visual weight and no "recommended" mark. The places are the mission's intent card, a spec with an intent, and the rail-launch card of one spec:

- **Explore**: start an Intent session.
- **Delegate**: implement on a rail.

#### Scenario: Intent card actions

- **WHEN** the person has answered an `intent-draft` in a mission
- **THEN** the card SHALL offer Explore and Delegate with equal weight

### Requirement: An Intent session starts from the intent

Starting an Intent session from an intent SHALL create the placeholder spec with the intent attached. The title SHALL come from the problem. Starting from an existing spec with an intent SHALL keep that intent. The first turn's briefing SHALL contain the rendered intent before the spec seed, marked as the source of truth for the outcome, and SHALL stay within the existing briefing bound. A session started from a free idea, with no intent, SHALL behave as before.

#### Scenario: Explore from a fresh intent

- **WHEN** the person chooses Explore on an answered intent card
- **THEN** an Intent session SHALL start with a placeholder spec carrying the intent, and the first turn SHALL receive it

### Requirement: Settlement keeps the intent and records answers

At settlement, the spec rewrite SHALL keep the spec's intent unchanged except for the open questions. The rewrite SHALL be asked to answer the open questions from what was built: each answered question SHALL keep its question text and gain an answer, and questions it cannot answer SHALL stay unanswered. The rewritten spec SHALL NOT contradict the intent's constraints. `intent.md` SHALL be materialised in the derived change as for any delivery.

#### Scenario: An answered open question

- **WHEN** an Intent session whose intent asks "Does it need offline support?" settles and the built code answers it
- **THEN** the spec's intent SHALL keep the problem, outcome and constraints and SHALL record the answer under that question
