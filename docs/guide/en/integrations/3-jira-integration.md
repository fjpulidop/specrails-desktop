# Jira integration

Want your specs to live on a real **Jira board** instead of inside Specrails? The Jira integration backs a project's specs with Jira issues, keeps statuses in sync as rails run, and stays out of the way the rest of the time. Each project syncs with **its own** Jira board.

## How it works (the short version)

Specrails acts as a **sync layer** between Jira and your project. The big idea: your local spec store stays the canonical thing the pipeline reads, and Specrails is responsible for keeping it and Jira in agreement.

- When you launch a rail, Specrails moves the linked Jira issue to **In Progress**.
- When a job finishes, Specrails transitions the issue: on success it moves to your mapped **review** status and only reaches **Done** once the delivery PR is merged or you accept the local result; on failure it goes back to **To Do** with a completion comment that includes the result, run id, cost, duration, and the Jira status change.
- If you ask for follow-up changes while the Jira issue is already in review, Specrails tries to continue the existing open PR branch for that ticket instead of creating a fresh branch. If your Jira review status is not explicitly mapped and still appears locally as **In Progress**, Specrails can still continue the PR when the Jira key matches the open pull request.
- Periodically Specrails **polls** Jira for changes anyone made on the board and reflects them back into your specs.

All write-backs go through a durable, crash-safe outbox, so a momentary Jira hiccup never breaks a job — the update just retries.

## Connecting a board

You connect from a project's **Settings** page (there's also an optional "Configure Jira" step at the end of the Add-Project wizard). The connect wizard walks you through:

1. **Test** — enter your Jira URL and credentials, and Specrails verifies the connection.
2. **Pick a project** — choose which Jira project to sync with.
3. **Status map (optional)** — map your Jira workflow statuses onto Specrails' states if the automatic detection needs a hand (more below).
4. **Connect** — done. Your specs now mirror that board.

### Authentication

This version uses **token-paste** auth — quick, on-device, and with no backend involved:

- **Jira Cloud:** your account email plus an API token.
- **Jira Data Center / Server:** a Personal Access Token (PAT).

Your token is stored **encrypted on your own machine** and never leaves it. The app shows only whether a token is present, never the token itself.

## Status mapping

The trickiest part of any Jira sync is matching *your* workflow to Specrails' simple states (To Do / In Progress / On Review / Done, plus cancel variants). Specrails resolves this in two tiers:

1. **Your explicit status map**, if you set one in the wizard — always wins.
2. **Automatic detection** from each status's category (new / in-progress / done) plus smart matching for cancel and ship-style statuses.

When it needs to move an issue across a workflow that has gated transitions, it finds a valid path step by step and fills in any required fields (like a resolution) along the way. If a status genuinely can't be reached, the operation is parked as a dead-letter and surfaced to you rather than silently failing — you'll see a **degraded** indicator and can retry.

## Hot-swap: turn it on and off safely

The Jira link is **per spec**, captured at the moment you launch a rail — not a global, all-or-nothing switch on the board. That makes it safe to toggle:

- **Enabling or disabling** the integration never re-homes your existing specs.
- **Disconnecting** restores your project to normal local-spec behavior.
- Specs that already have a Jira link keep their write-back; specs that don't are left alone.

So you can experiment freely — flip it on, run a few rails, flip it off — without scrambling your board or your local specs.

## Day-to-day

Once connected, the project's Settings page shows a **connected card** where you can:

- **Sync now** — force an immediate poll instead of waiting for the timer.
- **Retry dead-letters** — re-run any write-backs that got stuck.
- **Hot-swap toggle** — temporarily pause/resume the integration.
- **Disconnect** — cleanly detach the board.

Specs backed by Jira show a **Jira key badge** (like `PROJ-123`) on their card, and clicking through links back to the issue. You'll also get small notifications when a sync completes, when an auth token expires (so you can refresh it), or when the integration enters a degraded state.

## Things to keep in mind

- **Polling, not webhooks.** Because Specrails runs locally, it polls Jira for inbound changes rather than receiving push notifications. Changes appear within the poll interval, not instantly.
- **One board per project.** Different projects can sync with different boards; a single project syncs with exactly one.
- **Last-write-wins on conflicts** for the rare case where two tabs edit the same draft simultaneously.

## Turning it off

If you ever want to fully back out, just **Disconnect** from Settings. Your specs return to local-only behavior, and the Jira metadata simply sits unused — nothing is destroyed.
