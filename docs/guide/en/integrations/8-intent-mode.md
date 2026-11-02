# Intent: say the problem, not the solution {#intent-mode}

Code is no longer the slow part of building software. Knowing what to build is, and so is checking that it was built right. Intent starts there. You write down the **intent**: the problem, the outcome you want, how you will know it worked, who and what it affects, the limits, and what nobody knows yet. You do not write the solution. Specrails derives the spec from your intent, and you review the spec instead of writing it.

From an intent there are two equal ways forward:

- **Explore**: build it together with an agent in an isolated Intent session (its own branch, a separate copy of your project). When the result is right, a rail derives the spec from what you built.
- **Delegate**: the agent writes the spec from the intent, you review it, and a rail builds it.

Explore is for discovering; Delegate is for building what is already clear. Neither is recommended: you choose.

## The intent

An intent has six parts, and no part for the solution:

| Part | What goes in it |
| --- | --- |
| **Problem** | What is wrong today, for whom, and when it hurts. |
| **Outcome sought** | What is true once it is solved. An optional **hypothesis** reads *We believe … will produce …; we will know when …*. |
| **How we will know** | Observable signals that the outcome happened ("a new user finishes setup in under 2 minutes"). They become acceptance criteria. |
| **Who and what it affects** | People, screens or systems. |
| **Constraints** | Limits any solution must respect. |
| **Open questions** | What nobody knows yet. Agents investigate them instead of guessing. |

If you name a solution ("add a Redis cache"), the intent keeps what it is for ("the API answers in under 200 ms") as the outcome, and your solution becomes a constraint (you require it) or an open question (it is one option).

Every spec can carry an intent. It sits above the description in the spec detail, where you can edit each part; a spec without one shows a compact **Add intent** action. While you edit, **Save intent** is the main button, **Esc** cancels and **⌘/Ctrl+Enter** saves. Every answered open question shows its answer under an **Answer** label, and once none is open the heading reads **Questions · N answered**. A spec whose intent still has open questions shows a small compass mark with their count on the board, in every board view (post-it or row). The intent stays in Specrails, like **Out of scope**, and is never written to Jira.

## Where an intent comes from

- **In a mission (the default).** When you describe work, the agent interviews you like an analyst. It asks about the users, the limits and how you will know it worked, and shows an **Intent** card with every part and two readings of your request. Click a reading to answer, or reply in your own words. While the intent is not agreed, each open question on the card is a button that pre-fills your reply in the composer, and a pill says how many are still open. Once it is agreed, the pill reads **Agreed**, the readings give way to **Reading confirmed**, and the card offers **Explore** and **Delegate** side by side under **How do you want to continue?**; the two paths stay on the card across your own follow-up messages, and a long intent is clamped with **Show the full intent**. The **Start from a problem** chip on the mission home starts this interview. A spec the agent writes from it carries the intent automatically. To skip the intent step for a mission, send `#noframe`; `#frame` turns it back on.
- **In Add Spec.** **Intent** is the first mode and opens by default (marked **Default**). Describe the problem, not the solution; three chips above the editor, **Problem**, **Who it affects** and **How we will know**, insert a line to fill in (*Problem:*, *Who it affects:*, *We will know it worked when:*). Press **Write the intent and a spec**: one AI pass writes the intent and then the spec derived from it, ready for you to review. Quick, Explore and Raw are still there. If the intent cannot be written, you still get the spec, without an intent, and a notice says so; if the generation fails, your text stays in the editor. A **Raw** spec gets no intent now: you can add it later from the spec.

## The intent travels with the work

- Every agent that works on the spec receives the intent first, marked as the source of truth for *why* and *what outcome*, never for *how*. That includes the planner, the developer, the reviewer and the Intent session agent. The reviewer also judges the work against the outcome and the signals.
- When a rail delivers a spec that has an intent, Specrails writes it as `intent.md` into the run's OpenSpec change, next to its proposal, design and tasks. The intent then lives in Git with the code. (A batch run that covers several specs writes none.)

## Explore: start an Intent session

Choose **Explore** on an agreed intent card. A confirmation opens, **Explore with the agent**: Specrails makes a separate copy of the project on its own Intent branch, where the agent can write code, and your main branch is not touched. Press **Start exploring**. A placeholder spec carrying your intent appears on the board with the **In Intent** label (click it to jump back to the mission), and the agent's first turn starts from the intent.

If your Specrails Core cannot run Intent yet, Start is disabled and the card lists what is missing. Usually an update of Specrails Core fixes it.

## Start an Intent session from a spec you already have

Any spec can be built in Intent, not only a new idea. Intent and Implement stay two equal ways to work on it:

- on the board, right-click a spec and choose **Explore with the agent** (next to dragging it onto a rail); in the spec detail, **Explore with the agent** sits next to **Move to rail**;
- in a mission, when you ask to implement a spec without naming a rail, the agent shows a two-path card for that spec under **How do you want to continue?**: **Explore** works on it with you, **Delegate** launches it on a rail;
- a rail-launch card for one spec also offers **Explore with the agent** next to its launch.

All three doors open the same confirmation first: the spec's title, a summary of its intent, the engine that will work and, only in a project with several Git repositories, a **Repository** picker (Git repositories only; the spec's own repository, or else the primary, preselected; the arrow keys change the choice). Nothing starts until you press **Start exploring**; **Cancel** leaves the spec as it was. From the board menu, the spec detail opens with that confirmation on top. When the Intent starts, the mission comes to the front and a toast reads **Exploring spec #N on <branch>** with **Open the Intent mission**. The Intent branch is named after the spec in whole words, up to 48 characters, never cut mid-word (`feat/1-alta-sin-clave-de-api-proyecto`).

