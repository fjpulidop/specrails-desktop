# Updates

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
