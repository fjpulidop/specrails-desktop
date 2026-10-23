# Flow: build first, spec later

Flow is a way to build with an agent when you do not know yet exactly what you want. You talk to the agent in your mission, it writes and runs real code on its own Flow branch (a separate copy of your project), and when the result is right you press **Hand off**: a rail takes your changes, derives the spec and runs the usual verification, review and delivery.

Implement is for delegating work you can already describe. Flow is for discovering it.

## How a Flow starts

You never have to ask for Flow by name. When you describe something exploratory or visual ("I want to try…", "I don't know how it should look"), the mission shows a card with two paths:

- **Flow**: build it together now; the spec comes at the end.
- **Spec + Implement**: agree on a spec first, then delegate it to a rail.

Both paths carry the same weight and always appear in the same order: neither is recommended, you choose. Under **Why the agent asked** the agent says in one sentence what made it ask, and it will not insist whichever path you pick or if you press **Not now**.

Choosing Flow opens a confirmation: Specrails makes a separate copy of the project on its own Flow branch, where the agent can write code, and your main branch is not touched. Press **Start Flow**. A placeholder spec appears on the board with the **In Flow** label (click it to jump back to the mission).

If your Specrails Core cannot run Flow yet, Start is disabled and the card lists what is missing. Usually an update of Specrails Core fixes it.

## While you are in Flow

Flow mode is named where you look, in its own Flow color: the composer shows a **Flow** chip next to the autonomy chip, a thin line along its top and the hint *Tell the agent what to change in this Flow…*; the mission title reads **In Flow**, and so does its row in the mission list. The conversation marks where you entered and left Flow, and the agent's replies written in Flow carry a small **Flow** mark next to their time.

The strip just above the composer shows the Flow in one short row: its status, **Flow · 7 files**, **Pause** and the main action, **Hand off**. When an action is unavailable (the Flow is still saving, another action runs), hovering it says why. Open the row with its chevron, like any other run, to see the rest:

- the **branch** (click to copy its name), the **changes** with lines added and removed (click to list every changed file with its status and +/−), and the **cost so far** as billed by the provider. It shows `—` until a turn has a reported cost, and never an estimate; a `*` marks a total that leaves out unpriced turns, with a note saying how many;
- **Preview** while the Flow's app runs (see below);
- **Discard**, set apart, deletes the Flow's changes, its branch and the placeholder spec. The confirmation lists what you lose: the changed files with their +/−, the branch and the spec.

**Pause** stops the agent and keeps your changes and the spec. The row then shows **Resume Flow**.

You can write while the agent is working: in Flow your message **interrupts** the current step (the send button turns into a lightning bolt) and the agent continues with your new information right away. While the Flow is open, the git strip under the composer steps aside: the Flow's panel already shows its branch.

## Try the app

The Flow agent runs the typecheck and the tests itself to check its work. When there is something to try, it asks with three choices: **Start the app**, **Start and expose on the local network** or **Not now**. Exposing it lets you open the app from a phone on the same Wi-Fi or VPN, and anyone on that network can reach it.

Once the app is listening, the agent gives you its addresses as links and the Flow's panel shows **Preview** with a green dot: it opens the app in your browser. Its menu has the network address and **Stop app**. The app runs from the Flow's copy, never from your main checkout, and Specrails stops it when you pause, discard or hand off the Flow.

## Hand off

When you are happy with the result, press **Hand off**. The row reads **Ready to turn into a PR** and opens one line above it: *Rail 2 will turn your 7 changed files into a reviewed PR. If it fails, your work is safe.* Press **Launch**, or **Not yet** to go back to the Flow.

The rail, engine, model and effort are already chosen for you (a free rail and your conversation's engine). To change them, open **Change how**; it also shows what changed and the cost so far. While the hand-off starts, the strip shows it launching, with no gap, and then follows the run step by step. If the review limit or a budget is reached, the line says so and nothing launches. The strip's own **Launch** never launches by itself: it brings the line back with the focus on Launch, so you always confirm there.

The rail derives the spec and its spec change from what you built, verifies and reviews it, and the delivery card appears in the mission as with any run.

If the run fails for a technical reason, the work comes back to this Flow on its own, intact: the card says in plain words what failed (the codes stay under **Technical details**) and the agent receives the error and explains it. If the review asks for changes, the card offers **Back to Flow** or **Relaunch**. When the delivery settles, the mission closes the Flow with a summary: the pull request, the spec rewritten from what you built, the archived spec change and the Jira issue when there is one.

## Good to know

- Flow writes only on its own branch. Missions stay read-only outside Flow.
- One Flow per mission at a time. Pausing survives an app restart.
- If the Flow's copy of the project disappears, the Flow is marked **needs review** (for your information, nothing to decide) and nothing is deleted.
- The strip never swaps the run you are looking at. If another run starts needing you meanwhile, its name in the strip's switcher says **needs you**.
- Jira receives nothing while you are in Flow or if you discard it.
- Flow cost appears in Analytics as its own surface, **Flow**, and inside the agent missions block.