The spec itself goes **In Intent**: no placeholder is created, and the agent's first turn receives the spec (its intent first, then its acceptance criteria, Contract Layer, out-of-scope list and open addenda). Started from the board, the Intent opens in the spec's own mission, or in a new mission named after the spec. A spec already in Intent offers **Open the Intent mission** instead, and the post-it card no longer offers **Move to rail**. **Explore with the agent** is disabled, with the reason on hover, when the spec is done or cancelled, sits on a rail, or Intent is not available.

**Discard** gives the spec back exactly as it was, with its previous status: your spec is never deleted. When the Intent is delivered, the spec is rewritten from what was built, and its original text is first kept as a comment, **Original spec before Intent**, so nothing is lost. The intent itself is never rewritten: only its open questions gain the answers the work settled. A spec already linked to Jira updates that same issue and moves it to the status mapped for review; no second issue is created.

## While you are in Intent

Intent mode is named where you look, in its own Intent color: the composer shows a **Intent** chip next to the autonomy chip and the hint *Tell the agent what to change in this Intent…*; the mission title reads **In Intent**, and so does its row in the mission list. The conversation marks where you entered and left Intent, and the agent's replies written in Intent carry a small **Intent** mark next to their time.

The strip just above the composer shows the Intent in one short row: its status, **Exploring · 7 files**, **Pause** and **Hand off**. **Hand off** is always there and becomes the main, filled action once files have changed on the Intent branch; before that, the rail can still derive the spec from your conversation. When an action is unavailable (the Intent is still saving, another action runs), hovering it says why. Open the row with its chevron, like any other run, to see the rest:

- the **branch** (click to copy its name), the **changes** with lines added and removed (click to list every changed file with its status and +/−), and the **cost so far** as billed by the provider. It shows `—` until a turn has a reported cost, and never an estimate; a `*` marks a total that leaves out unpriced turns, with a note saying how many;
- **Preview** while the Intent's app runs (see below);
- **Discard**, set apart, deletes the Intent's changes, its branch and the placeholder spec. The confirmation lists what you lose: the changed files with their +/−, the branch and the spec.

**Pause** stops the agent and keeps your changes and the spec. The row then shows **Resume**.

You can write while the agent is working: in Intent your message **interrupts** the current step (the send button turns into a lightning bolt) and the agent continues with your new information right away. While the Intent is open, the git strip under the composer steps aside: the Intent's panel already shows its branch.

## Try the app

The Intent agent runs the typecheck and the tests itself to check its work. When there is something to try, it asks with three choices: **Start the app**, **Start and expose on the local network** or **Not now**. Exposing it lets you open the app from a phone on the same Wi-Fi or VPN, and anyone on that network can reach it.

Once the app is listening, the agent gives you its addresses as links and the Intent's panel shows **Preview** with a green dot: it opens the app in your browser. Its menu has the network address and **Stop app**. The app runs from the Intent's copy, never from your main checkout, and Specrails stops it when you pause, discard or hand off the Intent.

## Hand off {#intent-hand-off}

When you are happy with the result, press **Hand off**. The row reads **Ready to turn into a PR** and opens one line above it: *Rail 2 will turn your 7 changed files into a reviewed PR. If it fails, your work is safe.* Press **Launch**, or **Not yet** to go back to the Intent; **Esc** is the same as **Not yet**; a click elsewhere only folds the line away, and the row keeps **Ready to turn into a PR** with **Launch**. If your conversation's engine cannot run the hand-off on this machine, a note right under the line says so and the rail's default engine is used.

The rail, engine, model and effort are already chosen for you (a free rail and your conversation's engine). To change them, open **Change how**; it also shows what changed. The cost so far is on the main line. Your choices are kept if you press **Not yet** and hand off again later. While the hand-off starts, the strip shows it launching, with no gap, and then follows the run step by step. If the review limit or a budget is reached, the line says so and nothing launches. If the run has not shown after 45 seconds, the strip stops spinning and reads **Still handing off to Rail 2…** with **Refresh**, which checks again and keeps waiting until the run shows.

The rail derives the spec and its spec change from what you built, verifies and reviews it, and the delivery card appears in the mission as with any run.

If the run fails for a technical reason, the work comes back to this Intent on its own, intact: the card says in plain words what failed (the codes stay under **Technical details**) and the agent receives the error and explains it. If the review asks for changes, the card offers **Back to Intent** or **Relaunch**. As soon as the work is integrated, the mission closes the Intent with a success card named after your spec: how much changed (files, cost, time, branch), how it reached the project (the pull request, or *Integrated locally into main*), the spec rewritten from what you built, the archived spec change, the Jira issue when there is one and the open questions the work answered. It appears right away and fills in while the spec is rewritten. Underneath, **Open the spec**, **View the pull request** and **Start another intent** take you on.

## Good to know

- Intent writes only on its own branch. Missions stay read-only outside Intent.
- One Intent per mission at a time. Pausing survives an app restart.
- If the Intent's copy of the project disappears, the Intent is marked **needs review** (for your information, nothing to decide) and nothing is deleted.
- The strip never swaps the run you are looking at. If another run starts needing you meanwhile, its name in the strip's switcher says **needs you**.
- Jira receives nothing while you are in Intent or if you discard it.
- Intent cost appears in Analytics as its own surface, **Intent**, and inside the agent missions block.
