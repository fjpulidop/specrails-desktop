## ADDED Requirements

### Requirement: Injectable upload transport

`RichAttachmentEditor` SHALL accept optional `uploadFn` and `onDeleteAttachment` props that override its default project-tickets upload/delete transport, so it can target the agent attachment endpoint (`/api/agent/conversations/:id/attachments`) instead of the project endpoint. When the props are absent, the editor SHALL use the existing project transport unchanged. The `ticketKey` prop SHALL be usable purely as a pill namespace when a project ticket key is not applicable.

#### Scenario: Agent transport used when injected
- **WHEN** `uploadFn` is provided and the user attaches a file
- **THEN** the editor uploads via `uploadFn` and not via the project tickets endpoint

#### Scenario: Delete routed through injected handler
- **WHEN** `onDeleteAttachment` is provided and the user removes a pill
- **THEN** the editor invokes `onDeleteAttachment` with the attachment id

#### Scenario: Default transport preserved
- **WHEN** neither prop is provided
- **THEN** the editor uploads/deletes via the existing project tickets transport exactly as today
