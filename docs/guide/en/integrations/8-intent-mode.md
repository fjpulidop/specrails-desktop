# Intent: build first, spec later {#intent-mode}

Intent is a way to build with an agent when you do not know yet exactly what you want. You talk to the agent in your mission, it writes and runs real code on its own Intent branch (a separate copy of your project), and when the result is right you press **Hand off**: a rail takes your changes, derives the spec and runs the usual verification, review and delivery.

Implement is for delegating work you can already describe. Intent is for discovering it.

## How an Intent session starts

You never have to ask for Intent by name. When you describe something exploratory or visual ("I want to try…", "I don't know how it should look"), the mission shows a card with two paths:

- **Intent**: build it together now; the spec comes at the end.
- **Spec + Implement**: agree on a spec first, then delegate it to a rail.

Both paths carry the same weight and always appear in the same order: neither is recommended, you choose. Under **Why the agent asked** the agent says in one sentence what made it ask, and it will not insist whichever path you pick or if you press **Not now**.

Choosing Intent opens a confirmation: Specrails makes a separate copy of the project on its own Intent branch, where the agent can write code, and your main branch is not touched. Press **Start Intent**. A placeholder spec appears on the board with the **In Intent** label (click it to jump back to the mission).

If your Specrails Core cannot run Intent yet, Start is disabled and the card lists what is missing. Usually an update of Specrails Core fixes it.

## Start an Intent session from a spec you already have

Any spec can be built in Intent, not only a new idea. Intent and Implement stay two equal ways to work on it:

- on the board, right-click a spec and choose **Start in Intent** (next to dragging it onto a rail); in the spec detail, **Start in Intent** sits next to **Move to Rail**;
- in a mission, when you ask to implement a spec without naming a rail, the agent shows the same two-path card for that spec: **Intent** works on it with you, **Spec + Implement** launches it on a rail;
- a rail-launch card for one spec also offers **Start in Intent** next to its launch.

The spec itself goes **In Intent**: no placeholder is created, and the agent's first turn receives the spec (its acceptance criteria, Contract Layer, out-of-scope list and open addenda). Started from the board, the Intent opens in the spec's own mission, or in a new mission named after the spec. In a project with several Git repositories, when the spec does not name exactly one of them, a small dialog first asks where the Intent runs: only the Git repositories are listed, the spec's own repository (or else the primary) is preselected, and the arrow keys change the choice. **Start in Intent** is disabled, with the reason on hover, when the spec is already in Intent, done or cancelled, sits on a rail, or Intent is not available.

**Discard** gives the spec back exactly as it was, with its previous status: your spec is never deleted. When the Intent is delivered, the spec is rewritten from what was built, and its original text is first kept as a comment, **Original spec before Intent**, so nothing is lost. A spec already linked to Jira updates that same issue and moves it to the status mapped for review; no second issue is created.

## While you are in Intent

Intent mode is named where you look, in its own Intent color: the composer shows a **Intent** chip next to the autonomy chip and the hint *Tell the agent what to change in this Intent…*; the mission title reads **In Intent**, and so does its row in the mission list. The conversation marks where you entered and left Intent, and the agent's replies written in Intent carry a small **Intent** mark next to their time.

The strip just above the composer shows the Intent in one short row: its status, **Intent · 7 files**, **Pause Intent** and the main action, **Hand off**. When an action is unavailable (the Intent is still saving, another action runs), hovering it says why. Open the row with its chevron, like any other run, to see the rest:

- the **branch** (click to copy its name), the **changes** with lines added and removed (click to list every changed file with its status and +/−), and the **cost so far** as billed by the provider. It shows `—` until a turn has a reported cost, and never an estimate; a `*` marks a total that leaves out unpriced turns, with a note saying how many;
- **Preview** while the Intent's app runs (see below);
- **Discard**, set apart, deletes the Intent's changes, its branch and the placeholder spec. The confirmation lists what you lose: the changed files with their +/−, the branch and the spec.

**Pause Intent** stops the agent and keeps your changes and the spec. The row then shows **Resume Intent**.

You can write while the agent is working: in Intent your message **interrupts** the current step (the send button turns into a lightning bolt) and the agent continues with your new information right away. While the Intent is open, the git strip under the composer steps aside: the Intent's panel already shows its branch.

## Try the app

The Intent agent runs the typecheck and the tests itself to check its work. When there is something to try, it asks with three choices: **Start the app**, **Start and expose on the local network** or **Not now**. Exposing it lets you open the app from a phone on the same Wi-Fi or VPN, and anyone on that network can reach it.

Once the app is listening, the agent gives you its addresses as links and the Intent's panel shows **Preview** with a green dot: it opens the app in your browser. Its menu has the network address and **Stop app**. The app runs from the Intent's copy, never from your main checkout, and Specrails stops it when you pause, discard or hand off the Intent.

## Hand off {#intent-hand-off}

When you are happy with the result, press **Hand off**. The row reads **Ready to turn into a PR** and opens one line above it: *Rail 2 will turn your 7 changed files into a reviewed PR. If it fails, your work is safe.* Press **Launch**, or **Not yet** to go back to the Intent; **Esc** is the same as **Not yet**; a click elsewhere only folds the line away, and the row keeps **Ready to turn into a PR** with **Launch**. If your conversation's engine cannot run the hand-off on this machine, a note right under the line says so and the rail's default engine is used.

The rail, engine, model and effort are already chosen for you (a free rail and your conversation's engine). To change them, open **Change how**; it also shows what changed. The cost so far is on the main line. Your choices are kept if you press **Not yet** and hand off again later. While the hand-off starts, the strip shows it launching, with no gap, and then follows the run step by step. If the review limit or a budget is reached, the line says so and nothing launches. If the run has not shown after 45 seconds, the strip stops spinning and reads **Still handing off to Rail 2…** with **Refresh**, which checks again and keeps waiting until the run shows.

The rail derives the spec and its spec change from what you built, verifies and reviews it, and the delivery card appears in the mission as with any run.

If the run fails for a technical reason, the work comes back to this Intent on its own, intact: the card says in plain words what failed (the codes stay under **Technical details**) and the agent receives the error and explains it. If the review asks for changes, the card offers **Back to Intent** or **Relaunch**. When the delivery settles, the mission closes the Intent with a summary: the pull request, the spec rewritten from what you built, the archived spec change and the Jira issue when there is one.

## Good to know

- Intent writes only on its own branch. Missions stay read-only outside Intent.
- One Intent per mission at a time. Pausing survives an app restart.
- If the Intent's copy of the project disappears, the Intent is marked **needs review** (for your information, nothing to decide) and nothing is deleted.
- The strip never swaps the run you are looking at. If another run starts needing you meanwhile, its name in the strip's switcher says **needs you**.
- Jira receives nothing while you are in Intent or if you discard it.
- Intent cost appears in Analytics as its own surface, **Intent**, and inside the agent missions block.
