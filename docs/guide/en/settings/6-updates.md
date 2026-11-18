# Updates {#updates}

Specrails keeps two things up to date: the **Specrails Desktop** app itself and the **specrails-core** framework your projects use. Both live in **Settings ▸ Updates**.

## Update channel

Pick how quickly you receive new versions:

- **Latest** (default): every release as soon as it ships. You get new features and fixes first.
- **Stable**: only releases that spent at least a week on Latest with green CI and were then promoted by the maintainers. Choose it when your team prefers fewer, well-tested updates.

The channel applies to both the app and specrails-core. If specrails-core has no stable release yet, Core follows Latest and the Core card tells you so.

On Stable, if no release has been promoted yet, **Check for updates** says so instead of offering a Latest build.

## How updates arrive

- **Specrails Desktop** checks at launch and every 6 hours. When an update is available a card appears; download, install and restart from there. You can also click **Check for updates**.
- **specrails-core** never updates on its own. Click **Check for updates** on the Core card, then **Update** to install it. Your projects switch to the new framework without restarting the app.

## Good to know

- Switching from Latest to Stable never downgrades you. You stay on your version until Stable catches up.
- Every update is signed and verified before it installs, on both channels.

## When work is running

The update card checks what a restart would stop. If mission turns or runs are still working it says so and offers:

- **Install when nothing is running**: the card waits and restarts by itself as soon as the last turn or run ends.
- **Restart now**: restart anyway. Interrupted work is offered back after the restart.

## After a restart

When Specrails closes, restarts for an update, or stops unexpectedly while work is running, the next launch shows **Pick up where you left off**: the missions that were mid-turn and the runs the restart paused, each with a checkbox. Nothing resumes on its own. Missions continue in their own session (with a short note that the app restarted); runs use their usual Resume. **Not now** dismisses the list; paused runs stay in the Inbox.
