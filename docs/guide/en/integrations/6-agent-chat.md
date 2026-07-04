# Operate Specrails by chatting (Agent Chat)

The **Agent Chat** is a copilot that lives *inside* Specrails and can drive the whole app for you. Instead of clicking through projects, specs, rails and analytics, you just ask: *"how many jobs succeeded this week?"*, *"create a spec for social login in the API project"*, *"launch the three highest-priority tickets and tell me when they finish"*. It carries out the work by calling Specrails' own tools — the same ones the [MCP server](./5-mcp-server.md) exposes — while you watch the dashboard update live behind it.

> **Not to be confused with the pipeline agents.** The *Agents* section (Architect → Developer → Reviewer) is about *how a rail implements a spec*. The **Agent Chat** is a single assistant that *operates the app itself*. Different thing, same word.

## Opening it

There's a floating **bubble** at the bottom of the window — click it to open the panel, or press **⌘⇧A** (**Ctrl+Shift+A** on Windows/Linux) from anywhere. The panel is a real window you can move, resize, maximize, and drop back to the bubble; it remembers where you left it.

It's **non-modal on purpose**: the dashboard behind it stays live, so when the agent launches a rail or creates a spec you see it appear in real time — you're not looking at a frozen screen.

## Prerequisite: the MCP server

The Agent Chat drives the app through the embedded **Specrails MCP server**, so that has to be on. If it isn't, the panel opens with a one-click **Enable Specrails MCP** banner — press it and you're ready (no restart). See [Control Specrails from any AI](./5-mcp-server.md) for the details; nothing is installed, it's all local to your machine.

## Choosing what it works on

The header has a **project selector** (like Cursor's). Pick a project and everything you ask is scoped to it — *"launch the high-priority ones"* resolves against that project. Leave it on **Home** and the agent works across your whole setup: it can list or create projects and answer questions that span everything. If you ask something project-specific while on Home, it will ask you which project (or offer to create one) rather than guess.

Picking a project here **does not** move your dashboard — the agent's target and what you're looking at are independent.

## Provider and model

Just above the message box you choose the **provider** (Claude, Codex or Gemini) and its **model**. Each provider has its own model list, and switching provider starts a fresh session with that provider's default model — so you can, say, drive the app with Claude and switch to Codex for another conversation without anything getting crossed.

## Permission levels — you hold the leash

The agent can touch the whole app, so you decide how much freedom it has with a **level** you change live by pressing **Shift+Tab** (the same cycle Claude Code uses). Each level includes everything below it:

| Level | What it can do |
|---|---|
| 👀 **Observe** | Read only — list and inspect projects, specs, jobs, analytics. Nothing changes. |
| ✍️ **Edit** | The above **+** create and edit (specs, settings, rail config) — reversible changes. |
| ⚡ **Operate** | The above **+** launch AI work that **costs money** (rails, spec generation). |
| 🔥 **Autonomous** | The above **+** delete and stop things — irreversible actions. |

Start on **Observe** and raise the level only when you want the agent to act. If it tries something above the current level it stops and tells you exactly which level to switch on — it never works around the limit. This is separate from the Settings ▸ MCP tiers, which govern *external* assistants; the level here is just for this in-app agent.

## A few things you can ask

Once you're on **Operate**, try:

> *"List every todo spec in the API project, then launch the three highest-priority ones on separate rails and watch them."*
>
> *"How much did I spend this week, broken down by project?"*
>
> *"Create a spec for a dark-mode toggle in the web project, with a Contract Layer."*
>
> *"Something failed in the last batch — find the failed jobs and summarize why."*

Replies stream in smoothly and land formatted (headings, tables, lists), each with a small **copy** button. A status chip at the bottom shows what the agent is doing right now — *Thinking…*, *MCP · jobs*, *Terminal* — so you always know its state.

## Handy touches

- **Super specs from a conversation.** Ask the agent to *shape* a spec with you instead of one-shotting it: it reads the real code first, interviews you briefly, and shows the evolving draft as a live card right in the conversation. On your yes it creates the spec and — by default — enriches it in the background with a **Contract Layer** (exact file paths, data shapes, invariants) so the implementing agents don’t improvise. Say "no contract layer" to skip the enrichment.
- **Click what it mentions.** In a project-pinned mission, spec numbers (`#12`) and job/run ids in the agent's replies are clickable chips — a spec opens the board's detail modal, a job id opens the live job view. If the reference no longer exists you get a quiet "not found" note.
- **The implementation card stays in sight.** When the agent implements specs, a live card tracks the work — and while it needs something from you (create the PR, publish it, retry, discard) it stays **pinned just above the message box**, however far the conversation scrolls; its place in the history shows a slim "pinned above" marker instead. Several active cards stack as small chips (click one to bring it forward), and a chevron minimizes the card to a slim bar. Once the PR is published — or the work is merged or discarded — the card settles back into the conversation history.
- **Prompt history.** With the box empty, press **↑**/**↓** to browse what you asked before (shown dimmed while you scroll); start typing to edit it, or hit Enter to send.
- **Edit the queue.** Sent more while the agent was busy? While messages are queued, **↑**/**↓** moves through *them* instead — the box shows the selected one, you edit it in place, and **Enter saves it back to the queue** (Esc cancels; your unsent draft comes right back).
- **Minimize, don't lose.** Click the ✕ to drop the panel back to the bubble — the conversation keeps running. Reopen and you land at the latest message; nothing is re-typed.
- **New conversation.** The **+** button starts a clean thread; the history lives app-wide, above any single project.
- **Switch missions.** The mission selector next to the project picker lists your conversations newest-first — a pulsing dot marks the ones where the agent is still working, and a small badge counts queued messages. Search appears when the list grows past eight, and the trash icon on each row deletes a mission after a quick inline confirm — even a running one (it warns first, then stops the agent).

## A few things to know

- **Operate and Autonomous cost money** because they run AI. The agent surfaces cost-incurring actions before doing them; keep the level at Observe or Edit if you just want to look and tidy.
- **The agent is app-wide**, not tied to the project you have open — that's why it has its own selector and its history isn't per-project.
- **It's only as capable as the MCP allows.** If a whole area seems off-limits, check that the MCP server is enabled.
