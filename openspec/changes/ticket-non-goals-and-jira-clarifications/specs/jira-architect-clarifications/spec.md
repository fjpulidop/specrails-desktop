## ADDED Requirements

### Requirement: Architect clarifications are posted to Jira on request

With the project setting `jiraPostClarifications` enabled (default off) and an active Jira connection, Desktop SHALL post the questions a run paused on, or the assumptions it proceeded with, as one comment on each linked issue through the durable outbox, at most once per run, ticket and record content. A Core without `architectClarifications: 1` writes no record, so nothing SHALL be posted.

#### Scenario: Run pauses with a high-impact question
- **WHEN** the architect pauses a run whose spec is linked to `ACME-7`
- **THEN** one comment listing the question is enqueued for `ACME-7`, and a second read of the same record enqueues nothing

#### Scenario: Setting off
- **WHEN** the setting is off
- **THEN** no comment is enqueued

### Requirement: Jira replies become clarification addenda

A human comment posted on the issue after a Specrails clarifications comment SHALL be imported once as a spec addendum of kind `clarification`, for 14 days after the comment. Specrails' own comments SHALL be ignored.

#### Scenario: Reply imported once
- **WHEN** a stakeholder replies to the clarifications comment and the poll runs twice
- **THEN** the spec has exactly one open `clarification` addendum with the reply text
