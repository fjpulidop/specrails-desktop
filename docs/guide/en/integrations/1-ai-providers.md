<!-- guide-revision: mission-first-v1 -->

# Connect an AI provider

Specrails coordinates your authenticated Claude or Codex CLI. Provider installation, account access and model billing remain separate from the application.

## Connect and verify

Install the desired CLI using its official instructions and sign in with the account you intend to use. Check availability in Specrails, then select a supported model and settings for the mission or rail.

A successful discovery check does not guarantee quota or network availability for the next call. Resolve authentication and compatibility errors before retrying an implementation.

## Understand the boundary

The app keeps project records locally, while model requests and configured integrations may send context outside your machine. Choose which references and attachments to provide with that in mind.

Capabilities differ: reasoning controls, structured responses, subagents and active-turn steering are not interchangeable across providers. See [provider execution settings](/docs/pipeline-picking-an-engine-per-rail) and [steering](/docs/missions-steering-and-receipts).
