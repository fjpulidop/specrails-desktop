## ADDED Requirements

### Requirement: Per-loop economics aggregation
The system SHALL aggregate, per loop (`loop_id` and name) over a period, the
parent deliveries that reached review: delivered, merged, discarded, superseded
and still-on-review counts, discard rate, cost per delivery, time to decision
and to merge, review and fixer rounds per delivery, and escaped defects.
Repository children of a grouped delivery SHALL count once through their parent.

#### Scenario: Delivered counts and discard rate
- **WHEN** a loop has three reviewed deliveries in the period, one merged and one discarded
- **THEN** it reports `delivered: 3`, `merged: 1`, `discarded: 1` and `discardRate` of one third

#### Scenario: Never-reviewable rows are excluded
- **WHEN** a delivery failed its implementation or is still building
- **THEN** it does not count as delivered and its cost is not averaged

### Requirement: Cost is never manufactured
Cost per delivery SHALL sum the attributed AI invocations keeping the
provider-reported (authoritative) and pricing-table (estimated) portions
separate. A delivery without any priced invocation SHALL be excluded from the
average and counted as unpriced; when no delivery is priced the average SHALL be
null, never zero.

#### Scenario: Mixed authoritative, estimated and unknown cost
- **WHEN** one delivery has an authoritative $2 invocation, another an estimated $1 invocation and a third only unpriced invocations
- **THEN** the loop reports `avgCostUsd` 1.5, `authoritativeUsd` 2, `estimatedUsd` 1, `estimatedShare` one third and one unpriced delivery

### Requirement: Rework rounds come from loop step events
Review and fixer rounds SHALL be counted from `loop_step` events whose node is
the reviewer or fixer, ignoring automatic stall retries. Deliveries without any
step events SHALL have unknown rounds and SHALL NOT lower the averages.

#### Scenario: Rounds per delivery
- **WHEN** a delivery's runs emitted two reviewer steps and one fixer step and another delivery has no step events
- **THEN** the loop reports 2 review and 1 fixer rounds per measured delivery with one measured delivery

### Requirement: Escaped defects are linked by humans
Tickets SHALL accept optional `metadata.regressionOf` naming the delivery that
introduced the defect, settable from the ticket create and detail modals for
bug-labelled tickets by picking a recent delivery, and clearable with `null`.
The aggregation SHALL count linked tickets per delivery's loop. When no ticket
in the project carries the link, escaped defects SHALL be reported as null.

#### Scenario: Linked regression
- **WHEN** a bug ticket sets `regressionOf` to a merged delivery of loop A
- **THEN** loop A reports one escaped defect and loops without links report zero

#### Scenario: Untracked
- **WHEN** no ticket carries `regressionOf`
- **THEN** every loop reports escaped defects as null ("no data")

#### Scenario: Invalid link
- **WHEN** a client sends a non-string `regressionOf`
- **THEN** the ticket API rejects the request with 400

### Requirement: Placeholder metrics stay nullable
Requirements demonstrated and triage accuracy SHALL be present as nullable
fields that are null until their producers exist, and the UI SHALL show "no data".

#### Scenario: No producers yet
- **WHEN** loop economics is requested
- **THEN** `requirementsDemonstrated` and `triageAccuracy` are null for every loop

### Requirement: Loops without data
Published saved loops without reviewed deliveries in the period SHALL be listed
with `hasData: false`, and the UI SHALL render them as "no data", not zeros.

#### Scenario: Idle loop
- **WHEN** a published loop has no delivery in the period
- **THEN** it appears with `hasData: false` and null metrics

### Requirement: Loop economics exposure
The system SHALL serve `GET /api/projects/:id/analytics/loop-economics` with
period filters, `GET /api/projects/:id/analytics/loop-economics/deliveries` for
the regression picker, MCP `specrails_analytics` action `loop_economics`, and a
Loop economics card on the Analytics page localized in all supported locales.

#### Scenario: API shape
- **WHEN** the endpoint is called with `period=7d`
- **THEN** it returns `period`, `from`, `to`, `sources`, `project` and `byLoop`

#### Scenario: Invalid period
- **WHEN** the endpoint is called with an unknown period or a custom period without bounds
- **THEN** it responds 400
