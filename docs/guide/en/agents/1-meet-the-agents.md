# Meet the agents

When you launch an **Implement** rail, Specrails doesn't hand your spec to a single AI and hope for the best. It runs a small team of specialised *agents*, each with one job, in a deliberate order. This page introduces who's on that team and what each one does.

## The baseline trio

Every pipeline run uses these three agents — they're the backbone, and a project can't run a rail without them.

| Agent | Role | What it does |
|-------|------|--------------|
| **sr-architect** | The planner | Reads your spec, inspects the codebase, and produces a concrete implementation plan — which files to touch, what shape the change takes, what to watch out for. It thinks before anyone writes code. |
| **sr-developer** | The builder | Takes the architect's plan and actually writes the code: new files, edits, tests. This is where your spec turns into a real diff. |
| **sr-reviewer** | The critic | Validates the developer's work against the spec and the plan, catches regressions, and pushes back when something's off. It's the quality gate before the change is considered done. |

Think of it as **design → build → review**, the same loop a careful human team would follow. Each agent hands its output to the next, so the developer never works blind and the reviewer always has the original intent to check against.

## Specialist agents

Beyond the trio, a project can include optional **specialist agents** that handle specific kinds of work. The most common one you'll see is:

- **sr-merge-resolver** — a utility agent that helps untangle merge conflicts and reconcile overlapping changes. It's optional: profiles include it only when you want it, and it never blocks the pipeline if it's absent.

Specialists are opt-in. A fresh project runs with just the trio; you add specialists (and your own **custom agents** — see [Custom agents & the catalog](custom-agents-catalog)) when a project's workflow calls for them.

## How tasks reach the right agent

Within a run, work is *routed*. A task carries tags, and a profile's routing rules send tagged tasks to the agent best suited for them — with a final catch-all rule that sends everything else to the developer. You don't have to think about this for normal use; the default setup routes everything sensibly out of the box. When you're ready to direct specific kinds of work to specific agents, see [Customizing models per agent](customizing-models-per-agent).

## One important idea, up front

The *definition* of each agent — its instructions, its personality, what it's allowed to do — is **shared**. These live as files (`.claude/agents/<id>.md`) that travel with your repository, so your whole team runs the same architect, the same reviewer.

What's **per-project** is the *configuration* on top: which model each agent runs with, and which combination of agents you pick for a given rail. That's what profiles are for — and that's the next page.

## Where to go next

- [Profiles & the balanced default](profiles-and-the-balanced-default) — how the team's setup is packaged and selected.
- [Customizing models per agent](customizing-models-per-agent) — tune cost and quality.
