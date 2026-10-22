# Working in an existing project

These features help runs respect a project that already exists: what a spec leaves out, the questions the architect has before planning, which requirements a test actually proves, how to describe old code before changing it, and the rules your team already writes down. Each one needs a specrails-core version that supports it; until then its switch is greyed out with an "update Core" note.

## Out of scope

Every spec can list what it deliberately does **not** change. Quick and Explore fill it in for you; in the spec window it appears as **Out of scope** under the description, one item per line, and you can edit it like any other field. The agents see it with the spec on every launch.

## Architect questions on Jira

In **Settings ▸ Existing-project anchoring**, turn on **Post architect clarifications to Jira**. When a run stops because the architect needs an answer, or goes ahead on assumptions, Specrails posts them as one comment on the linked Jira issue. Reply to that comment in Jira: the reply is added to the spec as a clarification, and the next run of the spec reads it. You can still answer a paused run from the app.

## Requirements demonstrated

When a test names the requirement it proves (`[spec:<capability>/<requirement>]` in its title), the review page shows **Requirements demonstrated X/Y**: which requirements a passing test proves, which do not have one yet, and which the change itself touched. Analytics shows the same per loop. To fail CI when a changed requirement has no test, add `specrails-core pipeline trace --check --tests-passed` after your tests.

The loop library also offers **Drift sweep**, a read-only loop that compares what each spec says with what the code does and lists every contradiction. It changes nothing.

## Baseline on touch

Turn on **Baseline on touch** to make a change that reaches code no spec describes start by describing it: tests of how the code behaves today, proven on the unchanged code, and a short spec of what exists. The review page shows **Spec created where the work passed** with the module, the requirements and the tests, and its cost is shown apart from the change. If those tests fail on the unchanged code, the run stops before editing the module and says so.

## Project rules

**Settings ▸ Project rules** lists the checks your project already runs (lint, type checks, tests, CI) and every rule written in files like `CLAUDE.md` or `AGENTS.md`, sorted into:

- **Enforced**: a check already guarantees it.
- **Automatable**: a check could. **Create spec** turns it into a spec in one click.
- **Human only**: someone has to look. These appear on every review page under **Needs human eyes**.

Rules Core could not classify yet (for example right after adding the project, when the inventory runs offline) are listed as **Unclassified**; **Re-run inventory** with a provider configured classifies them.

**Re-run inventory** refreshes the list. When a project has no verification commands yet, the agent runtime settings offer these checks first.
