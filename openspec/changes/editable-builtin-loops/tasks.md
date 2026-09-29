## 1. Persistence
- [x] 1.1 Desktop migration 31: `builtin_id` (unique partial index), `builtin_default_hash`, `published_graph`; backfill published snapshots; column-guarded replay test
- [x] 1.2 `publishLoop` writes `published_graph`; store helpers to seed, restore and read built-in rows

## 2. Seeding and resolution
- [x] 2.1 `builtin-loops.ts`: seed at loops-route registration and on `GET /loops` / `GET /loops/factory`; refresh unedited rows only when Core capabilities are known; Freestyle gated by provider capability
- [x] 2.2 `resolveBuiltinLoop`: edited Published → graph; edited Draft → last Published snapshot; unedited/missing → code default; aliases resolve to the canonical row
- [x] 2.3 Rails launch uses the resolution and applies graph validation and `assertEngineSupport` to edited built-ins

## 3. API
- [x] 3.1 `PUT` allowed on a running built-in (runs clone their graph at launch; test in loop-run-manager)
- [x] 3.2 `DELETE` / `unpublish` of a built-in → `409 builtin_loop`; `POST /loops/:id/restore-builtin`
- [x] 3.3 `POST /loops/factory/:id/fork` duplicates the built-in's current content; `GET /loops/factory` overlays row name/description/effective graph
- [x] 3.4 MCP `specrails_loops`: `restore_builtin`, updated descriptions; operator prompt and MCP guide mention in-place editing

## 4. Client
- [x] 4.1 Loops page: built-in section of editable cards (badge, Edit, Duplicate, Publish when Draft, Restore original when edited; no Delete/Fork)
- [x] 4.2 Builder: in-place note and Restore original with confirmation
- [x] 4.3 Rail picker: built-ins listed once (renamed built-ins show their row name)
- [x] 4.4 Agent-chat loop refs read the stored row, then `factoryLoops`; dashboard adopts UUID loop ids
- [x] 4.5 i18n in 8 locales; remove unused `actions.fork` and `automaticOnly`

## 5. Documentation
- [x] 5.1 Loop builder and rails guides (8 locales), running-pipelines, companion contract, loops module README
