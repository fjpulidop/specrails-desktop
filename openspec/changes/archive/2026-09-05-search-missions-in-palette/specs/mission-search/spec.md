## ADDED Requirements

### Requirement: Missions are searchable by title and content from the command palette
The ⌘K command palette SHALL render a Missions group whose rows are app-level agent conversations matching the typed query by title OR by the text of their `user`/`assistant` messages. Matching SHALL be case-insensitive, diacritics-insensitive and substring-based (a fragment in the middle of a word matches). With an empty query the group SHALL list the most recent missions (at most 8) ordered by `updated_at` descending. `system`-role message rows SHALL never produce a match.

#### Scenario: Content fragment finds the mission
- **WHEN** a mission contains an assistant message with "the Tetris scoring bug" and the user types "etris"
- **THEN** the Missions group lists that mission with a snippet showing "…the Tetris scoring bug…" and the fragment highlighted

#### Scenario: Diacritics fold
- **WHEN** a mission is titled "Revisar la misión de deploy" and the user types "mision"
- **THEN** the mission is listed as a title match

#### Scenario: System rows are ignored
- **WHEN** the only occurrence of the typed text lives in a `system`-role PR-decision envelope
- **THEN** the mission is not listed

#### Scenario: Empty query shows recents
- **WHEN** the palette opens with an empty input
- **THEN** the Missions group shows the 8 most recently updated missions

### Requirement: Results feel instantaneous through two-phase matching
Title matches SHALL be computed synchronously from the conversations already held in memory and rendered on the same keystroke. Content matches SHALL come from the server search endpoint, requested after a short debounce, with any previous in-flight request aborted; when they arrive they SHALL merge into the same group by conversation id (a content hit enriches the row with its snippet, never duplicates it) without a loading placeholder replacing already-visible rows.

#### Scenario: Title row appears before the server answers
- **WHEN** the user types a fragment of a mission title
- **THEN** that mission's row is visible before the search request completes

#### Scenario: Stale response is discarded
- **WHEN** the user types "tet" then "tetris" before the first request resolves
- **THEN** only the "tetris" results are rendered

### Requirement: Mode-aware ordering and copy
In Agent Mode the Missions group SHALL be the first group in the palette and the input placeholder SHALL announce missions first. In Board mode the Missions group SHALL render after Projects and the existing placeholder SHALL be kept. The palette's shortcut, the title-bar search pill and the Agent-Mode sidebar Search button SHALL keep opening the same palette.

#### Scenario: Agent Mode ordering
- **WHEN** the UI mode is `agent` and the palette opens
- **THEN** the group order is Missions, Projects, Jobs, Navigation

#### Scenario: Board mode ordering
- **WHEN** the UI mode is `kanban` and the palette opens
- **THEN** the group order is Projects, Missions, Jobs, Navigation

### Requirement: Selecting a mission opens it
Activating a mission row SHALL close the palette and make that mission the active conversation via the agent chat context (leaving Builder mode if active). In Board mode it SHALL additionally open the floating agent panel on that mission.

#### Scenario: Enter in Agent Mode
- **WHEN** the user presses Enter on a mission row in Agent Mode
- **THEN** the palette closes and the mission surface shows that conversation

#### Scenario: Enter in Board mode
- **WHEN** the user presses Enter on a mission row in Board mode
- **THEN** the palette closes and the floating agent panel opens showing that conversation

### Requirement: Premium row with honest metadata
Each mission row SHALL show the mission title (or the shared untitled fallback), the highlighted snippet for content hits, the pinned project's name (Home when unpinned), a relative timestamp from `updated_at` localized to the UI language, and the live pulse indicator when the mission is currently streaming. The row SHALL NOT display match counts or any figure the server did not return. All copy SHALL exist in the eight locales.

#### Scenario: Row metadata
- **WHEN** a content hit belongs to a streaming mission pinned to project "NeoTetris" updated 3 minutes ago
- **THEN** the row shows the title, the snippet with highlight, "NeoTetris", "3 minutes ago" (localized) and the pulse dot

### Requirement: Server full-text index and search endpoint
`desktop.sqlite` SHALL maintain an FTS5 external-content index over `agent_messages.content` (trigram tokenizer with diacritics removal) synchronized by insert/update/delete triggers, rebuilt once by the migration that introduces it. `GET /api/agent/search?q=<text>&limit=<n>` SHALL return at most `limit` (default 20, max 50) conversations, one row each, carrying the conversation, the match kind (`title` | `content`), and for content hits the best-ranked matching message id plus a bounded snippet with highlight ranges as data (no HTML). Title matches SHALL rank first, then content matches by relevance, then recency. Queries shorter than the tokenizer minimum SHALL still answer through a bounded substring scan. A missing or blank `q` SHALL return 400.

#### Scenario: Index follows writes
- **WHEN** a message is inserted, its content updated, then the message deleted
- **THEN** a search for its text finds the conversation after insert and update and not after delete

#### Scenario: Ranking
- **WHEN** one mission matches by title and another only by content
- **THEN** the title match is returned before the content match

#### Scenario: Short query
- **WHEN** `q` is two characters long
- **THEN** the endpoint answers with matching conversations using the substring fallback

#### Scenario: Blank query rejected
- **WHEN** `q` is missing or whitespace
- **THEN** the endpoint responds 400
