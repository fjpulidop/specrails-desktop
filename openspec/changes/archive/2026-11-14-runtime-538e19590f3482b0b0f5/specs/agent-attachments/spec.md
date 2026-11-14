# Spec Delta

## MODIFIED Requirements

### Requirement: Agent attachment endpoints and storage

The server SHALL expose `POST/GET/GET :attachmentId/DELETE /api/agent/conversations/:id/attachments`, gated by the agent-chat feature flag, mirroring the ticket attachment endpoints (multer single `file`, 25 MB cap). Uploads SHALL be accepted when they are a rich type (image, PDF, Excel) or readable text, as defined by the `readable-text-attachments` capability, instead of by a MIME allowlist. Files SHALL be stored under a distinct root `~/.specrails/agent/<conversationId>/attachments/` with path-traversal guards on the conversation id. Deleting a conversation SHALL remove its attachment directory.

#### Scenario: Upload returns the stored attachment
- **WHEN** a valid file is POSTed to a known conversation
- **THEN** the response is `201` with the attachment metadata and the file is stored under the agent root

#### Scenario: Oversized or wrong-type rejected
- **WHEN** a file exceeds 25 MB or is neither a rich type nor readable text
- **THEN** the endpoint responds `400`, names the reason, and stores nothing

#### Scenario: Traversal in conversation id rejected
- **WHEN** the conversation id contains path-traversal segments
- **THEN** the request is rejected and no path escapes the agent root

#### Scenario: Cleanup on conversation delete
- **WHEN** a conversation is deleted
- **THEN** its `~/.specrails/agent/<id>/` directory is removed

#### Scenario: Routes disabled when feature off
- **WHEN** `SPECRAILS_AGENT_CHAT` is false
- **THEN** the attachment routes respond `404`
