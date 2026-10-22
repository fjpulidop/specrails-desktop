# Flow: build first, spec later

Flow is a way to build with an agent when you do not know yet exactly what you want. You talk to the agent in your mission, it writes and runs real code in an isolated worktree, and when the result is right you say **This is it**: a rail takes the worktree, derives the spec and runs the usual verification, review and delivery.

Implement is for delegating work you can already describe. Flow is for discovering it.

## How a Flow starts

You never have to ask for Flow by name. When you describe something exploratory or visual ("I want to try…", "I don't know how it should look"), the mission shows a card with two paths:

- **Flow** — build it together now; the spec comes at the end.
- **Spec + Implement** — agree on a spec first, then delegate it to a rail.

The card marks the recommended path and explains why in one sentence. The other path is always one click away, and the agent will not insist if you pick it or press **Not now**.

Choosing Flow opens a confirmation: Specrails creates an isolated worktree where the agent can write code, and your main branch is not touched. Press **Start Flow**. A placeholder spec appears on the board with the **In Flow** label (click it to jump back to the mission).

If your Specrails Core cannot run Flow yet, Start is disabled and the card lists what is missing — usually an update of Specrails Core fixes it.

## While you are in Flow

The conversation changes look (a thin accent along the edge) and a bar appears above the composer:

- the worktree **branch**, the **files changed** with lines added and removed, and the **real cost** of the Flow so far as billed by the provider. It shows `—` until a turn has a reported cost, and never an estimate;
- **View changes** lists every changed file with its status and +/−;
- **Pause** stops the agent and keeps the worktree and the spec. The mission then shows **Resume Flow**;
- **Discard** deletes the worktree, its branch and the placeholder spec, after a confirmation;
- **This is it** — the main action, below.

You can write while the agent is working: in Flow your message **interrupts** the current step (the send button turns into a lightning bolt) and the agent continues with your new information right away. The git strip under the composer shows the worktree branch.

## Try the app

The Flow agent runs the typecheck and the tests itself to check its work. When there is something to try, it asks with three choices: **Start the app**, **Start and expose on the local network** or **Not now**. Exposing it lets you open the app from a phone on the same Wi-Fi or VPN, and anyone on that network can reach it.

Once the app is listening, the agent gives you its addresses as links and the Flow bar shows **Preview** with a green dot: it opens the app in your browser. Its menu has the network address and **Stop app**. The app runs in the Flow worktree, never in your main checkout, and Specrails stops it when you pause, discard or hand off the Flow.

## This is it

When you are happy with the result, press **This is it**. The Flow bar and the visual treatment go away and the usual rail launch card appears with the **Flow → Spec** loop preselected and a free rail chosen for you. Adjust the engine, model or effort if you like and press **Launch**. If the review limit or a budget is reached, the card says so and does not launch. **Not yet** takes you back to the Flow.

The rail derives the Specrails spec and the OpenSpec change from what you built, verifies and reviews it, and the delivery card appears in the mission as with any run.

## Good to know

- Flow writes only inside its worktree. Missions stay read-only outside Flow.
- One Flow per mission at a time. Pausing survives an app restart.
- If the worktree disappears, the Flow is marked **needs review** and nothing is deleted.
- Jira receives nothing while you are in Flow or if you discard it.
- Flow cost appears in Analytics as its own surface, **Flow**, and inside the agent missions block.
